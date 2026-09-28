// Frozen domain contracts. The integrator owns this file; nobody else edits it.
//
// Review findings encoded here:
// - Answers carry `confidence: number | null`; absent evidence stays absent.
// - Corrections carry `actorId`, never a caller-supplied role string.
// - Actions target explicit `messageIds`. A thread mutation would hit every
//   message in the thread, including mail no evaluation ever saw.
// - `ActionKind` has no sendDraft and no createDraft.
// - Outcomes include `unknown` and `reconciling` because Gmail and D1 cannot
//   participate in one transaction.

export type Id = string;
export type TimeMs = number;
export type NonEmpty<T> = readonly [T, ...T[]];

export type Category =
  | "personal"
  | "work"
  | "transactional"
  | "newsletter"
  | "marketing"
  | "cold_outreach"
  | "notification"
  | "other";

export type Rating = 1 | 2 | 3 | 4 | 5;

export interface AnswerValues {
  category: Category;
  needsReply: boolean;
  needsAction: boolean;
  urgency: Rating;
  importance: Rating;
  senderType: "person" | "organization" | "automated" | "unknown";
}

export type Question = keyof AnswerValues;

export type Answer<T> =
  | {
      state: "value";
      value: T;
      confidence: number | null;
      distribution: readonly { value: T; probability: number }[] | null;
    }
  | {
      state: "unknown";
      reason: "missing" | "invalid" | "abstained" | "provider_error";
    };

export type Answers = { [Q in Question]: Answer<AnswerValues[Q]> };

export const CATEGORIES: readonly Category[] = [
  "personal",
  "work",
  "transactional",
  "newsletter",
  "marketing",
  "cold_outreach",
  "notification",
  "other",
];

export const QUESTIONS: readonly Question[] = [
  "category",
  "needsReply",
  "needsAction",
  "urgency",
  "importance",
  "senderType",
];

export type InputQuality = "complete" | "truncated" | "missing_body" | "unsupported";

export interface InputRevision {
  inputHash: string;
  threadContextHash: string;
  contextMessageIds: readonly Id[];
  normalizerVersion: number;
  quality: InputQuality;
}

export const NORMALIZER_VERSION = 1;

// TRANSIENT. Never persisted, never logged, never placed on a queue.
// Bodies are fetched at the moment of use and held in memory only.
export interface NormalizedMessage {
  accountId: Id;
  messageId: Id;
  threadId: Id;
  sender: string;
  subject: string;
  receivedAt: TimeMs;
  text: string | null;
  revision: InputRevision;
}

export interface Classification {
  id: Id;
  accountId: Id;
  gmailMessageId: Id;
  gmailThreadId: Id;
  input: InputRevision;
  modelVersion: string;
  promptVersion: number;
  schemaVersion: number;
  answers: Answers;
  status: "complete" | "review" | "failed" | "stale";
  createdAt: TimeMs;
  supersedesId: Id | null;
}

export const SCHEMA_VERSION = 1;

export interface Principal {
  id: Id;
  googleSub: string;
  email: string;
  boundAt: TimeMs;
  isOwner: boolean;
}

export type CorrectionChange = {
  [Q in Question]:
    | { question: Q; operation: "set"; value: AnswerValues[Q] }
    | { question: Q; operation: "clear" }
}[Question];

export interface Correction {
  id: Id;
  accountId: Id;
  gmailMessageId: Id;
  revision: number;
  changes: readonly CorrectionChange[];
  observedInputHash: string | null;
  createdAt: TimeMs;
  actorId: Id;
}

export type EditableLabel =
  | { type: "system"; id: "INBOX" | "UNREAD" | "STARRED" }
  | { type: "user"; id: string };

export interface LabelDelta {
  add: readonly EditableLabel[];
  remove: readonly EditableLabel[];
}

export interface LabelSnapshot {
  messageId: Id;
  threadId: Id;
  // Opaque string. Never a JS number.
  historyId: string;
  labelIds: readonly string[];
}

