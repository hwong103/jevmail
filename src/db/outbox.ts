// Transactional outbox. The integrator owns this file.
//
// The durable boundary: ingest changes, the sync checkpoint, the jobs they
// imply, and the outbox rows that publish those jobs all commit in one D1
// transaction. The history cursor therefore only advances once every page's
// work is durably represented, and a crash between commit and publish is
// recovered by the outbox sweep rather than losing the work.

import type { JobPayload, QueueEnvelope } from "../contracts/domain";

export interface OutboxPort {
  /**
   * Commits a sync page atomically: message upserts, the advanced cursor, the
   * jobs those messages imply, and the outbox rows that publish them.
   * Throwing rolls back everything, including the cursor.
   */
  commitSyncPage(input: {
    accountId: string;
    messages: readonly MessageUpsert[];
    checkpoint: { mode: string; historyId: string | null; pageToken: string | null; scanId: string | null };
    jobs: readonly JobSpec[];
  }): Promise<void>;

  /** Publishes pending outbox rows. Safe to call repeatedly; idempotent by job id. */
  publishPending(limit: number): Promise<{ published: number; failed: number }>;

  /** Claims jobs with a lease. Returns nothing when another worker holds them. */
  claimJobs(limit: number, leaseMs: number): Promise<ClaimedJob[]>;

  settleJob(jobId: string, state: "succeeded" | "blocked_auth" | "dead", errorCode?: string): Promise<void>;
}

export interface MessageUpsert {
  gmailMessageId: string;
  gmailThreadId: string;
  sender: string;
  subject: string;
  receivedAt: number;
  labelIds: string[];
  historyId: string;
  isUnread: boolean;
  isStarred: boolean;
}

export interface JobSpec {
  payload: JobPayload;
  dedupeKey: string;
  availableAt?: number;
}

export interface ClaimedJob {
  id: string;
  accountId: string;
  payload: JobPayload;
  attempts: number;
  leaseToken: string;
}

export interface CommitSyncPageInput {
  accountId: string;
  messages: readonly MessageUpsert[];
  jobs: readonly JobSpec[];
  checkpoint: {
    mode: string;
    historyId: string | null;
    pageToken: string | null;
    scanId: string | null;
  };
  /** Injected clock; defaults to Date.now(). */
  now?: number;
}

export interface PublishResult {
  published: number;
  failed: number;
}

const PUBLISH_LEASE_MS = 60_000;
const PUBLISH_BACKOFF_MS = 30_000;

export function envelopeFor(jobId: string): QueueEnvelope {
  return { version: 1, jobId };
}

/**
 * Commits one sync page in a single D1 batch: message upserts, the jobs those
 * messages imply, an outbox row per job, and the advanced cursor. The outbox
 * rows make the page recoverable: if the isolate dies after commit but before
 * publish, `publishPending` sweeps them on the next run rather than losing the
 * work.
 *
 * The outbox row's id is the job's dedupe key, so re-running an unchanged page
 * (or two writers racing the same page) leaves exactly one outbox row. Its
 * `job_id` is resolved by subquery from the jobs table, so it always points at
 * the job that actually exists, whether this batch inserted it or an earlier
 * one did.
 */
export async function commitSyncPage(
  db: D1Database,
  input: CommitSyncPageInput,
): Promise<void> {
  const now = input.now ?? Date.now();
  const statements: D1PreparedStatement[] = [];

  for (const message of input.messages) {
    statements.push(
      db
        .prepare(
          "INSERT INTO messages (id, account_id, gmail_message_id, gmail_thread_id, sender, subject, received_at, label_ids, history_id, is_unread, is_starred, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?) ON CONFLICT (account_id, gmail_message_id) DO UPDATE SET gmail_thread_id = excluded.gmail_thread_id, sender = excluded.sender, subject = excluded.subject, received_at = excluded.received_at, label_ids = excluded.label_ids, history_id = excluded.history_id, is_unread = excluded.is_unread, is_starred = excluded.is_starred, updated_at = excluded.updated_at",
        )
        .bind(
          message.gmailMessageId,
          input.accountId,
          message.gmailMessageId,
          message.gmailThreadId,
          message.sender,
          message.subject,
          message.receivedAt,
          JSON.stringify(message.labelIds),
          message.historyId,
          message.isUnread ? 1 : 0,
          message.isStarred ? 1 : 0,
          now,
        ),
    );
  }

  for (const job of input.jobs) {
    const jobId = crypto.randomUUID();
    // The dedupe key is the authority: a re-run of an unchanged page conflicts
    // here and inserts nothing, so no second job is ever enqueued.
    statements.push(
      db
        .prepare(
          "INSERT INTO jobs (id, account_id, payload, dedupe_key, state, attempts, available_at, created_at) VALUES (?, ?, ?, ?, 'ready', 0, ?, ?) ON CONFLICT (account_id, dedupe_key) DO NOTHING",
        )
        .bind(
          jobId,
          input.accountId,
          JSON.stringify(job.payload),
          job.dedupeKey,
          job.availableAt ?? now,
          now,
        ),
    );
    // Exactly one outbox row per logical job: the id is the dedupe key, so a
    // re-run is a no-op. job_id is read back from the jobs table, so it always
    // references the row that actually exists (this batch's insert or an
    // earlier one) rather than a fresh id that a conflict discarded.
    statements.push(
      db
        .prepare(
          "INSERT INTO outbox (id, job_id, state, attempts, available_at) VALUES (?, (SELECT id FROM jobs WHERE account_id = ? AND dedupe_key = ?), 'pending', 0, ?) ON CONFLICT (id) DO NOTHING",
        )
        .bind(job.dedupeKey, input.accountId, job.dedupeKey, job.availableAt ?? now),
    );
  }

  statements.push(
    db
      .prepare(
        "INSERT INTO sync_checkpoints (account_id, version, mode, committed_history_id, page_token, scan_id, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?) ON CONFLICT (account_id) DO UPDATE SET version = sync_checkpoints.version + 1, mode = excluded.mode, committed_history_id = excluded.committed_history_id, page_token = excluded.page_token, scan_id = excluded.scan_id, updated_at = excluded.updated_at",
      )
      .bind(
        input.accountId,
        input.checkpoint.mode,
        input.checkpoint.historyId,
        input.checkpoint.pageToken,
        input.checkpoint.scanId,
        now,
      ),
  );

  // If this throws, nothing advances and the next run redoes the page.
  await db.batch(statements);
}

