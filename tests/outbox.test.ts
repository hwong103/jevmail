// Transactional outbox behaviour against a real SQLite database, so the
// rollback and recovery claims are exercised rather than asserted in prose.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  dedupeKeyFor,
  envelopeFor,
  publishPending,
  type JobSpec,
  type MessageUpsert,
} from "../src/db/outbox";

class FakeQueue {
  readonly sent: unknown[] = [];
  async send(body: unknown): Promise<void> {
    this.sent.push(body);
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_expires_at INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_dedupe_idx ON jobs (account_id, dedupe_key);
CREATE INDEX IF NOT EXISTS jobs_state_available_idx ON jobs (state, available_at);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs (id),
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_expires_at INTEGER,
  published_at INTEGER
);
CREATE INDEX IF NOT EXISTS outbox_state_available_idx ON outbox (state, available_at);
`;

async function freshDb(): Promise<D1Database> {
  // The pool gives each test its own isolated D1, so this only needs the
  // schema. The worker Env interface models the queue binding as required while
  // the test Env omits it, hence the defensive read.
  const d1 = (env as unknown as { DB: D1Database }).DB;
  const statements = SCHEMA.split(";").map((s) => s.trim()).filter(Boolean);
  for (const statement of statements) {
    await d1.prepare(statement).run();
  }
  return d1;
}

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

// The pool isolates storage per test file, not per test, so every test starts
// from a clean schema rather than relying on isolation that is not guaranteed.
async function resetSchema(db: D1Database): Promise<void> {
  for (const table of ["outbox", "jobs", "sync_checkpoints"]) {
    await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  }
  for (const statement of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) {
    await db.prepare(statement).run();
  }
}

async function commitPage(
  db: D1Database,
  input: { accountId: string; historyId: string; jobs: JobSpec[]; jobIds?: string[]; failAfterJobs?: boolean },
): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  input.jobs.forEach((spec, index) => {
    const jobId = input.jobIds?.[index] ?? nextId("job");
    statements.push(
      db
        .prepare(
          "INSERT INTO jobs (id, account_id, payload, dedupe_key, state, attempts, available_at, created_at) VALUES (?, ?, ?, ?, 'ready', 0, ?, ?)",
        )
        .bind(jobId, input.accountId, JSON.stringify(spec.payload), spec.dedupeKey, spec.availableAt ?? 0, Date.now()),
    );
    statements.push(
      db
        .prepare(
          "INSERT INTO outbox (id, job_id, state, attempts, available_at) VALUES (?, ?, 'pending', 0, ?)",
        )
        .bind(`${jobId}-out`, jobId, spec.availableAt ?? 0),
    );
  });
  statements.push(
    db
      .prepare("UPDATE sync_checkpoints SET committed_history_id = ? WHERE account_id = ?")
      .bind(input.historyId, input.accountId),
  );

  await db.batch(statements);
  if (input.failAfterJobs) throw new Error("simulated crash after commit, before publish");
}

describe("transactional outbox", () => {
  let db: D1Database;

  beforeEach(async () => {
    db = await freshDb();
    await resetSchema(db);
    await db
      .prepare("CREATE TABLE IF NOT EXISTS sync_checkpoints (account_id TEXT PRIMARY KEY, committed_history_id TEXT)")
      .run();
    await db
      .prepare("INSERT OR REPLACE INTO sync_checkpoints (account_id, committed_history_id) VALUES ('a1', 'h0')")
      .run();
  });

  it("advances the cursor and enqueues jobs in one batch", async () => {
    await commitPage(db, {
      accountId: "a1",
      historyId: "h1",
      jobs: [{ payload: { kind: "classify", messageId: "m1", expectedMessageRevision: 0 }, dedupeKey: "a1:1" }],
    });
    const checkpoint = await db
      .prepare("SELECT committed_history_id FROM sync_checkpoints WHERE account_id = 'a1'")
      .first<{ committed_history_id: string }>();
    const jobCount = await db.prepare("SELECT COUNT(*) AS n FROM jobs").first<{ n: number }>();
    expect(checkpoint?.committed_history_id).toBe("h1");
    expect(jobCount?.n).toBe(1);
  });

  it("a crash after commit still leaves the work recoverable from the outbox", async () => {
    await expect(
      commitPage(db, {
        accountId: "a1",
        historyId: "h2",
        jobs: [{ payload: { kind: "classify", messageId: "m2", expectedMessageRevision: 0 }, dedupeKey: "a1:2" }],
        failAfterJobs: true,
      }),
    ).rejects.toThrow(/simulated crash/);

    const pending = await db
      .prepare("SELECT COUNT(*) AS n FROM outbox WHERE state = 'pending'")
      .first<{ n: number }>();
    expect(pending?.n).toBe(1);
  });

  it("a failed batch leaves neither cursor advancement nor jobs", async () => {
    // A genuine constraint violation: the first job already exists with this
    // id, so the insert cannot succeed.
    await commitPage(db, {
      accountId: "a1",
      historyId: "h9",
      jobs: [{ payload: { kind: "sync", checkpointVersion: 9 }, dedupeKey: "a1:seed" }],
      jobIds: ["job-seed"],
    });
    const bad = db.prepare(
      "INSERT INTO jobs (id, account_id, payload, dedupe_key, state, attempts, available_at, created_at) VALUES ('job-seed', 'a1', '{}', 'k2', 'ready', 0, 0, 0)",
    );
    const cursor = db
      .prepare("UPDATE sync_checkpoints SET committed_history_id = 'h10' WHERE account_id = 'a1'");
    await expect(db.batch([bad, cursor])).rejects.toThrow();

    const checkpoint = await db
      .prepare("SELECT committed_history_id FROM sync_checkpoints WHERE account_id = 'a1'")
      .first<{ committed_history_id: string }>();
    const jobCount = await db.prepare("SELECT COUNT(*) AS n FROM jobs").first<{ n: number }>();
    expect(checkpoint?.committed_history_id).toBe("h9");
    expect(jobCount?.n).toBe(1);
  });

  it("duplicate job keys are rejected by the unique index", async () => {
    const spec = { payload: { kind: "sync" as const, checkpointVersion: 1 }, dedupeKey: "a1:sync:1" };
    await commitPage(db, { accountId: "a1", historyId: "h4", jobs: [spec] });
    // The same dedupe key cannot be enqueued twice. The second insert violates
    // jobs_dedupe_idx, so the whole batch (cursor included) must roll back.
    await expect(
      commitPage(db, {
        accountId: "a1",
        historyId: "h5",
        jobs: [spec],
        jobIds: [nextId("job")],
      }),
    ).rejects.toThrow();
    const checkpoint = await db
      .prepare("SELECT committed_history_id FROM sync_checkpoints WHERE account_id = 'a1'")
      .first<{ committed_history_id: string }>();
    expect(checkpoint?.committed_history_id).toBe("h4");
  });
});

describe("envelope and dedupe", () => {
  it("carries an id and nothing else", () => {
    expect(envelopeFor("job-1")).toEqual({ version: 1, jobId: "job-1" });
  });

  it("includes the expected message revision so unchanged input is not reclassified", () => {
    const first = dedupeKeyFor("a1", { kind: "classify", messageId: "m1", expectedMessageRevision: 0 });
    const second = dedupeKeyFor("a1", { kind: "classify", messageId: "m1", expectedMessageRevision: 1 });
    expect(first).not.toBe(second);
  });
});

describe("publishPending lease recovery", () => {
  let db: D1Database;

  beforeEach(async () => {
    db = await freshDb();
    await resetSchema(db);
    await db
      .prepare(
        "INSERT INTO jobs (id, account_id, payload, dedupe_key, state, attempts, available_at, created_at) VALUES ('j1', 'a1', '{}', 'a1:k', 'ready', 0, 0, 0)",
      )
      .run();
  });

  it("reclaims a row stranded in publishing once its lease expires", async () => {
    // A publisher crashed after claiming (pending -> publishing) but before the
    // send, leaving a lease that has since expired.
    await db
      .prepare(
        "INSERT INTO outbox (id, job_id, state, attempts, available_at, lease_token, lease_expires_at) VALUES ('o1', 'j1', 'publishing', 1, 0, 'dead-lease', 1000)",
      )
      .run();
    const queue = new FakeQueue();

    const receipt = await publishPending(db, queue as unknown as Queue<unknown>, 10, 5000);

    expect(receipt.published).toBe(1);
    expect(receipt.failed).toBe(0);
    expect(queue.sent).toEqual([{ version: 1, jobId: "j1" }]);
    const row = await db
      .prepare("SELECT state, lease_token, published_at FROM outbox WHERE id = 'o1'")
      .first<{ state: string; lease_token: string | null; published_at: number | null }>();
    expect(row?.state).toBe("published");
    expect(row?.lease_token).toBeNull();
    expect(row?.published_at).not.toBeNull();
  });

  it("does not steal a publishing row whose lease is still live", async () => {
    await db
      .prepare(
        "INSERT INTO outbox (id, job_id, state, attempts, available_at, lease_token, lease_expires_at) VALUES ('o2', 'j1', 'publishing', 1, 0, 'live-lease', 100000)",
      )
      .run();
    const queue = new FakeQueue();

    const receipt = await publishPending(db, queue as unknown as Queue<unknown>, 10, 5000);

    expect(receipt.published).toBe(0);
    expect(queue.sent).toEqual([]);
    const row = await db
      .prepare("SELECT state, lease_token FROM outbox WHERE id = 'o2'")
      .first<{ state: string; lease_token: string | null }>();
    expect(row?.state).toBe("publishing");
    expect(row?.lease_token).toBe("live-lease");
  });
});
