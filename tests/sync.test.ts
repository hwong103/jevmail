// Sync poller tests. The behaviours that matter here are the failure paths:
// an expired cursor, a revoked grant, and a commit that fails after the Gmail
// calls have already been made.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { GmailApiError, type GmailAdapter, type RawMessage } from "../src/server/gmail/client";
import { pollOnce } from "../src/server/sync/poll";
import { applyMigrations, seedAccount } from "./helpers/migrations";

const db = (env as unknown as { DB: D1Database }).DB;
const ACCOUNT = "a1";

interface HistoryPage {
  history: { id: string; messages?: string[] }[];
  historyId: string | null;
  nextPageToken: string | null;
}

class FakeGmail implements GmailAdapter {
  pages: HistoryPage[] = [];
  listError: Error | null = null;
  fetchError: Error | null = null;
  calls: string[] = [];

  async profile() {
    return { emailAddress: "a@example.com", historyId: "h0" };
  }

  async listHistory() {
    this.calls.push("listHistory");
    if (this.listError) throw this.listError;
    return this.pages.shift() ?? { history: [], historyId: null, nextPageToken: null };
  }

  async getMessage(id: string) {
    this.calls.push(`getMessage:${id}`);
    if (this.fetchError) throw this.fetchError;
    return {
      message: {
        id,
        threadId: `t-${id}`,
        internalDate: "1757000000000",
        labelIds: ["INBOX", "UNREAD"],
      },
      headers: [],
    };
  }
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

describe("pollOnce", () => {
  let gmail: FakeGmail;

  beforeEach(async () => {
    await applyMigrations(db);
    await seedAccount(db);
    await seedCheckpoint("h0");
    gmail = new FakeGmail();
  });

  it("does nothing without a checkpoint", async () => {
    await db.prepare("DELETE FROM sync_checkpoints WHERE account_id = ?").bind(ACCOUNT).run();
    const result = await pollOnce({ db, gmail, accountId: ACCOUNT });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("no_checkpoint");
    expect(gmail.calls.length).toBe(0);
  });

  it("commits messages, jobs, and the cursor in one transaction", async () => {
    gmail.pages = [
      { history: [{ id: "h1", messages: ["m1", "m2"] }], historyId: "h1", nextPageToken: null },
    ];
    const result = await pollOnce({ db, gmail, accountId: ACCOUNT });

    expect(result.status).toBe("ok");
    expect(result.messagesChanged).toBe(2);
    expect(await readCursor()).toBe("h1");

    const messages = await db.prepare("SELECT COUNT(*) AS n FROM messages").first<{ n: number }>();
    const jobs = await db.prepare("SELECT COUNT(*) AS n FROM jobs").first<{ n: number }>();
    expect(messages?.n).toBe(2);
    expect(jobs?.n).toBe(2);
  });

  it("advances the cursor even when nothing changed", async () => {
    gmail.pages = [{ history: [], historyId: "h9", nextPageToken: null }];
    const result = await pollOnce({ db, gmail, accountId: ACCOUNT });
    expect(result.status).toBe("ok");
    expect(result.messagesChanged).toBe(0);
    expect(await readCursor()).toBe("h9");
  });

  it("does not enqueue a second job for an unchanged message", async () => {
    gmail.pages = [
      { history: [{ id: "h1", messages: ["m1"] }], historyId: "h1", nextPageToken: null },
    ];
    await pollOnce({ db, gmail, accountId: ACCOUNT });
    gmail.pages = [
      { history: [{ id: "h2", messages: ["m1"] }], historyId: "h2", nextPageToken: null },
    ];
    await pollOnce({ db, gmail, accountId: ACCOUNT });

    const jobs = await db.prepare("SELECT COUNT(*) AS n FROM jobs").first<{ n: number }>();
    expect(jobs?.n).toBe(1);
    expect(await readCursor()).toBe("h2");
  });

  it("marks the account for reauth on a revoked grant and keeps the cursor", async () => {
    gmail.listError = new GmailApiError(401, "authError");
    const result = await pollOnce({ db, gmail, accountId: ACCOUNT });

    expect(result.status).toBe("blocked_auth");
    const account = await db
      .prepare("SELECT status FROM accounts WHERE id = ?")
      .bind(ACCOUNT)
      .first<{ status: string }>();
    expect(account?.status).toBe("reauth_required");
    // Decisions and cursor survive so reconnecting does not lose work.
    expect(await readCursor()).toBe("h0");
  });

  it("reports an expired cursor instead of reporting an empty mailbox", async () => {
    gmail.listError = new GmailApiError(404, "historyIdNotFound");
    const result = await pollOnce({ db, gmail, accountId: ACCOUNT });

    expect(result.status).toBe("expired");
    expect(result.reason).toBe("history_id_expired");
    // The cursor is not advanced past work that was never read.
    expect(await readCursor()).toBe("h0");
  });

  it("does not advance the cursor when the commit fails", async () => {
    gmail.pages = [
      { history: [{ id: "h1", messages: ["m1"] }], historyId: "h1", nextPageToken: null },
    ];
    // A real fault, not a mock: a message row that violates the messages
    // primary key. The batch must abort, and the cursor included in that batch
    // must roll back with it.
    await db
      .prepare(
        "INSERT INTO messages (id, account_id, gmail_message_id, gmail_thread_id, sender, subject, received_at, label_ids, history_id, is_unread, is_starred, revision, updated_at) VALUES ('m1', 'a1', 'g-other', 't1', '', '', 0, '[]', '', 0, 0, 0, 0)",
      )
      .run();
    await expect(pollOnce({ db, gmail, accountId: ACCOUNT })).rejects.toThrow();
    expect(await readCursor()).toBe("h0");
  });

  it("treats a message that vanished mid-page as skipped, not a failure", async () => {
    gmail.pages = [
      { history: [{ id: "h1", messages: ["gone"] }], historyId: "h1", nextPageToken: null },
    ];
    gmail.fetchError = new GmailApiError(404, "notFound");
    const result = await pollOnce({ db, gmail, accountId: ACCOUNT });

    expect(result.status).toBe("ok");
    expect(result.messagesChanged).toBe(0);
    expect(await readCursor()).toBe("h1");
  });
});
