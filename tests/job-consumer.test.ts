// Consumer durability. Delivery is at-least-once, so these prove the handler is
// safe under a duplicate delivery, a parallel delivery, a crashed worker whose
// lease expired, a crash between the classification insert and settlement, and
// a job parked for a missing provider that must have a real resume path.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createFixturePort } from "../src/server/classification/fixture";
import type { ClassificationPort } from "../src/server/classification/classify";
import { CommandCodeError } from "../src/server/classification/commandcode";
import type { GmailMessage } from "../src/server/gmail/normalize";
import { handleClassify, type ClassifyDeps } from "../src/server/jobs/classify";
import { handleJob, type JobOverrides } from "../src/server/jobs/consumer";
import { publishPending } from "../src/db/outbox";
import type { Env } from "../src/runtime/env";
import { textMessage } from "./fixtures/gmail";
import { applyMigrations, seedAccount } from "./helpers/migrations";

const db = (env as unknown as { DB: D1Database }).DB;
const testEnv = { DB: db } as unknown as Env;
const ACCOUNT = "a1";

class FakeQueue {
  readonly sent: unknown[] = [];
  async send(body: unknown): Promise<void> {
    this.sent.push(body);
  }
}

interface BatchLog {
  acked: unknown[];
  retried: unknown[];
}

function fakeBatch(
  bodies: unknown[],
  log: BatchLog = { acked: [], retried: [] },
): MessageBatch<unknown> {
  const messages = bodies.map((body) => ({
    body,
    id: "msg",
    timestamp: new Date(),
    attempts: 1,
    ack() {
      log.acked.push(body);
    },
    retry() {
      log.retried.push(body);
    },
  }));
  return { messages, queue: "queue", ackAll() {}, retryAll() {} } as unknown as MessageBatch<unknown>;
}

async function insertMessage(revision = 0): Promise<void> {
  await db
    .prepare(
      "INSERT INTO messages (id, account_id, gmail_message_id, gmail_thread_id, sender, subject, received_at, label_ids, history_id, is_unread, is_starred, revision, updated_at) VALUES ('m1', ?, 'm1', 't1', 'a@example.com', 'Your order receipt', 1757000000000, '[\"INBOX\"]', 'h', 0, 0, ?, 0)",
    )
    .bind(ACCOUNT, revision)
    .run();
}

async function insertClassifyJob(
  jobId: string,
  state = "ready",
  lease: { token: string | null; expires: number | null } = { token: null, expires: null },
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO jobs (id, account_id, payload, dedupe_key, state, attempts, available_at, lease_token, lease_expires_at, created_at) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, 0)",
    )
    .bind(
      jobId,
      ACCOUNT,
      JSON.stringify({ kind: "classify", messageId: "m1", expectedMessageRevision: 0 }),
      `${ACCOUNT}:classify:m1`,
      state,
      lease.token,
      lease.expires,
    )
    .run();
}

async function insertOutbox(jobId: string, state = "published"): Promise<void> {
  await db
    .prepare(
      "INSERT INTO outbox (id, job_id, state, attempts, available_at) VALUES (?, ?, ?, 1, 0)",
    )
    .bind(jobId, jobId, state)
    .run();
}

/** Classify deps over the fixture provider, counting the two costly calls. */
function countingDeps(): { deps: ClassifyDeps; calls: { fetch: number; classify: number } } {
  const calls = { fetch: 0, classify: 0 };
  const { message, headers } = textMessage({
    id: "m1",
    from: "billing@shop.example",
    subject: "Your order receipt",
    body: "Thanks for your purchase. Your invoice is ready.",
  });
  const withHeaders = {
    ...message,
    payload: { ...(message.payload ?? {}), headers },
  } as GmailMessage;
  const fixture = createFixturePort();
  const port: ClassificationPort = {
    async classify(normalized) {
      calls.classify += 1;
      return fixture.classify(normalized);
    },
  };
  const deps: ClassifyDeps = {
    db,
    accountId: ACCOUNT,
    port,
    fetchMessage: async () => {
      calls.fetch += 1;
      return withHeaders;
    },
  };
  return { deps, calls };
}

async function classificationCount(): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM classifications").first<{ n: number }>();
  return row?.n ?? 0;
}

