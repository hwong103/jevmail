// Queue consumer. The integrator owns this file because it composes the
// handlers that workers A, B, and C own.
//
// Queue envelopes carry a job id only. If a message body ever appears here,
// something upstream has broken the contract and the message is rejected rather
// than processed, so content can never reach the queue or the dead-letter queue.
//
// Delivery is at-least-once, so the handler is built to be safe under duplicate
// and parallel delivery and under a crash at any point:
//   - A job is claimed with an atomic, lease-fenced UPDATE before any work, so
//     only one delivery of the same job runs the fetch and the provider call.
//     The claim precedes dependency construction, so a losing duplicate never
//     pays for an OAuth refresh or a provider call.
//   - A `leased` job whose lease has expired is reclaimable, so a worker that
//     dies mid-job does not strand its work.
//   - A delivery that loses the claim to a live lease is not acked and
//     forgotten: it is surfaced for queue redelivery, so a winner that then
//     dies is recovered once its lease expires rather than stranding the job.
//   - Settlement is token-fenced, so a stale worker that wakes up after its
//     lease was reclaimed cannot clobber the row.
//   - The classification write is idempotent per logical job, so a crash after
//     the insert but before settlement does not duplicate the row.

import type { QueueEnvelope } from "../../contracts/domain";
import type { Env } from "../../runtime/env";
import { handleClassify, type ClassifyDeps } from "./classify";
import { buildClassificationPort, buildGmailFetcher, type GmailFetcher } from "./deps";

export interface JobResult {
  jobId: string;
  kind: string;
  outcome: "succeeded" | "blocked_auth" | "dead" | "ignored" | "retrying";
  /** When set, the delivery is retried (redelivered) instead of acked. */
  retry?: boolean;
}

/**
 * How long a claim is good for. A handler that outlives it is safe rather than
 * corrupting: settlement is token-fenced and the classification write is
 * idempotent, so a reclaimed job's stale worker cannot clobber the row.
 */
const JOB_LEASE_MS = 120_000;

/**
 * How long a `blocked_auth` job waits before its outbox row is re-armed for a
 * later sweep. Bounded so an unconfigured install retries on a slow cadence
 * instead of spinning.
 */
const BLOCKED_RETRY_BACKOFF_MS = 5 * 60_000;

/** Test seams, mirroring the sync cron's `SyncOverrides`. */
export interface JobOverrides {
  /** Builds classify deps without live OAuth. */
  classifyDeps?: (env: Env) => Promise<ClassifyDeps | null>;
  /** Injected clock. */
  now?: number;
}

export async function handleJob(
  batch: MessageBatch<unknown>,
  env: Env,
  overrides: JobOverrides = {},
): Promise<JobResult[]> {
  const results: JobResult[] = [];
  for (const message of batch.messages) {
    const parsed = parseEnvelope(message.body);
    if (!parsed) {
      // A malformed payload is a contract violation, not a transient failure.
      message.ack();
      results.push({ jobId: "unknown", kind: "invalid", outcome: "ignored" });
      continue;
    }
    let result: JobResult;
    try {
      result = await runJob(parsed.jobId, env, overrides);
    } catch (error) {
      // A thrown handler is a transient failure, so the message is retried and
      // eventually dead-lettered rather than silently dropped.
      message.retry();
      results.push({
        jobId: parsed.jobId,
        kind: "error",
        outcome: "dead",
        retry: true,
      });
      void error;
      continue;
    }
    // A delivery that could not claim the job (a live lease held elsewhere) is
    // redelivered rather than acked, so a winner that dies afterwards is not
    // stranded by an already-published outbox row.
    if (result.retry) message.retry();
    else message.ack();
    results.push(result);
  }
  return results;
}

