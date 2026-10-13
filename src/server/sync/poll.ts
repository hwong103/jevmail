// Incremental mailbox sync. Worker A owns this directory.
//
// The durability rule this file exists to enforce: a history cursor only
// advances inside the same D1 transaction that persists the messages it
// implied and the jobs that will classify them. If the transaction fails, the
// cursor stays put and the next run redoes the page. There is no window where
// work is silently lost, and no window where a cursor has advanced past work
// that was never recorded.

import type { GmailAdapter, GmailHistoryPage, RawMessage } from "../gmail/client";
import { GmailApiError, isAuthFailure, isHistoryExpired } from "../gmail/client";
import {
  commitSyncPage,
  dedupeKeyFor,
  type JobSpec,
  type MessageUpsert,
} from "../../db/outbox";

export interface PollDeps {
  db: D1Database;
  gmail: GmailAdapter;
  accountId: string;
  maxResults?: number;
  /**
   * Ceiling on message metadata fetch *attempts* for this call. A history page
   * can name far more messages than one invocation may fetch; the remainder is
   * written to the checkpoint so the next call resumes instead of running over
   * the subrequest budget.
   */
  maxFetches?: number;
}

export interface PollResult {
  status: "ok" | "skipped" | "expired" | "blocked_auth" | "error";
  reason?: string;
  messagesSeen: number;
  messagesChanged: number;
  /**
   * Metadata fetches actually attempted this call. Counts a Gmail request even
   * when it resolves to a definitive 404: a vanished message still spent a
   * subrequest, so the cron budget must charge for it.
   */
  fetchesAttempted: number;
  historyId: string | null;
  /**
   * True when the checkpoint still holds resumable work: a Gmail page token or
   * a queue of message ids left unfetched. The cron loop keeps going while this
   * is set and stops the moment it clears.
   */
  more: boolean;
}

interface CheckpointRow {
  committed_history_id: string | null;
  page_token: string | null;
  version: number;
}

const DEFAULT_MAX_RESULTS = 100;
const DEFAULT_MAX_FETCHES = 40;

/**
 * The checkpoint's `page_token` is a JSON resume token, not a raw Gmail token.
 * It carries the Gmail page token for the next history page plus any message
 * ids from the current page that a fetch cap forced us to defer. Committing the
 * deferred ids is what makes a partially-read page resumable without skipping
 * or re-scanning it.
 */
interface ResumeToken {
  v: 1;
  gmail: string | null;
  ids: string[];
  latest: string | null;
}

function parseResumeToken(raw: string | null): ResumeToken {
  if (!raw) return { v: 1, gmail: null, ids: [], latest: null };
  try {
    const parsed = JSON.parse(raw) as Partial<ResumeToken>;
    if (parsed && parsed.v === 1 && Array.isArray(parsed.ids)) {
      return {
        v: 1,
        gmail: typeof parsed.gmail === "string" ? parsed.gmail : null,
        ids: parsed.ids.filter((id): id is string => typeof id === "string"),
        latest: typeof parsed.latest === "string" ? parsed.latest : null,
      };
    }
  } catch {
    // Not our JSON. Fall through to the legacy shape below.
  }
  // A pre-pagination row stored a raw Gmail token here, if anything at all.
  return { v: 1, gmail: raw, ids: [], latest: null };
}