describe("handleJob durability", () => {
  beforeEach(async () => {
    await applyMigrations(db);
    await seedAccount(db);
  });

  it("processes a duplicated delivery once, with no second fetch or provider call", async () => {
    await insertMessage();
    await insertClassifyJob("j1");
    const { deps, calls } = countingDeps();
    const overrides: JobOverrides = { classifyDeps: async () => deps };

    const first = await handleJob(fakeBatch([{ version: 1, jobId: "j1" }]), testEnv, overrides);
    const second = await handleJob(fakeBatch([{ version: 1, jobId: "j1" }]), testEnv, overrides);

    expect(first[0]).toMatchObject({ kind: "classify", outcome: "succeeded" });
    expect(second[0]).toMatchObject({ outcome: "ignored" });
    expect(calls.fetch).toBe(1);
    expect(calls.classify).toBe(1);
    expect(await classificationCount()).toBe(1);
  });

  it("does not touch Gmail or the provider while another worker holds the lease", async () => {
    await insertMessage();
    await insertClassifyJob("j2", "leased", { token: "other", expires: Date.now() + 60_000 });
    const { deps, calls } = countingDeps();
    const log: { acked: unknown[]; retried: unknown[] } = { acked: [], retried: [] };

    const results = await handleJob(fakeBatch([{ version: 1, jobId: "j2" }], log), testEnv, {
      classifyDeps: async () => deps,
    });

    // Losing the claim is surfaced for redelivery, not acked: acked-and-forgotten
    // would strand the job if the lease holder then died.
    expect(results[0]).toMatchObject({ outcome: "retrying", retry: true });
    expect(log.retried).toHaveLength(1);
    expect(log.acked).toHaveLength(0);
    expect(calls.fetch).toBe(0);
    expect(calls.classify).toBe(0);
    const job = await db
      .prepare("SELECT state, lease_token FROM jobs WHERE id = 'j2'")
      .first<{ state: string; lease_token: string | null }>();
    expect(job?.state).toBe("leased");
    expect(job?.lease_token).toBe("other");
  });

  it("recovers a job whose duplicate arrived during a live lease and then the winner died", async () => {
    await insertMessage();
    // The winner holds a live lease; its outbox row is already published.
    await insertClassifyJob("j7", "leased", { token: "winner", expires: Date.now() + 60_000 });
    await insertOutbox("j7", "published");

    // A duplicate delivery arrives while the lease is live. It must not ack and
    // forget: it is surfaced for redelivery.
    const log: { acked: unknown[]; retried: unknown[] } = { acked: [], retried: [] };
    const duplicate = await handleJob(fakeBatch([{ version: 1, jobId: "j7" }], log), testEnv, {
      classifyDeps: async () => countingDeps().deps,
    });
    expect(duplicate[0]).toMatchObject({ outcome: "retrying", retry: true });
    expect(log.retried).toHaveLength(1);
    // The outbox is NOT re-armed: nothing further publishes this job.
    const outboxRow = await db
      .prepare("SELECT state FROM outbox WHERE id = 'j7'")
      .first<{ state: string }>();
    expect(outboxRow?.state).toBe("published");

    // The winner dies: the lease expires, the outbox stays published, and no
    // sweep re-publishes it. The redelivered duplicate must still finish the job.
    await db
      .prepare("UPDATE jobs SET lease_expires_at = ? WHERE id = 'j7'")
      .bind(Date.now() - 1000)
      .run();
    const { deps, calls } = countingDeps();
    const recovered = await handleJob(fakeBatch([{ version: 1, jobId: "j7" }]), testEnv, {
      classifyDeps: async () => deps,
    });
    expect(recovered[0]).toMatchObject({ outcome: "succeeded" });
    expect(calls.classify).toBe(1);
    expect(await classificationCount()).toBe(1);
    const job = await db.prepare("SELECT state FROM jobs WHERE id = 'j7'").first<{ state: string }>();
    expect(job?.state).toBe("succeeded");
  });

  it("keeps a transient AI error retryable without storing a suppressing row", async () => {
    await insertMessage();
    await insertClassifyJob("j8");
    const fixture = createFixturePort();
    let down = true;
    const flaky: ClassificationPort = {
      async classify(normalized) {
        if (down) throw new Error("ai down");
        return fixture.classify(normalized);
      },
    };
    const overrides: JobOverrides = {
      classifyDeps: async () => ({ ...countingDeps().deps, port: flaky }),
    };

    const first = await handleJob(fakeBatch([{ version: 1, jobId: "j8" }]), testEnv, overrides);
    expect(first[0]).toMatchObject({ outcome: "retrying", retry: true });
    // No suppressing row: a later success must not be skipped as "already stored".
    expect(await classificationCount()).toBe(0);
    const parked = await db.prepare("SELECT state FROM jobs WHERE id = 'j8'").first<{ state: string }>();
    expect(parked?.state).toBe("ready");

    down = false;
    const second = await handleJob(fakeBatch([{ version: 1, jobId: "j8" }]), testEnv, overrides);
    expect(second[0]).toMatchObject({ outcome: "succeeded" });
    expect(await classificationCount()).toBe(1);
  });

  it("releases the lease when dependency construction throws after the claim", async () => {
    await insertMessage();
    await insertClassifyJob("j9");
    const { deps } = countingDeps();
    let attempts = 0;
    // The builder rejects once (an OAuth refresh failure) then succeeds, so the
    // redelivery can prove the failure released the lease rather than leaking it.
    const overrides: JobOverrides = {
      classifyDeps: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("oauth refresh failed");
        return deps;
      },
    };

    const log: { acked: unknown[]; retried: unknown[] } = { acked: [], retried: [] };
    const first = await handleJob(fakeBatch([{ version: 1, jobId: "j9" }], log), testEnv, overrides);

    // A throw after the claim is surfaced for redelivery, not acked.
    expect(first[0]).toMatchObject({ retry: true });
    expect(log.retried).toHaveLength(1);
    expect(log.acked).toHaveLength(0);

    // The lease is released, so the retry reclaims it at once instead of waiting
    // out the 120s window while the outbox row sits published.
    const afterFailure = await db
      .prepare("SELECT state, lease_token FROM jobs WHERE id = 'j9'")
      .first<{ state: string; lease_token: string | null }>();
    expect(afterFailure?.state).toBe("ready");
    expect(afterFailure?.lease_token).toBeNull();

    const second = await handleJob(fakeBatch([{ version: 1, jobId: "j9" }]), testEnv, overrides);
    expect(second[0]).toMatchObject({ outcome: "succeeded" });
    expect(attempts).toBe(2);
    expect(await classificationCount()).toBe(1);
  });

  it("reclaims an expired lease and processes the job", async () => {
    await insertMessage();
    await insertClassifyJob("j3", "leased", { token: "stale", expires: Date.now() - 1000 });
    const { deps, calls } = countingDeps();

    const results = await handleJob(fakeBatch([{ version: 1, jobId: "j3" }]), testEnv, {
      classifyDeps: async () => deps,
    });

    expect(results[0]).toMatchObject({ outcome: "succeeded" });
    expect(calls.classify).toBe(1);
    expect(await classificationCount()).toBe(1);
    const job = await db
      .prepare("SELECT state, lease_token FROM jobs WHERE id = 'j3'")
      .first<{ state: string; lease_token: string | null }>();
    expect(job?.state).toBe("succeeded");
    expect(job?.lease_token).toBeNull();
  });

  it("does not duplicate when a worker crashed after the classification insert", async () => {
    await insertMessage();
    // A worker claimed j4, stored the classification, then died before settling.
    await insertClassifyJob("j4", "leased", { token: "crashed", expires: Date.now() - 1000 });
    const crashed = await handleClassify(countingDeps().deps, "m1", 0, {
      jobId: "j4",
      leaseToken: "crashed",
    });
    expect(crashed.status).toBe("stored");
    expect(await classificationCount()).toBe(1);

    // The reclaim must reuse the stored row and skip the provider entirely.
    const { deps, calls } = countingDeps();
    const results = await handleJob(fakeBatch([{ version: 1, jobId: "j4" }]), testEnv, {
      classifyDeps: async () => deps,
    });

    expect(results[0]).toMatchObject({ outcome: "succeeded" });
    expect(calls.classify).toBe(0);
    expect(await classificationCount()).toBe(1);
    const job = await db.prepare("SELECT state FROM jobs WHERE id = 'j4'").first<{ state: string }>();
    expect(job?.state).toBe("succeeded");
  });

  it("parks a job for a missing provider with a resume path, not a silent ack", async () => {
    await insertMessage();
    await insertClassifyJob("j5");
    await insertOutbox("j5", "published");

    const blocked = await handleJob(fakeBatch([{ version: 1, jobId: "j5" }]), testEnv, {
      classifyDeps: async () => null,
    });
    expect(blocked[0]).toMatchObject({ outcome: "blocked_auth" });

    const parked = await db
      .prepare("SELECT state, lease_token FROM jobs WHERE id = 'j5'")
      .first<{ state: string; lease_token: string | null }>();
    expect(parked?.state).toBe("blocked_auth");
    expect(parked?.lease_token).toBeNull();
    // Its outbox row is re-armed so a later sweep re-delivers it.
    const outboxRow = await db
      .prepare("SELECT state FROM outbox WHERE id = 'j5'")
      .first<{ state: string }>();
    expect(outboxRow?.state).toBe("pending");

    // Once the backoff elapses the row re-publishes and the job resumes.
    await db.prepare("UPDATE jobs SET available_at = 0 WHERE id = 'j5'").run();
    await db.prepare("UPDATE outbox SET available_at = 0 WHERE id = 'j5'").run();
    const queue = new FakeQueue();
    const receipt = await publishPending(db, queue as unknown as Queue<unknown>, 10);
    expect(receipt.published).toBe(1);

    const { deps, calls } = countingDeps();
    const resumed = await handleJob(fakeBatch(queue.sent), testEnv, {
      classifyDeps: async () => deps,
    });
    expect(resumed[0]).toMatchObject({ outcome: "succeeded" });
    expect(calls.classify).toBe(1);
    expect(await classificationCount()).toBe(1);
  });

  it("parks a job on a provider auth failure instead of retrying to death", async () => {
    await insertMessage();
    await insertClassifyJob("j10");
    await insertOutbox("j10", "published");

    // A bad key or wrong plan keeps failing on every retry, so it must park the
    // job as an auth problem, exactly like an unconfigured provider.
    const authPort: ClassificationPort = {
      async classify() {
        throw new CommandCodeError("auth", 401, "Command Code returned HTTP 401");
      },
    };
    const blocked = await handleJob(fakeBatch([{ version: 1, jobId: "j10" }]), testEnv, {
      classifyDeps: async () => ({ ...countingDeps().deps, port: authPort }),
    });
    expect(blocked[0]).toMatchObject({ outcome: "blocked_auth" });
    // Nothing was stored for the failed call.
    expect(await classificationCount()).toBe(0);
    const parked = await db
      .prepare("SELECT state, lease_token FROM jobs WHERE id = 'j10'")
      .first<{ state: string; lease_token: string | null }>();
    expect(parked?.state).toBe("blocked_auth");
    expect(parked?.lease_token).toBeNull();
    // Its outbox row is re-armed, so a fixed key resumes the job.
    const outboxRow = await db
      .prepare("SELECT state FROM outbox WHERE id = 'j10'")
      .first<{ state: string }>();
    expect(outboxRow?.state).toBe("pending");
  });

  it("does not park the job or re-arm the outbox when another worker reclaimed the lease", async () => {
    await insertMessage();
    await insertClassifyJob("j11");
    await insertOutbox("j11", "published");

    // The provider call simulates the lease being reclaimed by another worker
    // before this worker's auth failure resolves. Its token is no longer ours.
    const reclaimed: ClassificationPort = {
      async classify() {
        await db
          .prepare(
            "UPDATE jobs SET state = 'leased', lease_token = 'winner', lease_expires_at = ? WHERE id = 'j11'",
          )
          .bind(Date.now() + 60_000)
          .run();
        throw new CommandCodeError("auth", 401, "Command Code returned HTTP 401");
      },
    };

    const blocked = await handleJob(fakeBatch([{ version: 1, jobId: "j11" }]), testEnv, {
      classifyDeps: async () => ({ ...countingDeps().deps, port: reclaimed }),
    });
    expect(blocked[0]).toMatchObject({ outcome: "blocked_auth" });

    // The stale worker must not park a job another worker now owns: the fenced
    // UPDATE is a no-op and the job keeps the reclaimer's token.
    const job = await db
      .prepare("SELECT state, lease_token FROM jobs WHERE id = 'j11'")
      .first<{ state: string; lease_token: string | null }>();
    expect(job?.state).toBe("leased");
    expect(job?.lease_token).toBe("winner");

    // Nor may it re-arm the outbox row, which could clear a live publisher's
    // lease or republish an already-completed job.
    const outboxRow = await db
      .prepare("SELECT state FROM outbox WHERE id = 'j11'")
      .first<{ state: string }>();
    expect(outboxRow?.state).toBe("published");
  });
});
