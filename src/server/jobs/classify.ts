// The classify job handler. Worker B owns the classification logic; the
// integrator owns this file because it composes the repository, the provider,
// and the outbox.
//
// Two invariants this handler must not break:
// 1. A body is fetched, classified, and discarded. It is never written to D1.
// 2. A late completion for a stale input is discarded rather than stored, so a
//    slow model call cannot overwrite a newer decision.

import {
  NORMALIZER_VERSION,
  SCHEMA_VERSION,
  type Answers,
  type InputQuality,
  type NormalizedMessage,
} from "../../contracts/domain";
import { placeInTray } from "../../contracts/trays";
import { classifyMessage, type ClassificationPort } from "../classification/classify";
import { extractBody, hashString, type GmailMessage } from "../gmail/normalize";

export interface ClassifyDeps {
  db: D1Database;
  accountId: string;
  port: ClassificationPort;
  fetchMessage: (gmailMessageId: string) => Promise<GmailMessage | null>;
}

/**
 * The claim that fences the write. The stored row is written only while this
 * job still holds its lease and the message is still at the revision the job
 * was queued for, so a worker whose lease was reclaimed mid-classify, or whose
 * input was superseded by a newer revision, cannot overwrite the newer row.
 */
export interface ClassifyClaim {
  jobId: string;
  leaseToken: string;
}

export interface ClassifyResult {
  status: "stored" | "skipped" | "stale" | "no_body" | "retryable";
  messageId: string;
  classificationId?: string;
}

export async function handleClassify(
  deps: ClassifyDeps,
  gmailMessageId: string,
  expectedMessageRevision: number,
  claim?: ClassifyClaim,
): Promise<ClassifyResult> {
  const row = await deps.db
    .prepare(
      "SELECT revision, subject, sender, gmail_thread_id FROM messages WHERE account_id = ? AND gmail_message_id = ?",
    )
    .bind(deps.accountId, gmailMessageId)
    .first<{ revision: number; subject: string; sender: string; gmail_thread_id: string }>();
  if (!row) return { status: "skipped", messageId: gmailMessageId };

  // The input changed after this job was queued, so classifying it now would
  // describe something that no longer exists.
  if (row.revision !== expectedMessageRevision) {
    return { status: "stale", messageId: gmailMessageId };
  }

  const raw = await deps.fetchMessage(gmailMessageId);
  if (!raw) return { status: "skipped", messageId: gmailMessageId };

  const extracted = extractBody(raw.payload);
  const sender = firstHeader(raw, "From") || row.sender;
  const subject = firstHeader(raw, "Subject") || row.subject;
  const inputHash = hashString(
    [sender, subject, extracted.quality, extracted.text ?? ""].join("\u0000"),
  );

  // Idempotent per logical job, but only against a CURRENT row: a prior run that
  // stored this exact input and then crashed before settling left a live row
  // behind, so reuse it rather than calling the provider again. A stale or
  // failed historical row is deliberately not reused: an A -> B -> A sequence
  // must make A current again rather than return the old, superseded A row, and
  // an unsuccessful attempt must never masquerade as a stored classification.
  const existing = await deps.db
    .prepare(
      "SELECT id FROM classifications WHERE account_id = ? AND gmail_message_id = ? AND input_hash = ? AND status NOT IN ('stale', 'failed')",
    )
    .bind(deps.accountId, gmailMessageId, inputHash)
    .first<{ id: string }>();
  if (existing) {
    return { status: "stored", messageId: gmailMessageId, classificationId: existing.id };
  }

  const fence = claim ? { ...claim, expectedMessageRevision } : null;

  if (!extracted.text) {
    const classificationId = await store(deps, {
      gmailMessageId,
      threadId: row.gmail_thread_id,
      inputHash,
      threadContextHash: hashString(""),
      quality: extracted.quality,
      answers: null,
      status: "review",
      modelVersion: "none",
      promptVersion: 0,
    }, fence);
    if (!classificationId) return { status: "stale", messageId: gmailMessageId };
    return { status: "no_body", messageId: gmailMessageId, classificationId };
  }

  const normalized: NormalizedMessage = {
    accountId: deps.accountId,
    messageId: gmailMessageId,
    threadId: row.gmail_thread_id,
    sender,
    subject,
    receivedAt: Number(raw.internalDate ?? 0),
    text: extracted.text,
    revision: {
      inputHash,
      threadContextHash: hashString(""),
      contextMessageIds: [],
      normalizerVersion: NORMALIZER_VERSION,
      quality: extracted.quality,
    },
  };

  const outcome = await classifyMessage(deps.port, normalized);

  // A transient provider failure is not a classification. Nothing is stored:
  // storing a row would suppress every later attempt with the same input, and
  // the job must stay retryable rather than settle as succeeded.
  if (outcome.status === "failed") {
    return { status: "retryable", messageId: gmailMessageId };
  }

  const classificationId = await store(deps, {
    gmailMessageId,
    threadId: row.gmail_thread_id,
    inputHash,
    threadContextHash: normalized.revision.threadContextHash,
    quality: extracted.quality,
    answers: outcome.answers,
    status: outcome.status,
    modelVersion: outcome.modelVersion,
    promptVersion: outcome.promptVersion,
  }, fence);
  if (!classificationId) return { status: "stale", messageId: gmailMessageId };
  return { status: "stored", messageId: gmailMessageId, classificationId };
}

