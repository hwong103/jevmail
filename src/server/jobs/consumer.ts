// Queue consumer. Worker A owns Gmail-triggered jobs, worker B owns
// classification jobs, worker C owns apply/reconcile. The integrator composes
// the dispatcher and owns this file.
//
// Queue envelopes carry a job id only. If a message ever appears here,
// something upstream has broken the contract and it should be rejected.

import type { QueueEnvelope } from "../../contracts/domain";
import type { Env } from "../../runtime/env";

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
    // Handlers are wired in during integration. Until then, the job is
    // acknowledged as a no-op rather than retried forever.
    message.ack();
    results.push({ jobId: parsed.jobId, kind: "unwired", outcome: "succeeded" });
  }
  void env;
  return results;
}

export function parseEnvelope(body: unknown): QueueEnvelope | null {
  if (typeof body !== "object" || body === null) return null;
  if (Array.isArray(body)) return null;
  const candidate = body as Record<string, unknown>;
  // Reject anything beyond the two permitted fields. A payload carrying a
  // message body must never pass as a valid envelope, or content could reach
  // the queue and the dead-letter queue.
  const allowed = new Set(["version", "jobId"]);
  for (const key of Object.keys(candidate)) {
    if (!allowed.has(key)) return null;
  }
  if (candidate.version !== 1) return null;
  if (typeof candidate.jobId !== "string" || candidate.jobId.length === 0) return null;
  return { version: 1, jobId: candidate.jobId };
}