export interface ActionPrecondition {
  snapshot: LabelSnapshot;
  classificationId: Id | null;
  inputHash: string | null;
  correctionRevision: number;
}

export type ActionOrigin =
  | { type: "manual"; actorId: Id }
  | { type: "simulation"; evaluationId: Id }
  | { type: "undo"; originalIntentId: Id; actorId: Id };

export type ActionOutcome =
  | "pending"
  | "applied"
  | "satisfied_unattributed"
  | "skipped"
  | "failed"
  | "unknown"
  | "reconciling";

export interface ActionAttempt {
  id: Id;
  intentId: Id;
  messageId: Id;
  number: number;
  leaseToken: string;
  state: "prepared" | "calling" | "settled";
  before: LabelSnapshot;
  after: LabelSnapshot | null;
  // What actually changed. The only thing an undo may reverse.
  actualDelta: LabelDelta | null;
  outcome: ActionOutcome;
  acknowledgement: "received" | "not_received";
  startedAt: TimeMs;
  finishedAt: TimeMs | null;
  errorCode: string | null;
}

export const ACTION_KINDS = [
  "archive",
  "markRead",
  "markUnread",
  "star",
  "unstar",
  "labels",
  "undo",
] as const;

export type ActionKind = (typeof ACTION_KINDS)[number];

export interface GmailAction {
  intentId: Id;
  accountId: Id;
  kind: ActionKind;
  origin: ActionOrigin;
  // Explicit targets. Thread-level modification is never used.
  messageIds: NonEmpty<Id>;
  delta: LabelDelta;
  preconditions: NonEmpty<ActionPrecondition>;
  requestHash: string;
  requestedAt: TimeMs;
  expiresAt: TimeMs;
  state:
    | "proposed"
    | "pending"
    | "running"
    | "applied"
    | "partially_applied"
    | "skipped"
    | "failed"
    | "unknown"
    | "reconciling";
  attempts: readonly ActionAttempt[];
}

export interface PolicyEvaluation {
  id: Id;
  accountId: Id;
  classificationId: Id;
  correctionRevision: number;
  ruleId: Id;
  ruleVersion: number;
  // v1 cannot execute. Observe only.
  mode: "observe";
  evaluatedAt: TimeMs;
  outcome: "skipped" | "proposed";
  reasons: readonly string[];
  actions: readonly GmailAction[];
}

export interface Lease {
  token: string;
  expiresAt: TimeMs;
}

export type JobPayload =
  | { kind: "sync"; checkpointVersion: number }
  | { kind: "classify"; messageId: Id; expectedMessageRevision: number }
  | { kind: "evaluate"; classificationId: Id; correctionRevision: number }
  | { kind: "apply"; intentId: Id }
  | { kind: "reconcile_action"; intentId: Id };

export type JobState = "ready" | "leased" | "blocked_auth" | "succeeded" | "dead";

export interface JobRecord {
  id: Id;
  accountId: Id;
  payload: JobPayload;
  dedupeKey: string;
  state: JobState;
  attempts: number;
  availableAt: TimeMs;
  lease: Lease | null;
  lastErrorCode: string | null;
}

export type OutboxState = "pending" | "publishing" | "published";

export interface OutboxRecord {
  id: Id;
  jobId: Id;
  state: OutboxState;
  attempts: number;
  availableAt: TimeMs;
  lease: Lease | null;
  publishedAt: TimeMs | null;
}

// Queue payloads carry IDs only. Never bodies, never headers, never content.
export interface QueueEnvelope {
  version: 1;
  jobId: Id;
}

export type SyncMode = "backfill" | "incremental" | "reconcile";

export interface SyncCheckpoint {
  accountId: Id;
  version: number;
  mode: SyncMode;
  committedHistoryId: string | null;
  pageToken: string | null;
  scanId: Id | null;
}
