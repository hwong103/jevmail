// Queue consumer. The integrator owns this file because it composes the
// handlers that workers A, B, and C own.
//
// Queue envelopes carry a job id only. If a message body ever appears here,
// something upstream has broken the contract and the message is rejected rather
// than processed, so content can never reach the queue or the dead-letter queue.

import type { QueueEnvelope } from "../../contracts/domain";
import type { Env } from "../../runtime/env";
import { handleClassify, type ClassifyDeps } from "./classify";
import { buildClassificationPort, buildGmailFetcher, type GmailFetcher } from "./deps";

export interface JobResult {
  jobId: string;
  kind: string;
  outcome: "succeeded" | "blocked_auth" | "dead" | "ignored";
}

export async function handleJob(
  batch: MessageBatch<unknown>,
  env: Env,
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
    try {
      results.push(await runJob(parsed.jobId, env));
    } catch (error) {
      // A thrown handler is a transient failure, so the message is retried and
      // eventually dead-lettered rather than silently dropped.
      message.retry();
      results.push({
        jobId: parsed.jobId,
        kind: "error",
        outcome: "dead",
      });
      void error;
    }
    if (results.at(-1)?.outcome !== "dead") message.ack();
  }
  return results;
}

async function runJob(jobId: string, env: Env): Promise<JobResult> {
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
    // unhandled kind is deliberate: retrying it forever would be worse.
    await settle(env, jobId, "succeeded");
    return { jobId, kind: payload.kind ?? "unknown", outcome: "succeeded" };
  }

  const deps = await classifyDeps(env);
  if (!deps) {
    // No provider is configured. Park the job rather than failing it, so
    // configuring a key later resumes the work instead of dead-lettering it.
    await settle(env, jobId, "blocked_auth");
    return { jobId, kind: "classify", outcome: "blocked_auth" };
  }

  await handleClassify(
    deps,
    String(payload.messageId),
    Number(payload.expectedMessageRevision ?? 0),
  );
  await settle(env, jobId, "succeeded");
  return { jobId, kind: "classify", outcome: "succeeded" };
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

export async function settle(
  env: Env,
  jobId: string,
  state: "succeeded" | "blocked_auth" | "dead",
): Promise<void> {
  await env.DB.prepare(
    "UPDATE jobs SET state = ?, lease_token = NULL, lease_expires_at = NULL WHERE id = ?",
  )
    .bind(state, jobId)
    .run();
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
