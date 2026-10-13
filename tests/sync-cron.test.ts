// The cron vertical: runSync loads the account, polls history, commits pages,
// and publishes the queued work - all without touching live Google.
//
// The seams under test are the ones the brief names: a seeded account advances
// the cursor and enqueues; no account is a no-op; a crash after commit but
// before publish is recovered by publishPending; a duplicate publish sends
// nothing; and sender/subject land in D1 from the metadata headers.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { commitSyncPage, dedupeKeyFor, publishPending } from "../src/db/outbox";
import { GmailApiError, type GmailAdapter } from "../src/server/gmail/client";
import {
  MAX_FETCHES,
  MAX_PAGES,
  RESERVED_REQUESTS,
  runSync,
  scheduledSync,
} from "../src/server/sync/cron";
import type { Env } from "../src/runtime/env";
import { applyMigrations, seedAccount } from "./helpers/migrations";

const db = (env as unknown as { DB: D1Database }).DB;
const ACCOUNT = "a1";

interface HistoryPage {
  history: { id: string; messages?: string[] }[];
  historyId: string | null;
  nextPageToken: string | null;
}

class FakeGmail implements GmailAdapter {
  private pages: HistoryPage[];
  /** Gmail page tokens seen, in call order, so resume is provable. */
  readonly pageTokens: (string | null)[] = [];
  /** Message ids whose metadata was requested, in call order (404s included). */
  readonly fetched: string[] = [];
  /** Message ids whose metadata fetch should throw, simulating a transient fault. */
  readonly fetchErrors = new Map<string, Error>();
  constructor(
    pages: HistoryPage[],
    private readonly email = "a@example.com",
  ) {
    this.pages = [...pages];
  }

  async profile() {
    return { emailAddress: this.email, historyId: "h0" };
  }

  async listHistory(
    _startHistoryId: string | null,
    options: { maxResults: number; pageToken?: string | null },
  ) {
    this.pageTokens.push(options.pageToken ?? null);
    const next = this.pages.shift();
    if (next) return next;
    return { history: [], historyId: null, nextPageToken: null };
  }

  async getMessage(id: string) {
    this.fetched.push(id);
    const failure = this.fetchErrors.get(id);
    if (failure) throw failure;
    return {
      message: {
        id,
        threadId: `t-${id}`,
        internalDate: "1757000000000",
        labelIds: ["INBOX", "UNREAD"],
      },
      headers: [
        { name: "From", value: `Sender ${id} <${id}@example.com>` },
        { name: "Subject", value: `Subject ${id}` },
      ],
    };
  }
}

class FakeQueue {
  readonly sent: unknown[] = [];
  async send(body: unknown): Promise<void> {
    this.sent.push(body);
  }
  async sendBatch(messages: Iterable<{ body: unknown }>): Promise<void> {
    for (const m of messages) this.sent.push(m.body);
  }
}

function fakeEnv(): Env {
  return { DB: db } as unknown as Env;
}

function fakeQueue(): Queue<unknown> {
  return new FakeQueue() as unknown as Queue<unknown>;
}

async function seedCheckpoint(historyId: string | null): Promise<void> {
  await db
    .prepare(
      "INSERT INTO sync_checkpoints (account_id, version, mode, committed_history_id, page_token, scan_id, updated_at) VALUES (?, 0, 'incremental', ?, NULL, NULL, ?) ON CONFLICT (account_id) DO UPDATE SET committed_history_id = excluded.committed_history_id",
    )
    .bind(ACCOUNT, historyId, Date.now())
    .run();
}

async function readCursor(): Promise<string | null> {
  const row = await db
    .prepare("SELECT committed_history_id FROM sync_checkpoints WHERE account_id = ?")
    .bind(ACCOUNT)
    .first<{ committed_history_id: string | null }>();
  return row?.committed_history_id ?? null;
}