/**
 * Publishes pending outbox rows: each row's job id is sent as an ID-only
 * envelope, then the row is marked published. Safe to call repeatedly.
 *
 * Idempotence comes from the claim: a row is moved `pending -> publishing` with
 * a lease token before the send, and only the claimer may mark it published. A
 * second sweep, or a concurrent one, finds no claimable row and sends nothing.
 * A send that throws is released back to `pending` with a backoff so the next
 * sweep retries it rather than losing it.
 *
 * The claim also covers a row stranded in `publishing` by an earlier publisher
 * that died after claiming but before sending: once its lease is expired the
 * row is reclaimable, so no delivery is lost to a crash mid-publish. Every
 * claim carries a fresh deadline, and the completing update is token-fenced, so
 * a stale claimer that wakes up after its lease was reclaimed cannot clobber the
 * row a new claimer is working on.
 */
export async function publishPending(
  db: D1Database,
  queue: Queue<unknown>,
  limit: number,
  now = Date.now(),
): Promise<PublishResult> {
  const rows = await db
    .prepare(
      "SELECT id, job_id FROM outbox WHERE (state = 'pending' AND available_at <= ?) OR (state = 'publishing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?) ORDER BY available_at ASC, id ASC LIMIT ?",
    )
    .bind(now, now, limit)
    .all<{ id: string; job_id: string }>();

  let published = 0;
  let failed = 0;
  for (const row of rows.results) {
    const lease = crypto.randomUUID();
    // One atomic claim covers both states, so a concurrent sweep finds nothing
    // to claim and a fresh deadline is set per claim.
    const claim = await db
      .prepare(
        "UPDATE outbox SET state = 'publishing', lease_token = ?, lease_expires_at = ? WHERE id = ? AND ((state = 'pending' AND available_at <= ?) OR (state = 'publishing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?))",
      )
      .bind(lease, now + PUBLISH_LEASE_MS, row.id, now, now)
      .run();
    if ((claim.meta?.changes ?? 0) !== 1) continue; // another publisher holds it

    try {
      await queue.send(envelopeFor(row.job_id));
      await db
        .prepare(
          "UPDATE outbox SET state = 'published', published_at = ?, lease_token = NULL, lease_expires_at = NULL WHERE id = ? AND state = 'publishing' AND lease_token = ?",
        )
        .bind(Date.now(), row.id, lease)
        .run();
      published += 1;
    } catch (error) {
      await db
        .prepare(
          "UPDATE outbox SET state = 'pending', lease_token = NULL, lease_expires_at = NULL, attempts = attempts + 1, available_at = ? WHERE id = ? AND lease_token = ?",
        )
        .bind(Date.now() + PUBLISH_BACKOFF_MS, row.id, lease)
        .run();
      failed += 1;
      void error;
    }
  }
  return { published, failed };
}

export function dedupeKeyFor(accountId: string, payload: JobPayload): string {
  const suffix =
    payload.kind === "sync"
      ? `sync:${payload.checkpointVersion}`
      : payload.kind === "classify"
        ? `classify:${payload.messageId}:${payload.expectedMessageRevision}`
        : payload.kind === "evaluate"
          ? `evaluate:${payload.classificationId}:${payload.correctionRevision}`
          : payload.kind === "apply"
            ? `apply:${payload.intentId}`
            : `reconcile:${payload.intentId}`;
  return `${accountId}:${suffix}`;
}