export async function pollOnce(deps: PollDeps): Promise<PollResult> {
  const maxResults = deps.maxResults ?? DEFAULT_MAX_RESULTS;
  const maxFetches = deps.maxFetches ?? DEFAULT_MAX_FETCHES;
  const checkpoint = await readCheckpoint(deps.db, deps.accountId);
  if (!checkpoint) {
    return {
      status: "skipped",
      reason: "no_checkpoint",
      messagesSeen: 0,
      messagesChanged: 0,
      fetchesAttempted: 0,
      historyId: null,
      more: false,
    };
  }

  const before = checkpoint.committed_history_id;
  let token = parseResumeToken(checkpoint.page_token);

  // When the checkpoint already holds deferred ids, do not re-list: work the
  // queue we persisted last time. Only reach for Gmail when that queue is empty.
  if (token.ids.length === 0) {
    let page: GmailHistoryPage;
    try {
      page = await deps.gmail.listHistory(before, { maxResults, pageToken: token.gmail });
    } catch (error) {
      return listFailure(error, before, deps);
    }
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const entry of page.history) {
      for (const id of entry.messages ?? []) {
        if (!seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }
    }
    token = {
      v: 1,
      gmail: page.nextPageToken ?? null,
      ids,
      latest: page.historyId ?? token.latest ?? before,
    };
  }

  const budget = Math.max(0, maxFetches);
  const toFetch = token.ids.slice(0, budget);
  const remaining = token.ids.slice(budget);

  const fetched: MessageUpsert[] = [];
  const jobs: JobSpec[] = [];
  let fetchesAttempted = 0;
  for (const id of toFetch) {
    // Charge the budget before the request: a 404 or a transient fault still
    // spent a Gmail subrequest, so the attempt counts whether or not it lands.
    fetchesAttempted += 1;
    try {
      const { message, headers } = await deps.gmail.getMessage(id, "metadata");
      fetched.push(toUpsert(message, headers, token.latest ?? before));
      const payload = {
        kind: "classify" as const,
        messageId: message.id,
        expectedMessageRevision: 0,
      };
      jobs.push({ payload, dedupeKey: dedupeKeyFor(deps.accountId, payload) });
    } catch (error) {
      if (isAuthFailure(error)) {
        await markBlockedAuth(deps.db, deps.accountId);
        return {
          status: "blocked_auth",
          reason: "grant_invalid",
          messagesSeen: token.ids.length,
          messagesChanged: 0,
          fetchesAttempted,
          historyId: before,
          more: true,
        };
      }
      if (isMessageGone(error)) {
        // A message that vanished between history and fetch is not a sync
        // failure: it is gone, so we stop tracking it and carry on.
        continue;
      }
      // Anything else (429, 5xx, a network fault) is transient. Write nothing
      // and surface it, so the cursor stays put and the next pass redoes the
      // page rather than committing an empty result over real work.
      return {
        status: "error",
        reason: error instanceof Error ? error.name : "message_fetch_failed",
        messagesSeen: token.ids.length,
        messagesChanged: 0,
        fetchesAttempted,
        historyId: before,
        more: true,
      };
    }
  }

  // Advance the committed cursor only once every id on the page has been
  // fetched and no further page is queued. Until then the cursor stands still
  // and the resume token carries the unfinished work.
  let committed = before;
  let nextToken: ResumeToken | null;
  let more: boolean;
  if (remaining.length > 0) {
    nextToken = { v: 1, gmail: token.gmail, ids: remaining, latest: token.latest };
    more = true;
  } else if (token.gmail) {
    nextToken = { v: 1, gmail: token.gmail, ids: [], latest: token.latest };
    more = true;
  } else {
    nextToken = null;
    committed = token.latest ?? before;
    more = false;
  }

  await commitSyncPage(deps.db, {
    accountId: deps.accountId,
    messages: fetched,
    jobs,
    checkpoint: {
      mode: "incremental",
      historyId: committed,
      pageToken: nextToken ? JSON.stringify(nextToken) : null,
      scanId: null,
    },
  });
  return {
    status: "ok",
    messagesSeen: token.ids.length,
    messagesChanged: fetched.length,
    fetchesAttempted,
    historyId: committed,
    more,
  };
}

/**
 * Classifies a history-list failure. Auth parks the account; an aged-out cursor
 * is reported as expired (never as an empty mailbox); anything else is
 * transient and leaves the cursor untouched so the page is redone.
 */
async function listFailure(
  error: unknown,
  before: string | null,
  deps: PollDeps,
): Promise<PollResult> {
  if (isAuthFailure(error)) {
    await markBlockedAuth(deps.db, deps.accountId);
    return {
      status: "blocked_auth",
      reason: "grant_invalid",
      messagesSeen: 0,
      messagesChanged: 0,
      fetchesAttempted: 0,
      historyId: before,
      more: true,
    };
  }
  if (isHistoryExpired(error)) {
    return {
      status: "expired",
      reason: "history_id_expired",
      messagesSeen: 0,
      messagesChanged: 0,
      fetchesAttempted: 0,
      historyId: null,
      more: false,
    };
  }
  return {
    status: "error",
    reason: error instanceof Error ? error.name : "list_failed",
    messagesSeen: 0,
    messagesChanged: 0,
    fetchesAttempted: 0,
    historyId: before,
    more: true,
  };
}

/** A definitive 404 on a message: it no longer exists, so it is not a failure. */
function isMessageGone(error: unknown): boolean {
  return error instanceof GmailApiError && error.status === 404 && !isHistoryExpired(error);
}

/**
 * Maps a raw Gmail metadata response to a persistable upsert. Sender and
 * subject come from the metadata headers Gmail already returned, so the tray
 * can render a real list without a second fetch.
 */
function toUpsert(
  message: RawMessage,
  headers: readonly { name: string; value: string }[],
  historyId: string | null,
): MessageUpsert {
  const labelIds = message.labelIds ?? [];
  return {
    gmailMessageId: message.id,
    gmailThreadId: message.threadId,
    sender: header(headers, "From"),
    subject: header(headers, "Subject"),
    receivedAt: Number(message.internalDate ?? 0),
    labelIds,
    historyId: historyId ?? "",
    isUnread: labelIds.includes("UNREAD"),
    isStarred: labelIds.includes("STARRED"),
  };
}

function header(headers: readonly { name: string; value: string }[], name: string): string {
  const wanted = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === wanted)?.value ?? "";
}

async function readCheckpoint(db: D1Database, accountId: string): Promise<CheckpointRow | null> {
  return db
    .prepare(
      "SELECT committed_history_id, page_token, version FROM sync_checkpoints WHERE account_id = ?",
    )
    .bind(accountId)
    .first<CheckpointRow>();
}

async function markBlockedAuth(db: D1Database, accountId: string): Promise<void> {
  await db.prepare("UPDATE accounts SET status = 'reauth_required' WHERE id = ?").bind(accountId).run();
}