describe("runSync", () => {
  beforeEach(async () => {
    await applyMigrations(db);
    await seedAccount(db);
    await seedCheckpoint("h0");
  });

  it("advances the cursor and publishes the enqueued work for a connected account", async () => {
    const gmail = new FakeGmail([
      { history: [{ id: "h1", messages: ["m1"] }], historyId: "h1", nextPageToken: null },
    ]);
    const queue = fakeQueue();

    const result = await runSync(fakeEnv(), { adapterFor: async () => gmail, queue });

    expect(result.status).toBe("ran");
    expect(result.messages).toBe(1);
    expect(result.published).toBe(1);
    expect(await readCursor()).toBe("h1");

    const job = await db
      .prepare("SELECT id FROM jobs WHERE account_id = ?")
      .bind(ACCOUNT)
      .first<{ id: string }>();
    expect(job).not.toBeNull();
    // ID-only envelope: the queue learns the job id and nothing else.
    expect((queue as unknown as FakeQueue).sent).toEqual([
      { version: 1, jobId: job?.id },
    ]);

    const pending = await db
      .prepare("SELECT COUNT(*) AS n FROM outbox WHERE state != 'published'")
      .first<{ n: number }>();
    expect(pending?.n).toBe(0);
  });

  it("persists real sender and subject from the metadata headers", async () => {
    const gmail = new FakeGmail([
      { history: [{ id: "h1", messages: ["m1"] }], historyId: "h1", nextPageToken: null },
    ]);
    await runSync(fakeEnv(), { adapterFor: async () => gmail, queue: fakeQueue() });

    const row = await db
      .prepare("SELECT sender, subject FROM messages WHERE account_id = ? AND gmail_message_id = ?")
      .bind(ACCOUNT, "m1")
      .first<{ sender: string; subject: string }>();
    expect(row?.sender).toBe("Sender m1 <m1@example.com>");
    expect(row?.subject).toBe("Subject m1");
  });

  it("is a no-op when no mailbox is connected", async () => {
    await applyMigrations(db); // empty: no account row
    const result = await runSync(fakeEnv(), {
      adapterFor: async () => new FakeGmail([]),
      queue: fakeQueue(),
    });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("no_account_connected");
  });

  it("does not advance the cursor and records the failure when a page errors", async () => {
    const gmail = new FakeGmail([]);
    gmail.listHistory = async () => {
      throw new Error("boom");
    };
    const result = await runSync(fakeEnv(), { adapterFor: async () => gmail, queue: fakeQueue() });

    expect(result.status).toBe("error");
    expect(result.errors).toContain("Error");
    // The cursor stays put so the next pass redoes the same page.
    expect(await readCursor()).toBe("h0");
  });

  it("parks the account without polling when the grant opens a different mailbox", async () => {
    const gmail = new FakeGmail([], "someone-else@example.com");
    const result = await runSync(fakeEnv(), { adapterFor: async () => gmail, queue: fakeQueue() });

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("identity_mismatch");
    expect(await readCursor()).toBe("h0");
    const account = await db
      .prepare("SELECT status FROM accounts WHERE id = ?")
      .bind(ACCOUNT)
      .first<{ status: string }>();
    expect(account?.status).toBe("reauth_required");
  });

  it("leaves the outbox pending when no queue is bound, then recovers on the next sweep", async () => {
    const gmail = new FakeGmail([
      { history: [{ id: "h1", messages: ["m1"] }], historyId: "h1", nextPageToken: null },
    ]);
    // No queue: the page commits, then the pass dies before it can publish.
    const result = await runSync(fakeEnv(), { adapterFor: async () => gmail });
    expect(result.status).toBe("ran");

    const pending = await db
      .prepare("SELECT COUNT(*) AS n FROM outbox WHERE state = 'pending'")
      .first<{ n: number }>();
    expect(pending?.n).toBe(1);

    // A later sweep publishes the stranded row.
    const queue = new FakeQueue();
    const receipt = await publishPending(db, queue as unknown as Queue<unknown>, 10);
    expect(receipt.published).toBe(1);
    expect(queue.sent.length).toBe(1);
  });
});

describe("publishPending", () => {
  beforeEach(async () => {
    await applyMigrations(db);
    await seedAccount(db);
    await seedCheckpoint("h0");
  });

  async function commitOnePage(): Promise<void> {
    const gmail = new FakeGmail([
      { history: [{ id: "h1", messages: ["m1", "m2"] }], historyId: "h1", nextPageToken: null },
    ]);
    await runSync(fakeEnv(), { adapterFor: async () => gmail });
  }

  it("is idempotent: a second sweep sends nothing", async () => {
    await commitOnePage();
    const queue = new FakeQueue();
    const first = await publishPending(db, queue as unknown as Queue<unknown>, 10);
    const second = await publishPending(db, queue as unknown as Queue<unknown>, 10);

    expect(first.published).toBe(2);
    expect(second.published).toBe(0);
    expect(queue.sent.length).toBe(2);
    // Every envelope is ID-only.
    for (const envelope of queue.sent) {
      expect(Object.keys(envelope as object).sort()).toEqual(["jobId", "version"]);
    }
  });

  it("does not duplicate outbox rows when the same page is re-committed", async () => {
    const payload = { kind: "classify" as const, messageId: "m1", expectedMessageRevision: 0 };
    const input = {
      accountId: ACCOUNT,
      messages: [],
      jobs: [{ payload, dedupeKey: dedupeKeyFor(ACCOUNT, payload) }],
      checkpoint: { mode: "incremental", historyId: "h1", pageToken: null, scanId: null },
    };
    await commitSyncPage(db, input);
    await commitSyncPage(db, input);

    const jobCount = await db.prepare("SELECT COUNT(*) AS n FROM jobs").first<{ n: number }>();
    const outboxCount = await db.prepare("SELECT COUNT(*) AS n FROM outbox").first<{ n: number }>();
    expect(jobCount?.n).toBe(1);
    expect(outboxCount?.n).toBe(1);
  });
});

