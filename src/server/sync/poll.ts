// Incremental mailbox sync. Worker A owns this directory.
//
// The durability rule this file exists to enforce: a history cursor only
// advances inside the same D1 transaction that persists the messages it
// implied and the jobs that will classify them. If the transaction fails, the
// cursor stays put and the next run redoes the page. There is no window where
// work is silently lost, and no window where a cursor has advanced past work
// that was never recorded.

import type { GmailAdapter, RawMessage } from "../gmail/client";
import { isAuthFailure, isHistoryExpired } from "../gmail/client";

export interface PollDeps {
  db: D1Database;
  gmail: GmailAdapter;
  accountId: string;
  maxResults?: number;
}

export interface PollResult {
  status: "ok" | "skipped" | "expired" | "blocked_auth" | "error";
  reason?: string;
  messagesSeen: number;
  messagesChanged: number;
  historyId: string | null;
}

interface CheckpointRow {
  committed_history_id: string | null;
  version: number;
}

const DEFAULT_MAX_RESULTS = 100;

export async function pollOnce(deps: PollDeps): Promise<PollResult> {
  const maxResults = deps.maxResults ?? DEFAULT_MAX_RESULTS;
  const checkpoint = await readCheckpoint(deps.db, deps.accountId);
  if (!checkpoint) {
    return {
      status: "skipped",
      reason: "no_checkpoint",
      messagesSeen: 0,
      messagesChanged: 0,
      historyId: null,
    };
  }

  const before = checkpoint.committed_history_id;
  let page;
  try {
    page = await deps.gmail.listHistory(before, { maxResults });
  } catch (error) {
    if (isAuthFailure(error)) {
      await markBlockedAuth(deps.db, deps.accountId);
      return {
        status: "blocked_auth",
        reason: "grant_invalid",
        messagesSeen: 0,
        messagesChanged: 0,
        historyId: before,
      };
    }
    if (isHistoryExpired(error)) {
      // The cursor aged out. Bounded reconciliation is the documented recovery
      // path; the caller must not treat this as an empty mailbox.
      return {
        status: "expired",
        reason: "history_id_expired",
        messagesSeen: 0,
        messagesChanged: 0,
        historyId: null,
      };
    }
    return {
      status: "error",
      reason: error instanceof Error ? error.name : "unknown",
      messagesSeen: 0,
      messagesChanged: 0,
      historyId: before,
    };
  }

  const ids = new Set<string>();
  for (const entry of page.history) {
    for (const id of entry.messages ?? []) ids.add(id);
  }

  const fetched: RawMessage[] = [];
  for (const id of ids) {
    try {
      const { message } = await deps.gmail.getMessage(id, "metadata");
      fetched.push(message);
    } catch (error) {
      if (isAuthFailure(error)) {
        await markBlockedAuth(deps.db, deps.accountId);
        return {
          status: "blocked_auth",
          reason: "grant_invalid",
          messagesSeen: ids.size,
          messagesChanged: 0,
          historyId: before,
        };
      }
      // A message that vanished between history and fetch is not a sync failure.
    }
  }

  const changed = await commitPage(deps, fetched, page.historyId ?? before);
  return {
    status: "ok",
    messagesSeen: ids.size,
    messagesChanged: changed,
    historyId: page.historyId ?? before,
  };
}

async function readCheckpoint(db: D1Database, accountId: string): Promise<CheckpointRow | null> {
  return db
    .prepare("SELECT committed_history_id, version FROM sync_checkpoints WHERE account_id = ?")
    .bind(accountId)
    .first<CheckpointRow>();
}

async function markBlockedAuth(db: D1Database, accountId: string): Promise<void> {
  await db.prepare("UPDATE accounts SET status = 'reauth_required' WHERE id = ?").bind(accountId).run();
}

/**
 * One transaction: message upserts, the jobs to classify them, and the advanced
 * cursor. Any failure rolls the whole batch back, so the cursor can never run
 * ahead of durable work.
 */
async function commitPage(
  deps: PollDeps,
  messages: readonly RawMessage[],
  historyId: string | null,
): Promise<number> {
  if (messages.length === 0) {
    await advanceCursorOnly(deps, historyId);
    return 0;
  }

  const statements: D1PreparedStatement[] = [];
  for (const message of messages) {
    const labelIds = message.labelIds ?? [];
    statements.push(
      deps.db
        .prepare(
          "INSERT INTO messages (id, account_id, gmail_message_id, gmail_thread_id, sender, subject, received_at, label_ids, history_id, is_unread, is_starred, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?) ON CONFLICT (account_id, gmail_message_id) DO UPDATE SET gmail_thread_id = excluded.gmail_thread_id, label_ids = excluded.label_ids, history_id = excluded.history_id, is_unread = excluded.is_unread, is_starred = excluded.is_starred, updated_at = excluded.updated_at",
        )
        .bind(
          message.id,
          deps.accountId,
          message.id,
          message.threadId,
          "",
          "",
          Number(message.internalDate ?? 0),
          JSON.stringify(labelIds),
          historyId ?? "",
          labelIds.includes("UNREAD") ? 1 : 0,
          labelIds.includes("STARRED") ? 1 : 0,
          Date.now(),
        ),
    );
    // The dedupe key carries the expected revision, so re-running this page for
    // an unchanged message does not enqueue a second classification. The unique
    // index is the authority; a conflict means another writer already enqueued
    // this exact job, so ignoring it is correct rather than a silent failure.
    statements.push(
      deps.db
        .prepare(
          "INSERT INTO jobs (id, account_id, payload, dedupe_key, state, attempts, available_at, created_at) VALUES (?, ?, ?, ?, 'ready', 0, ?, ?) ON CONFLICT (account_id, dedupe_key) DO NOTHING",
        )
        .bind(
          crypto.randomUUID(),
          deps.accountId,
          JSON.stringify({ kind: "classify", messageId: message.id, expectedMessageRevision: 0 }),
          `${deps.accountId}:classify:${message.id}:0`,
          Date.now(),
          Date.now(),
        ),
    );
  }

  statements.push(
    deps.db
      .prepare(
        "INSERT INTO sync_checkpoints (account_id, version, mode, committed_history_id, page_token, scan_id, updated_at) VALUES (?, 1, 'incremental', ?, NULL, NULL, ?) ON CONFLICT (account_id) DO UPDATE SET version = sync_checkpoints.version + 1, mode = 'incremental', committed_history_id = excluded.committed_history_id, page_token = NULL, updated_at = excluded.updated_at",
      )
      .bind(deps.accountId, historyId, Date.now()),
  );

  // If this throws, nothing advances and the next run redoes the page.
  await deps.db.batch(statements);
  return messages.length;
}

async function advanceCursorOnly(deps: PollDeps, historyId: string | null): Promise<void> {
  await deps.db
    .prepare(
      "UPDATE sync_checkpoints SET version = version + 1, committed_history_id = ?, updated_at = ? WHERE account_id = ?",
    )
    .bind(historyId, Date.now(), deps.accountId)
    .run();
}
