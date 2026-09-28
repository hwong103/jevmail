// HTTP DTOs. Worker D consumes these; they are a separate surface from the
// domain types so the client never imports server internals.
//
// Two rules encoded here:
// 1. `body` appears only in a response, never in a list, and is fetched for one
// message at a time. There is no endpoint that returns many bodies.
// 2. Every list row carries its `quality` and `tray` so the UI can show *why*
//    something landed where it did, rather than presenting a bare verdict.

import { z } from "zod";
import type { Category, Question, Tray } from "./ui-types";

export type { Category, Question, Rating, Tray } from "./ui-types";

// Spelled out rather than `AnswerValues[Question]` so the numeric case keeps
// its literal 1..5 constraint instead of widening to `number`.
export type AnswerValue =
  | Category
  | "person"
  | "organization"
  | "automated"
  | "unknown"
  | boolean
  | 1
  | 2
  | 3
  | 4
  | 5;

export interface AnswerDto {
  question: Question;
  state: "value" | "unknown";
  value?: AnswerValue;
  confidence: number | null;
  distribution: readonly { value: string; probability: number }[] | null;
  reason?: "missing" | "invalid" | "abstained" | "provider_error";
  corrected: boolean;
}

export interface MessageListItem {
  gmailMessageId: string;
  gmailThreadId: string;
  sender: string;
  subject: string;
  receivedAt: number;
  labelIds: readonly string[];
  isUnread: boolean;
  isStarred: boolean;
  classificationId: string | null;
  status: "complete" | "review" | "failed" | "stale" | "pending";
  quality: "complete" | "truncated" | "missing_body" | "unsupported" | null;
  tray: Tray;
  trayReasons: readonly string[];
  uncertain: boolean;
  /** Count of sibling messages in the thread that have no classification yet. */
  pendingInThread: number;
  answers: readonly AnswerDto[];
}

export interface MessagePage {
  messages: readonly MessageListItem[];
  nextPageToken: string | null;
  total: number;
  reviewedCount: number;
  classifiedCount: number;
}

export interface MessageBody {
  gmailMessageId: string;
  text: string | null;
  quality: "complete" | "truncated" | "missing_body" | "unsupported";
  /** Present when the body could not be shown inline. Always links to Gmail. */
  unavailableReason: string | null;
  gmailUrl: string;
}

export interface SyncStatus {
  state: "idle" | "syncing" | "error" | "blocked_auth";
  mode: "backfill" | "incremental" | "reconcile" | null;
  processed: number;
  cursorAgeMs: number | null;
  message: string | null;
}

export interface AutomationStatus {
  /** Always false in v1. Surfaced so the UI can state it plainly. */
  executionEnabled: false;
  enabledRuleCount: number;
  totalRuleCount: number;
  proposalCount: number;
  killSwitch: boolean;
}

export interface CorrectionRequest {
  gmailMessageId: string;
  changes: readonly {
    question: Question;
    operation: "set" | "clear";
    value?: AnswerValue;
  }[];
}

export interface CorrectionResponse {
  gmailMessageId: string;
  revision: number;
  appliedAt: number;
  reclassified: boolean;
}

// Runtime schemas. The frozen contract requires validators alongside the types:
// TypeScript cannot check a response that crossed a network boundary.

export const answerValueSchema = z.union([
  z.enum([
    "personal",
    "work",
    "transactional",
    "newsletter",
    "marketing",
    "cold_outreach",
    "notification",
    "other",
    "person",
    "organization",
    "automated",
    "unknown",
  ] as const),
  z.boolean(),
  z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
]) as z.ZodType<AnswerValue>;

export const questionSchema = z.enum([
  "category",
  "needsReply",
  "needsAction",
  "urgency",
  "importance",
  "senderType",
]);

export const answerDtoSchema = z.object({
  question: questionSchema,
  state: z.enum(["value", "unknown"]),
  value: answerValueSchema.optional(),
  confidence: z.number().min(0).max(1).nullable(),
  distribution: z
    .array(z.object({ value: z.string(), probability: z.number() }))
    .nullable(),
  reason: z.enum(["missing", "invalid", "abstained", "provider_error"]).optional(),
  corrected: z.boolean(),
});

export const messageListItemSchema = z.object({
  gmailMessageId: z.string(),
  gmailThreadId: z.string(),
  sender: z.string(),
  subject: z.string(),
  receivedAt: z.number(),
  labelIds: z.array(z.string()),
  isUnread: z.boolean(),
  isStarred: z.boolean(),
  classificationId: z.string().nullable(),
  status: z.enum(["complete", "review", "failed", "stale", "pending"]),
  quality: z.enum(["complete", "truncated", "missing_body", "unsupported"]).nullable(),
  tray: z.enum(["needs_reply", "action", "review", "updates", "low_priority"]),
  trayReasons: z.array(z.string()),
  uncertain: z.boolean(),
  pendingInThread: z.number().int().min(0),
  answers: z.array(answerDtoSchema),
});

export const messagePageSchema = z.object({
  messages: z.array(messageListItemSchema),
  nextPageToken: z.string().nullable(),
  total: z.number().int().min(0),
  reviewedCount: z.number().int().min(0),
  classifiedCount: z.number().int().min(0),
});

export const messageBodySchema = z.object({
  gmailMessageId: z.string(),
  text: z.string().nullable(),
  quality: z.enum(["complete", "truncated", "missing_body", "unsupported"]),
  unavailableReason: z.string().nullable(),
  gmailUrl: z.string(),
});

export const automationStatusSchema = z.object({
  executionEnabled: z.literal(false),
  enabledRuleCount: z.number().int().min(0),
  totalRuleCount: z.number().int().min(0),
  proposalCount: z.number().int().min(0),
  killSwitch: z.boolean(),
});

export const syncStatusSchema = z.object({
  state: z.enum(["idle", "syncing", "error", "blocked_auth"]),
  mode: z.enum(["backfill", "incremental", "reconcile"]).nullable(),
  processed: z.number().int().min(0),
  cursorAgeMs: z.number().nullable(),
  message: z.string().nullable(),
});