describe("runSync correctness under pagination and faults", () => {
  beforeEach(async () => {
    await applyMigrations(db);
    await seedAccount(db);
    await seedCheckpoint("h0");
  });

  async function messageIds(): Promise<string[]> {
    const rows = await db
      .prepare("SELECT gmail_message_id AS id FROM messages WHERE account_id = ? ORDER BY gmail_message_id")
      .bind(ACCOUNT)
      .all<{ id: string }>();
    return rows.results.map((r) => r.id);
  }

  it("resumes page two instead of skipping it when history paginates", async () => {
    const gmail = new FakeGmail([
      { history: [{ id: "h1", messages: ["m1", "m2"] }], historyId: "h1", nextPageToken: "T1" },
      { history: [{ id: "h2", messages: ["m3", "m4"] }], historyId: "h2", nextPageToken: null },
    ]);
    const queue = fakeQueue();

    const result = await runSync(fakeEnv(), { adapterFor: async () => gmail, queue });

    expect(result.status).toBe("ran");
    expect(result.messages).toBe(4);
    expect(result.published).toBe(4);
    // Both pages landed, and the cursor sits at the second page's history id.
    expect(await messageIds()).toEqual(["m1", "m2", "m3", "m4"]);
    expect(await readCursor()).toBe("h2");
    // Page two was reached by the token Gmail returned, not by restarting.
    expect(gmail.pageTokens).toEqual([null, "T1"]);
  });

  it("retains the cursor and surfaces the error when a metadata fetch is transient", async () => {
    const gmail = new FakeGmail([
      { history: [{ id: "h1", messages: ["m1"] }], historyId: "h1", nextPageToken: null },
    ]);
    gmail.fetchErrors.set("m1", new GmailApiError(500, "backendError"));

    const result = await runSync(fakeEnv(), { adapterFor: async () => gmail, queue: fakeQueue() });

    expect(result.status).toBe("error");
    expect(result.errors).toContain("GmailApiError");
    // Nothing committed and the cursor is untouched: the page is redone.
    expect(await messageIds()).toEqual([]);
    expect(await readCursor()).toBe("h0");

    // A later pass with the transient fault cleared completes the same page.
    const retry = await runSync(fakeEnv(), {
      adapterFor: async () =>
        new FakeGmail([
          { history: [{ id: "h1", messages: ["m1"] }], historyId: "h1", nextPageToken: null },
        ]),
      queue: fakeQueue(),
    });
    expect(retry.status).toBe("ran");
    expect(await readCursor()).toBe("h1");
    expect(await messageIds()).toEqual(["m1"]);
  });

  it("stops cleanly at the fetch cap and resumes the remainder on the next pass", async () => {
    // The override is a *request* ceiling; the metadata budget is what is left
    // once the reserved token/profile/history calls are paid for.
    const cap = RESERVED_REQUESTS + 2;
    const gmail = new FakeGmail([
      {
        history: [{ id: "h1", messages: ["m1", "m2", "m3", "m4", "m5"] }],
        historyId: "h1",
        nextPageToken: null,
      },
    ]);

    const first = await runSync(fakeEnv(), { adapterFor: async () => gmail, maxFetches: cap });
    expect(first.status).toBe("ran");
    expect(first.messages).toBe(2);
    // Two metadata requests were attempted, not two pages of them.
    expect(gmail.fetched).toEqual(["m1", "m2"]);
    // Work remains, so the cursor has not advanced past it.
    expect(await readCursor()).toBe("h0");

    const second = await runSync(fakeEnv(), { adapterFor: async () => gmail, maxFetches: cap });
    expect(second.messages).toBe(2);
    expect(gmail.fetched).toEqual(["m1", "m2", "m3", "m4"]);
    expect(await readCursor()).toBe("h0");

    const third = await runSync(fakeEnv(), { adapterFor: async () => gmail, maxFetches: cap });
    expect(third.messages).toBe(1);
    expect(await readCursor()).toBe("h1");

    expect(await messageIds()).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    expect(gmail.fetched).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    // The deferred ids were replayed from the checkpoint; history was listed once.
    expect(gmail.pageTokens).toEqual([null]);
  });

  it("charges the fetch ceiling for vanished (404) messages and resumes cleanly", async () => {
    const gone = new GmailApiError(404, "notFound");
    const gmail = new FakeGmail([
      {
        history: [{ id: "h1", messages: ["m1", "m2", "m3", "m4", "m5"] }],
        historyId: "h1",
        nextPageToken: null,
      },
    ]);
    for (const id of ["m1", "m2", "m3", "m4", "m5"]) gmail.fetchErrors.set(id, gone);

    const cap = RESERVED_REQUESTS + 2;
    const first = await runSync(fakeEnv(), { adapterFor: async () => gmail, maxFetches: cap });

    expect(first.status).toBe("ran");
    // Every attempt 404'd, so nothing was committed...
    expect(first.messages).toBe(0);
    // ...but the two attempts still spent the ceiling: no second page of fetches.
    expect(gmail.fetched).toEqual(["m1", "m2"]);
    // Work remains, so the cursor stays put and the ids are deferred.
    expect(await readCursor()).toBe("h0");

    // A later pass resumes the deferred ids from the checkpoint, not a re-list.
    const healthy = new FakeGmail([]);
    const second = await runSync(fakeEnv(), { adapterFor: async () => healthy });
    expect(second.status).toBe("ran");
    expect(second.messages).toBe(3);
    expect(healthy.fetched).toEqual(["m3", "m4", "m5"]);
    expect(await messageIds()).toEqual(["m3", "m4", "m5"]);
    expect(await readCursor()).toBe("h1");
  });

  it("reserves token, profile, and history headroom inside the request ceiling", async () => {
    // The reservation is the two single calls plus one history.list per page.
    expect(RESERVED_REQUESTS).toBe(MAX_PAGES + 2);
    const allowance = MAX_FETCHES - RESERVED_REQUESTS;

    // One page names two more messages than the metadata budget allows.
    const ids = Array.from({ length: allowance + 2 }, (_, i) => `m${i + 1}`);
    const gmail = new FakeGmail([
      { history: [{ id: "h1", messages: ids }], historyId: "h1", nextPageToken: null },
    ]);

    const first = await runSync(fakeEnv(), { adapterFor: async () => gmail });
    expect(first.status).toBe("ran");
    // Metadata attempts stop at the allowance, leaving the reserved headroom.
    expect(gmail.fetched.length).toBe(allowance);
    // A single history.list plus token/profile stays within the reservation, so
    // the whole pass cannot exceed MAX_FETCHES requests.
    expect(1 + RESERVED_REQUESTS).toBeLessThanOrEqual(MAX_FETCHES);
    expect(await readCursor()).toBe("h0");

    // The two overflow ids are deferred to the next pass and finish there.
    const second = await runSync(fakeEnv(), { adapterFor: async () => new FakeGmail([]) });
    expect(second.messages).toBe(2);
    expect(await readCursor()).toBe("h1");
  });

  it("sweeps pending outbox work even when the adapter fails", async () => {
    // Stage a pending row the way a previous page would have left it.
    const payload = { kind: "classify" as const, messageId: "m1", expectedMessageRevision: 0 };
    await commitSyncPage(db, {
      accountId: ACCOUNT,
      messages: [],
      jobs: [{ payload, dedupeKey: dedupeKeyFor(ACCOUNT, payload) }],
      checkpoint: { mode: "incremental", historyId: "h0", pageToken: null, scanId: null },
    });
    const pendingBefore = await db
      .prepare("SELECT COUNT(*) AS n FROM outbox WHERE state = 'pending'")
      .first<{ n: number }>();
    expect(pendingBefore?.n).toBe(1);

    const queue = fakeQueue();
    const result = await runSync(fakeEnv(), {
      adapterFor: async () => {
        throw new Error("adapter down");
      },
      queue,
    });

    // The sync failed, but the queued work still reached the queue.
    expect(result.status).toBe("error");
    expect(result.published).toBe(1);
    expect((queue as unknown as FakeQueue).sent.length).toBe(1);
    const pendingAfter = await db
      .prepare("SELECT COUNT(*) AS n FROM outbox WHERE state = 'pending'")
      .first<{ n: number }>();
    expect(pendingAfter?.n).toBe(0);
  });

  it("runs the cron entry point without a waitUntil-bearing controller", async () => {
    // A real ScheduledController exposes no waitUntil; the old wrapper called
    // one unconditionally and threw on every scheduled invocation. Here the
    // bare object stands in for that controller: no waitUntil, no throw.
    const result = await scheduledSync({} as unknown as ScheduledController, fakeEnv());
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("sync_not_configured");
  });
});