async function runJob(
  jobId: string,
  env: Env,
  overrides: JobOverrides,
): Promise<JobResult> {
  const now = overrides.now ?? Date.now();
  const job = await env.DB.prepare("SELECT payload, state FROM jobs WHERE id = ?")
    .bind(jobId)
    .first<{ payload: string; state: string }>();
  if (!job) return { jobId, kind: "missing", outcome: "ignored" };
  if (job.state === "succeeded" || job.state === "dead") {
    return { jobId, kind: "already_settled", outcome: "ignored" };
  }

  const payload = JSON.parse(job.payload) as { kind?: string } & Record<string, unknown>;
  if (payload.kind !== "classify") {
    // Sync, evaluate, apply, and reconcile land in later gates. Settling an
    // unhandled kind is deliberate: retrying it forever would be worse. The
    // claim keeps a duplicate delivery from settling it twice.
    const lease = await claimJob(env.DB, jobId, now);
    if (!lease) return lostClaim(jobId, payload.kind ?? "unknown");
    await settleUnderLease(env.DB, jobId, "succeeded", lease);
    return { jobId, kind: payload.kind ?? "unknown", outcome: "succeeded" };
  }

  // The claim is what makes parallel or duplicate delivery safe: a second
  // delivery that loses the race finds the job leased (or settled) and returns
  // without touching Gmail or the provider. Claiming before building the deps
  // matters: building them can refresh an OAuth token, and a losing duplicate
  // must not pay for that.
  const lease = await claimJob(env.DB, jobId, now);
  if (!lease) return lostClaim(jobId, "classify");

  // Everything after the claim runs inside the lease-releasing handler: a throw
  // anywhere here (OAuth refresh, Gmail adapter build, the provider call) hands
  // the lease back so the queue's retry reclaims the job at once instead of
  // waiting out the full lease window. `blocked_auth` returns normally, not by
  // throwing, so parking is untouched.
  try {
    const deps = await (overrides.classifyDeps ?? classifyDeps)(env);
    if (!deps) {
      // No provider is configured. Park the job and re-arm its outbox row, so a
      // later sweep re-delivers it once a key is configured; a silent ack would
      // leave the work stranded with no resume path.
      await parkForAuth(env.DB, jobId, lease, now);
      return { jobId, kind: "classify", outcome: "blocked_auth" };
    }

    const result = await handleClassify(
      deps,
      String(payload.messageId),
      Number(payload.expectedMessageRevision ?? 0),
      { jobId, leaseToken: lease },
    );
    if (result.status === "retryable") {
      // A transient provider failure is not a classification. Hand the lease
      // back so the retry reclaims it at once, and surface the delivery so it is
      // redelivered rather than settled as succeeded with nothing stored.
      await releaseLease(env.DB, jobId, lease);
      return { jobId, kind: "classify", outcome: "retrying", retry: true };
    }
    await settleUnderLease(env.DB, jobId, "succeeded", lease);
    return { jobId, kind: "classify", outcome: "succeeded" };
  } catch (error) {
    // Release the lease so the queue's retry can reclaim immediately rather
    // than waiting out the full lease window.
    await releaseLease(env.DB, jobId, lease);
    throw error;
  }
}

/**
 * A delivery that lost the claim to a job that is neither settled nor
 * immediately claimable. It must not be acked and forgotten: if the lease
 * holder then dies, the outbox row is already `published`, so nothing would
 * redeliver the job. Surfacing the delivery makes the job reclaimable once the
 * lease expires, and once the winner settles the redelivery is a cheap no-op.
 */
function lostClaim(jobId: string, kind: string): JobResult {
  return { jobId, kind, outcome: "retrying", retry: true };
}

/**
 * Atomically claims a job with a lease. A fresh `ready` or parked `blocked_auth`
 * job is claimable once available; a `leased` job is reclaimable only once its
 * lease has expired, so a crashed worker's work is not stranded. The conditional
 * UPDATE is the whole race guard: exactly one caller can win it.
 */
