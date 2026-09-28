// D1 schema. The integrator owns this file and every migration.
//
// Index rules, per the repository's billed-resource guidance:
// - Every foreign key access path is indexed explicitly; CREATE TABLE does not
//   do this for us.
// - Composite indexes combine the account/filter columns with the ORDER BY
//   column so the index also serves the sort.
// - Query-plan assertions (tests/integration/query-plan.test.ts) require
//   `USING INDEX` or `USING COVERING INDEX` and reject a SCAN of a hot table.

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const principals = sqliteTable(
  "principals",
  {
    id: text("id").primaryKey(),
    googleSub: text("google_sub").notNull(),
    email: text("email").notNull(),
    boundAt: integer("bound_at").notNull(),
    isOwner: integer("is_owner", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [
    uniqueIndex("principals_google_sub_idx").on(t.googleSub),
    // At most one owner row. Enforced by a partial unique index in migration 0002.
    index("principals_owner_idx").on(t.isOwner),
  ],
);

export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    principalId: text("principal_id")
      .notNull()
      .references(() => principals.id),
    gmailAddress: text("gmail_address").notNull(),
    // Encrypted at rest. Never returned to a browser.
    encryptedRefreshToken: text("encrypted_refresh_token"),
    // AES-GCM's initialisation vector. Required to decrypt, so it is stored
    // beside the ciphertext rather than being packed into it.
    credentialIv: text("credential_iv"),
    keyVersion: integer("key_version"),
    grantedScopes: text("granted_scopes", { mode: "json" })
      .$type<string[]>()
      .notNull(),
    status: text("status", { enum: ["active", "reauth_required"] })
      .$type<"active" | "reauth_required">()
      .notNull()
      .default("active"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("accounts_principal_idx").on(t.principalId)],
);

export const syncCheckpoints = sqliteTable(
  "sync_checkpoints",
  {
    accountId: text("account_id")
      .primaryKey()
      .references(() => accounts.id),
    version: integer("version").notNull(),
    mode: text("mode", { enum: ["backfill", "incremental", "reconcile"] })
      .$type<"backfill" | "incremental" | "reconcile">()
      .notNull(),
    committedHistoryId: text("committed_history_id"),
    pageToken: text("page_token"),
    scanId: text("scan_id"),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("sync_checkpoints_mode_idx").on(t.mode)],
);

// Message metadata only. No body, no snippet, no extracted text column exists
// in this table by design; bodies are fetched on demand and never persisted.
export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    gmailMessageId: text("gmail_message_id").notNull(),
    gmailThreadId: text("gmail_thread_id").notNull(),
    sender: text("sender").notNull(),
    subject: text("subject").notNull(),
    receivedAt: integer("received_at").notNull(),
    labelIds: text("label_ids", { mode: "json" }).$type<string[]>().notNull(),
    historyId: text("history_id").notNull(),
    isUnread: integer("is_unread", { mode: "boolean" }).notNull().default(false),
    isStarred: integer("is_starred", { mode: "boolean" }).notNull().default(false),
    // Bumped whenever the classification-relevant input changes.
    revision: integer("revision").notNull().default(0),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("messages_account_gmail_idx").on(t.accountId, t.gmailMessageId),
    // Serves the tray query: filter by account, order by recency.
    index("messages_account_received_idx").on(t.accountId, t.receivedAt),
    index("messages_account_thread_idx").on(t.accountId, t.gmailThreadId),
    index("messages_account_unread_idx").on(t.accountId, t.isUnread, t.receivedAt),
  ],
);

export const classifications = sqliteTable(
  "classifications",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    gmailMessageId: text("gmail_message_id").notNull(),
    gmailThreadId: text("gmail_thread_id").notNull(),
    inputHash: text("input_hash").notNull(),
    threadContextHash: text("thread_context_hash").notNull(),
    inputQuality: text("input_quality").notNull(),
    modelVersion: text("model_version").notNull(),
    promptVersion: integer("prompt_version").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    answers: text("answers", { mode: "json" }).$type<unknown>().notNull(),
    status: text("status", { enum: ["complete", "review", "failed", "stale"] })
      .$type<"complete" | "review" | "failed" | "stale">()
      .notNull(),
    supersedesId: text("supersedes_id"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("classifications_account_created_idx").on(t.accountId, t.createdAt),
    index("classifications_message_idx").on(t.accountId, t.gmailMessageId),
    // One live classification per message. Partial unique index in migration 0002.
    index("classifications_status_idx").on(t.accountId, t.status),
  ],
);