function firstHeader(message: GmailMessage, name: string): string {
  const headers = message.payload?.headers as { name: string; value: string }[] | undefined;
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function emptyAnswers(): Answers {
  const unknown = { state: "unknown", reason: "missing" } as const;
  return {
    category: unknown,
    needsReply: unknown,
    needsAction: unknown,
    urgency: unknown,
    importance: unknown,
    senderType: unknown,
  } as Answers;
}

async function store(
  deps: ClassifyDeps,
  input: {
    gmailMessageId: string;
    threadId: string;
    inputHash: string;
    threadContextHash: string;
    quality: InputQuality;
    answers: Answers | null;
    status: "complete" | "review" | "failed";
    modelVersion: string;
    promptVersion: number;
  },
  fence: { jobId: string; leaseToken: string; expectedMessageRevision: number } | null,
): Promise<string | null> {
  const id = crypto.randomUUID();
  // A message whose tray placement is uncertain is stored as review so it
  // surfaces for a human rather than being filed on a low-confidence verdict.
  const uncertain = input.answers ? placeInTray(input.answers, input.quality).uncertain : true;
  const status = uncertain ? "review" : input.status;

  // The row this insert supersedes, read before the batch so the batch's own
  // UPDATE (which stales it) does not hide it from the supersedes_id link.
  const prior = await deps.db
    .prepare(
      "SELECT id FROM classifications WHERE account_id = ? AND gmail_message_id = ? AND status IN ('complete', 'review') AND input_hash <> ? ORDER BY created_at DESC LIMIT 1",
    )
    .bind(deps.accountId, input.gmailMessageId, input.inputHash)
    .first<{ id: string }>();

  // Conditional write fence. The UPDATE and the INSERT each carry it, so a lost
  // lease or a superseded revision turns the whole write into a no-op rather
  // than only being checked before the batch (a check-then-write would still
  // race a reclaim that lands mid-classify).
  const fenceSql = fence
    ? " AND EXISTS (SELECT 1 FROM jobs WHERE id = ? AND lease_token = ?) AND (SELECT revision FROM messages WHERE account_id = ? AND gmail_message_id = ?) = ?"
    : "";
  const fenceBinds = fence
    ? [fence.jobId, fence.leaseToken, deps.accountId, input.gmailMessageId, fence.expectedMessageRevision]
    : [];

  await deps.db.batch([
    // Supersede the previous live classification only when the input actually
    // changed. Both live statuses are retired, so A -> B -> A cannot leave two
    // live rows, and the one-live-row-per-message index admits the new row while
    // the old row is preserved as history. Unchanged input leaves it untouched.
    deps.db
      .prepare(
        "UPDATE classifications SET status = 'stale' WHERE account_id = ? AND gmail_message_id = ? AND status IN ('complete', 'review') AND input_hash <> ?" +
          fenceSql,
      )
      .bind(deps.accountId, input.gmailMessageId, input.inputHash, ...fenceBinds),
    // Insert only when no row for this exact logical input exists yet, so a
    // crash after this insert cannot produce a duplicate on a retried job. The
    // existence check is scoped to current rows: a stale row for the same input
    // (an A -> B -> A return) does not block re-storing A as current.
    deps.db
      .prepare(
        "INSERT INTO classifications (id, account_id, gmail_message_id, gmail_thread_id, input_hash, thread_context_hash, input_quality, model_version, prompt_version, schema_version, answers, status, supersedes_id, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM classifications WHERE account_id = ? AND gmail_message_id = ? AND input_hash = ? AND status NOT IN ('stale', 'failed'))" +
          fenceSql,
      )
      .bind(
        id,
        deps.accountId,
        input.gmailMessageId,
        input.threadId,
        input.inputHash,
        input.threadContextHash,
        input.quality,
        input.modelVersion,
        input.promptVersion,
        SCHEMA_VERSION,
        JSON.stringify(input.answers ?? emptyAnswers()),
        status,
        prior?.id ?? null,
        Date.now(),
        deps.accountId,
        input.gmailMessageId,
        input.inputHash,
        ...fenceBinds,
      ),
  ]);

  // If the conditional insert was a no-op because a current row already
  // existed, the caller needs the id that actually landed rather than the
  // discarded one. A miss here means the fence blocked the write (a lost lease
  // or a superseded revision), so the caller can report the job as stale.
  const stored = await deps.db
    .prepare(
      "SELECT id FROM classifications WHERE account_id = ? AND gmail_message_id = ? AND input_hash = ? AND status NOT IN ('stale', 'failed')",
    )
    .bind(deps.accountId, input.gmailMessageId, input.inputHash)
    .first<{ id: string }>();
  return stored?.id ?? null;
}
