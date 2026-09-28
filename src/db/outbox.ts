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

export function envelopeFor(jobId: string): QueueEnvelope {
  return { version: 1, jobId };
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