export const corrections = sqliteTable(
  "corrections",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    gmailMessageId: text("gmail_message_id").notNull(),
    revision: integer("revision").notNull(),
    changes: text("changes", { mode: "json" }).$type<unknown>().notNull(),
    observedInputHash: text("observed_input_hash"),
    actorId: text("actor_id")
      .notNull()
      .references(() => principals.id),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    // Compare-and-set allocation reads the current max here.
    index("corrections_message_revision_idx").on(t.accountId, t.gmailMessageId, t.revision),
  ],
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    payload: text("payload", { mode: "json" }).$type<unknown>().notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    state: text("state", {
      enum: ["ready", "leased", "blocked_auth", "succeeded", "dead"],
    })
      .$type<"ready" | "leased" | "blocked_auth" | "succeeded" | "dead">()
      .notNull(),
    attempts: integer("attempts").notNull().default(0),
    availableAt: integer("available_at").notNull(),
    leaseToken: text("lease_token"),
    leaseExpiresAt: integer("lease_expires_at"),
    lastErrorCode: text("last_error_code"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("jobs_dedupe_idx").on(t.accountId, t.dedupeKey),
    // Outbox publisher and lease recovery both poll by (state, availableAt).
    index("jobs_state_available_idx").on(t.state, t.availableAt),
  ],
);

export const outbox = sqliteTable(
  "outbox",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id),
    state: text("state", { enum: ["pending", "publishing", "published"] })
      .$type<"pending" | "publishing" | "published">()
      .notNull(),
    attempts: integer("attempts").notNull().default(0),
    availableAt: integer("available_at").notNull(),
    leaseToken: text("lease_token"),
    leaseExpiresAt: integer("lease_expires_at"),
    publishedAt: integer("published_at"),
  },
  (t) => [index("outbox_state_available_idx").on(t.state, t.availableAt)],
);

export const actionIntents = sqliteTable(
  "action_intents",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    kind: text("kind").notNull(),
    origin: text("origin", { mode: "json" }).$type<unknown>().notNull(),
    requestHash: text("request_hash").notNull(),
    state: text("state").notNull(),
    delta: text("delta", { mode: "json" }).$type<unknown>().notNull(),
    preconditions: text("preconditions", { mode: "json" }).$type<unknown>().notNull(),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    // Deduplication key: one logical action per (account, intent).
    uniqueIndex("action_intents_account_id_idx").on(t.accountId, t.id),
    index("action_intents_state_idx").on(t.accountId, t.state),
  ],
);

export const actionAttempts = sqliteTable(
  "action_attempts",
  {
    id: text("id").primaryKey(),
    intentId: text("intent_id")
      .notNull()
      .references(() => actionIntents.id),
    messageId: text("message_id").notNull(),
    number: integer("number").notNull(),
    leaseToken: text("lease_token").notNull(),
    state: text("state", { enum: ["prepared", "calling", "settled"] })
      .$type<"prepared" | "calling" | "settled">()
      .notNull(),
    before: text("before", { mode: "json" }).$type<unknown>().notNull(),
    after: text("after", { mode: "json" }).$type<unknown>(),
    actualDelta: text("actual_delta", { mode: "json" }).$type<unknown>(),
    outcome: text("outcome").notNull(),
    acknowledgement: text("acknowledgement", { enum: ["received", "not_received"] })
      .$type<"received" | "not_received">()
      .notNull(),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
    errorCode: text("error_code"),
  },
  (t) => [
    uniqueIndex("action_attempts_intent_number_idx").on(t.intentId, t.number),
    // Recovery scans for attempts stranded in `calling` past their lease.
    index("action_attempts_state_idx").on(t.state, t.startedAt),
  ],
);

export const policyRules = sqliteTable(
  "policy_rules",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    name: text("name").notNull(),
    template: text("template").notNull(),
    version: integer("version").notNull().default(1),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    minConfidence: integer("min_confidence").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("policy_rules_account_enabled_idx").on(t.accountId, t.enabled)],
);

export const policyEvaluations = sqliteTable(
  "policy_evaluations",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    classificationId: text("classification_id")
      .notNull()
      .references(() => classifications.id),
    correctionRevision: integer("correction_revision").notNull(),
    ruleId: text("rule_id")
      .notNull()
      .references(() => policyRules.id),
    ruleVersion: integer("rule_version").notNull(),
    outcome: text("outcome", { enum: ["skipped", "proposed"] })
      .$type<"skipped" | "proposed">()
      .notNull(),
    reasons: text("reasons", { mode: "json" }).$type<string[]>().notNull(),
    proposals: text("proposals", { mode: "json" }).$type<unknown[]>().notNull(),
    evaluatedAt: integer("evaluated_at").notNull(),
  },
  (t) => [
    index("policy_evaluations_account_idx").on(t.accountId, t.evaluatedAt),
    index("policy_evaluations_classification_idx").on(t.classificationId),
  ],
);

export const protectedSenders = sqliteTable(
  "protected_senders",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    pattern: text("pattern").notNull(),
    kind: text("kind", { enum: ["email", "domain"] })
      .$type<"email" | "domain">()
      .notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("protected_senders_account_idx").on(t.accountId, t.kind)],
);

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    kind: text("kind").notNull(),
    subject: text("subject").notNull(),
    detail: text("detail", { mode: "json" }).$type<unknown>(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("audit_log_account_idx").on(t.accountId, t.createdAt)],
);
