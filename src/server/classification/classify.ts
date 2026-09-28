// Typed classification. Worker B owns this directory.
//
// The provider adapter returns raw, unvalidated output. Normalisation here is
// the only place a malformed answer becomes a typed one, and it never invents
// certainty: a missing distribution stays null, an unknown category becomes an
// explicit `invalid` answer rather than a silent fallback to a default.

import {
  CATEGORIES,
  QUESTIONS,
  type Answer,
  type Answers,
  type Category,
  type NormalizedMessage,
  type Question,
  type Rating,
} from "../../contracts/domain";

export interface RawClassification {
  modelVersion: string;
  promptVersion: number;
  schemaVersion: number;
  raw: Record<string, unknown>;
}

export interface ClassificationPort {
  classify(message: NormalizedMessage): Promise<RawClassification>;
}

export interface ClassifyOutcome {
  answers: Answers;
  status: "complete" | "review" | "failed";
  reasons: string[];
}

function toNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clamp01(value: number | null): number | null {
  if (value === null) return null;
  if (value < 0 || value > 1) return null;
  return value;
}

function parseCategory(raw: Record<string, unknown>): Answer<Category> {
  const value = raw.category;
  if (typeof value !== "string" || !CATEGORIES.includes(value as Category)) {
    return { state: "unknown", reason: "invalid" };
  }
  const confidence = clamp01(toNumber(raw.categoryConfidence));
  const distributionRaw = raw.categoryDistribution;
  const distribution = Array.isArray(distributionRaw)
    ? distributionRaw.flatMap((entry) => {
        if (typeof entry !== "object" || entry === null) return [];
        const candidate = entry as { value?: unknown; probability?: unknown };
        if (
          typeof candidate.value !== "string" ||
          !CATEGORIES.includes(candidate.value as Category)
        ) {
          return [];
        }
        const probability = toNumber(candidate.probability);
        return probability === null ? [] : [{ value: candidate.value as Category, probability }];
      })
    : null;
  return { state: "value", value: value as Category, confidence, distribution };
}

function parseBoolean(question: Question, raw: Record<string, unknown>): Answer<boolean> {
  const value = raw[question];
  if (typeof value !== "boolean") return { state: "unknown", reason: "invalid" };
  return {
    state: "value",
    value,
    confidence: clamp01(toNumber(raw[`${question}Confidence`])),
    distribution: null,
  };
}

function parseRating(question: Question, raw: Record<string, unknown>): Answer<Rating> {
  const value = toNumber(raw[question]);
  if (value === null || value < 1 || value > 5) {
    return { state: "unknown", reason: "invalid" };
  }
  return {
    state: "value",
    value: Math.round(value) as 1 | 2 | 3 | 4 | 5,
    confidence: clamp01(toNumber(raw[`${question}Confidence`])),
    distribution: null,
  };
}

const SENDER_TYPES = ["person", "organization", "automated", "unknown"] as const;

function parseSenderType(raw: Record<string, unknown>): Answers["senderType"] {
  const value = raw.senderType;
  if (value === undefined) return { state: "unknown", reason: "missing" };
  if (typeof value !== "string" || !SENDER_TYPES.includes(value as (typeof SENDER_TYPES)[number])) {
    return { state: "unknown", reason: "invalid" };
  }
  return {
    state: "value",
    value: value as (typeof SENDER_TYPES)[number],
    confidence: clamp01(toNumber(raw.senderTypeConfidence)),
    distribution: null,
  };
}

export function normalizeRaw(raw: RawClassification): ClassifyOutcome {
  const reasons: string[] = [];
  const answers: Answers = {
    category: parseCategory(raw.raw),
    needsReply: parseBoolean("needsReply", raw.raw),
    needsAction: parseBoolean("needsAction", raw.raw),
    urgency: parseRating("urgency", raw.raw),
    importance: parseRating("importance", raw.raw),
    senderType: parseSenderType(raw.raw),
  };

  for (const question of QUESTIONS) {
    if (answers[question].state !== "value") reasons.push(`${question} is not usable.`);
  }

  // Incomplete input can never yield a confident verdict.
  return {
    answers,
    status: reasons.length > 0 ? "review" : "complete",
    reasons,
  };
}

export async function classifyMessage(
  port: ClassificationPort,
  message: NormalizedMessage,
): Promise<ClassifyOutcome> {
  if (message.revision.quality === "missing_body") {
    return {
      answers: emptyAnswers("missing"),
      status: "review",
      reasons: ["Message body unavailable; classification was not attempted."],
    };
  }
  try {
    return normalizeRaw(await port.classify(message));
  } catch (error) {
    return {
      answers: emptyAnswers("provider_error"),
      status: "failed",
      reasons: [`Provider error: ${error instanceof Error ? error.name : "unknown"}`],
    };
  }
}

export function emptyAnswers(reason: "missing" | "provider_error"): Answers {
  const unknown = { state: "unknown", reason } as const;
  return {
    category: unknown,
    needsReply: unknown,
    needsAction: unknown,
    urgency: unknown,
    importance: unknown,
    senderType: unknown,
  } as Answers;
}
