// Jev provider adapter. Worker B owns this directory.
//
// The request and response shapes here come from Cloudflare's published
// `typesafe/jev` Workers AI binding, not from assumption. Three details in the
// real response drive this file:
//
// 1. `noul` returns a single yes-probability and has NO separate confidence
//    field. That probability is the answer's certainty.
// 2. `choice` returns both a `confidence` and a `probabilities` map. Confidence
//    and the selected option's probability are different numbers and are kept
//    separate, never collapsed into one.
// 3. `score` levels are zero-indexed and may be fractional (the docs show 1.04),
//    so levels are rounded and shifted to the 1..5 range this app uses.
//
// A missing or malformed field becomes an explicit `unknown`. Nothing here
// substitutes a default, and nothing invents a probability of 1.

import {
  CATEGORIES,
  type Category,
  type NormalizedMessage,
  type Rating,
} from "../../contracts/domain";
import type { ClassificationPort, RawClassification } from "./classify";

const SENDER_TYPES = ["person", "organization", "automated", "unknown"] as const;
export type SenderType = (typeof SENDER_TYPES)[number];

const CATEGORY_CRITERIA: Record<Category, string> = {
  personal: "Mail from or to a person the owner knows personally",
  work: "Business, professional, or work-related correspondence",
  transactional: "Automated receipts, invoices, confirmations, and account statements",
  newsletter: "Recurring editorial digests and subscribed publications",
  marketing: "Promotional offers, sales, and advertising",
  cold_outreach: "Unsolicited sales or recruiting contact from a stranger",
  notification: "Automated alerts and activity notifications from a service",
  other: "Does not fit any category above",
};

const SENDER_CRITERIA: Record<SenderType, string> = {
  person: "A human writing to the owner directly",
  organization: "A company or organisation writing in a business capacity",
  automated: "A machine or automated system, with no human author",
  unknown: "The sender type cannot be determined from the message",
};

const RATING_SCALE = ["1 (lowest)", "2", "3 (normal)", "4", "5 (highest)"] as const;

export const PROMPT_VERSION = 1;
export const JEV_MODEL = "typesafe/jev";

export function buildQuestions() {
  return {
    category: {
      type: "choice" as const,
      instructions:
        "Classify this email. Judge the message type, not the relationship: a work message from a colleague is work, and a receipt from a retailer is transactional regardless of who it is from.",
      criteria: CATEGORY_CRITERIA,
    },
    needsReply: {
      type: "noul" as const,
      instructions:
        "Does the sender expect a response from the owner? Routine statements and receipts do not. A direct question, a request, or an item awaiting the owner's decision does.",
      criteria: {
        true: "The owner is being asked for something and should respond",
        false: "No response is expected",
      },
    },
    needsAction: {
      type: "noul" as const,
      instructions:
        "Does the owner need to do something beyond reading? Consider deadlines, required responses, and decisions the owner must make.",
      criteria: {
        true: "The owner must take an action",
        false: "Reading is sufficient",
      },
    },
    urgency: {
      type: "score" as const,
      instructions: "How time-sensitive is this message for the owner right now?",
      criteria: [...RATING_SCALE],
    },
    importance: {
      type: "score" as const,
      instructions:
        "How much does this matter to the owner, independent of how quickly it must be handled?",
      criteria: [...RATING_SCALE],
    },
    senderType: {
      type: "choice" as const,
      instructions: "Who is the sender?",
      criteria: SENDER_CRITERIA,
    },
  } as const;
}

export function buildState(message: NormalizedMessage): Record<string, string> {
  // The body is already normalised and bounded upstream. It is sent here and
  // nowhere else: not stored, not logged, not queued.
  return {
    from: message.sender,
    subject: message.subject,
    received_at: new Date(message.receivedAt).toISOString(),
    body: message.text ?? "",
    input_quality: message.revision.quality,
    thread_message_count: String(message.revision.contextMessageIds.length),
  };
}

/** Minimal Workers AI binding surface used here. */
export interface AiBinding {
  run(model: string, input: unknown): Promise<unknown>;
}

export class JevClassificationPort implements ClassificationPort {
  constructor(private readonly ai: AiBinding) {}

  async classify(message: NormalizedMessage): Promise<RawClassification> {
    const response = await this.ai.run(JEV_MODEL, {
      state: buildState(message),
      questions: buildQuestions(),
    });
    return interpret(response);
  }
}

interface RawAnswer {
  type?: string;
  noul?: unknown;
  choice?: unknown;
  score?: unknown;
  confidence?: unknown;
  probabilities?: unknown;
}

interface RawResponse {
  model?: unknown;
  answers?: unknown;
}

function toNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clamp01(value: number | null): number | null {
  if (value === null) return null;
  return value < 0 || value > 1 ? null : value;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function clampRating(value: number): Rating {
  return Math.min(5, Math.max(1, value)) as Rating;
}

function normalizeProbabilities(value: unknown): { value: string; probability: number }[] | null {
  if (typeof value !== "object" || value === null) return null;
  const entries: { value: string; probability: number }[] = [];
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const probability = toNumber(raw);
    if (probability !== null) entries.push({ value: key, probability });
  }
  return entries.length > 0 ? entries : null;
}

/**
 * Converts the provider response into the flat, raw shape the normaliser
 * expects. This is the only place that knows the provider's wire format.
 */
export function interpret(response: unknown): RawClassification {
  const body = (response ?? {}) as RawResponse;
  const answers = (body.answers ?? {}) as Record<string, RawAnswer>;
  const raw: Record<string, unknown> = {};

  const category = answers.category;
  if (category && category.type === "choice" && typeof category.choice === "string") {
    raw.category = category.choice;
    // A confidence field that is absent is reported as null, meaning "the
    // provider did not state a confidence". It is never filled in.
    raw.categoryConfidence = clamp01(toNumber(category.confidence));
    raw.categoryDistribution = normalizeProbabilities(category.probabilities);
  }

  for (const question of ["needsReply", "needsAction"] as const) {
    const answer = answers[question];
    if (!answer || answer.type !== "noul") continue;
    const probability = toNumber(answer.noul);
    if (probability === null) continue;
    // The noul yes-probability is the only certainty signal, so it is used as
    // the confidence for the derived boolean. That is honest: it is exactly what
    // the provider reported, and no separate number is invented.
    const value = probability >= 0.5;
    raw[question] = value;
    raw[`${question}Confidence`] = round(probability);
    raw[`${question}Distribution`] = [
      { value: "true", probability: round(probability) },
      { value: "false", probability: round(1 - probability) },
    ];
  }

  for (const question of ["urgency", "importance"] as const) {
    const answer = answers[question];
    if (!answer || answer.type !== "score") continue;
    const level = toNumber(answer.score);
    if (level === null) continue;
    // Levels are zero-indexed and may be fractional; this app stores 1..5.
    raw[question] = clampRating(Math.round(level) + 1);
    raw[`${question}Confidence`] = clamp01(toNumber(answer.confidence));
    raw[`${question}Distribution`] = normalizeProbabilities(answer.probabilities);
  }

  const sender = answers.senderType;
  if (sender && sender.type === "choice" && typeof sender.choice === "string") {
    raw.senderType = sender.choice;
    raw.senderTypeConfidence = clamp01(toNumber(sender.confidence));
  }

  return {
    modelVersion: typeof body.model === "string" ? body.model : "jev-unknown",
    promptVersion: PROMPT_VERSION,
    schemaVersion: 1,
    raw,
  };
}

export const JEV_CATEGORIES: readonly Category[] = CATEGORIES;
export const JEV_SENDER_TYPES: readonly SenderType[] = SENDER_TYPES;
