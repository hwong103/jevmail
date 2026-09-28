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

export interface ClassifyResult {
  status: "stored" | "skipped" | "stale" | "no_body";
  messageId: string;
  classificationId?: string;
}

export async function handleClassify(
  deps: ClassifyDeps,
  gmailMessageId: string,
  expectedMessageRevision: number,
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

  if (!extracted.text) {
    const classificationId = await store(deps, {
      gmailMessageId,
      threadId: row.gmail_thread_id,
      inputHash,
      threadContextHash: hashString(""),
      quality: extracted.quality,
      answers: null,
      status: "review",
    });
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
  const classificationId = await store(deps, {
    gmailMessageId,
    threadId: row.gmail_thread_id,
    inputHash,
    threadContextHash: normalized.revision.threadContextHash,
    quality: extracted.quality,
    answers: outcome.answers,
    status: outcome.status,
  });
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
  },
): Promise<string> {
  const id = crypto.randomUUID();
  // A message whose tray placement is uncertain is stored as review so it
  // surfaces for a human rather than being filed on a low-confidence verdict.
  const uncertain = input.answers ? placeInTray(input.answers, input.quality).uncertain : true;
  const status = uncertain ? "review" : input.status;

  await deps.db
    .prepare(
      "INSERT INTO classifications (id, account_id, gmail_message_id, gmail_thread_id, input_hash, thread_context_hash, input_quality, model_version, prompt_version, schema_version, answers, status, supersedes_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)",
    )
    .bind(
      id,
      deps.accountId,
      input.gmailMessageId,
      input.threadId,
      input.inputHash,
      input.threadContextHash,
      input.quality,
      "classified",
      1,
      SCHEMA_VERSION,
      JSON.stringify(input.answers ?? emptyAnswers()),
      status,
      Date.now(),
    )
    .run();
  return id;
}