async function claimJob(db: D1Database, jobId: string, now: number): Promise<string | null> {
  const lease = crypto.randomUUID();
  const result = await db
    .prepare(
      "UPDATE jobs SET state = 'leased', lease_token = ?, lease_expires_at = ?, attempts = attempts + 1 WHERE id = ? AND ((state IN ('ready', 'blocked_auth') AND available_at <= ?) OR (state = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?))",
    )
    .bind(lease, now + JOB_LEASE_MS, jobId, now, now)
    .run();
  return (result.meta?.changes ?? 0) === 1 ? lease : null;
}

/** Settles a job only while the caller still holds its lease. */
async function settleUnderLease(
  db: D1Database,
  jobId: string,
  state: "succeeded" | "blocked_auth" | "dead",
  lease: string,
): Promise<void> {
  await db
    .prepare(
      "UPDATE jobs SET state = ?, lease_token = NULL, lease_expires_at = NULL WHERE id = ? AND lease_token = ?",
    )
    .bind(state, jobId, lease)
    .run();
}

/** Returns a lease held on a failed handler so the queue retry can reclaim it. */
async function releaseLease(db: D1Database, jobId: string, lease: string): Promise<void> {
  await db
    .prepare(
      "UPDATE jobs SET state = 'ready', available_at = ?, lease_token = NULL, lease_expires_at = NULL WHERE id = ? AND lease_token = ?",
    )
    .bind(Date.now(), jobId, lease)
    .run();
}

/**
 * Parks a job with no configured provider and re-arms its outbox row so the
 * next sweep re-delivers it. The job stays `blocked_auth` (resumable) rather
 * than terminal, and the publisher only re-sends once the backoff elapses.
 */
async function parkForAuth(
  db: D1Database,
  jobId: string,
  lease: string,
  now: number,
): Promise<void> {
  const availableAt = now + BLOCKED_RETRY_BACKOFF_MS;
  await db.batch([
    db
      .prepare(
        "UPDATE jobs SET state = 'blocked_auth', available_at = ?, lease_token = NULL, lease_expires_at = NULL WHERE id = ? AND lease_token = ?",
      )
      .bind(availableAt, jobId, lease),
    db
      .prepare(
        // Covers a row the publisher is mid-send on as well as a settled one:
        // the publisher's completion is token-fenced, so clearing the lease here
        // makes its later `published` write a no-op rather than a lost re-arm.
        "UPDATE outbox SET state = 'pending', available_at = ?, lease_token = NULL, lease_expires_at = NULL WHERE job_id = ? AND state IN ('published', 'publishing')",
      )
      .bind(availableAt, jobId),
  ]);
}

/**
 * Builds the classify handler's dependencies from the environment. Returns
 * null when no AI binding or no connected account exists, which parks the job
 * instead of pretending to classify.
 */
export async function classifyDeps(env: Env): Promise<ClassifyDeps | null> {
  if (!env.DB) return null;
  const account = await env.DB.prepare(
    "SELECT id FROM accounts WHERE status = 'active' ORDER BY created_at ASC LIMIT 1",
  )
    .bind()
    .first<{ id: string }>();
  if (!account) return null;

  const port = buildClassificationPort(env);
  const fetcher = await buildGmailFetcher(env, account.id);
  if (!port || !fetcher) return null;

  return { db: env.DB, accountId: account.id, port, fetchMessage: fetcher };
}

export function parseEnvelope(body: unknown): QueueEnvelope | null {
  if (typeof body !== "object" || body === null) return null;
  if (Array.isArray(body)) return null;
  const candidate = body as Record<string, unknown>;
  // Reject anything beyond the two permitted fields. A payload carrying a
  // message body must never pass as valid, or content could reach the queue and
  // the dead-letter queue.
  const allowed = new Set(["version", "jobId"]);
  for (const key of Object.keys(candidate)) {
    if (!allowed.has(key)) return null;
  }
  if (candidate.version !== 1) return null;
  if (typeof candidate.jobId !== "string" || candidate.jobId.length === 0) return null;
  return { version: 1, jobId: candidate.jobId };
}

export type { GmailFetcher };
