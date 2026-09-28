-- Initial schema. Bodies are never stored: there is deliberately no body,
-- snippet, or extracted-text column anywhere in this file.

CREATE TABLE principals (
  id TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL,
  email TEXT NOT NULL,
  bound_at INTEGER NOT NULL,
  is_owner INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX principals_google_sub_idx ON principals (google_sub);
CREATE INDEX principals_owner_idx ON principals (is_owner);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals (id),
  gmail_address TEXT NOT NULL,
  encrypted_refresh_token TEXT,
  key_version INTEGER,
  granted_scopes TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);
CREATE INDEX accounts_principal_idx ON accounts (principal_id);

CREATE TABLE sync_checkpoints (
  account_id TEXT PRIMARY KEY REFERENCES accounts (id),
  version INTEGER NOT NULL,
  mode TEXT NOT NULL,
  committed_history_id TEXT,
  page_token TEXT,
  scan_id TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX sync_checkpoints_mode_idx ON sync_checkpoints (mode);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id),
  gmail_message_id TEXT NOT NULL,
  gmail_thread_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  subject TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  label_ids TEXT NOT NULL,
  history_id TEXT NOT NULL,
  is_unread INTEGER NOT NULL DEFAULT 0,
  is_starred INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX messages_account_gmail_idx ON messages (account_id, gmail_message_id);
CREATE INDEX messages_account_received_idx ON messages (account_id, received_at);
CREATE INDEX messages_account_thread_idx ON messages (account_id, gmail_thread_id);
CREATE INDEX messages_account_unread_idx ON messages (account_id, is_unread, received_at);

CREATE TABLE classifications (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id),
  gmail_message_id TEXT NOT NULL,
  gmail_thread_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  thread_context_hash TEXT NOT NULL,
  input_quality TEXT NOT NULL,
  model_version TEXT NOT NULL,
  prompt_version INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  answers TEXT NOT NULL,
  status TEXT NOT NULL,
  supersedes_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX classifications_account_created_idx ON classifications (account_id, created_at);
CREATE INDEX classifications_message_idx ON classifications (account_id, gmail_message_id);
CREATE INDEX classifications_status_idx ON classifications (account_id, status);

CREATE TABLE corrections (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id),
  gmail_message_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  changes TEXT NOT NULL,
  observed_input_hash TEXT,
  actor_id TEXT NOT NULL REFERENCES principals (id),
  created_at INTEGER NOT NULL
);
CREATE INDEX corrections_message_revision_idx
  ON corrections (account_id, gmail_message_id, revision);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id),
  payload TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_expires_at INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX jobs_dedupe_idx ON jobs (account_id, dedupe_key);
CREATE INDEX jobs_state_available_idx ON jobs (state, available_at);

CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs (id),
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_expires_at INTEGER,
  published_at INTEGER
);
CREATE INDEX outbox_state_available_idx ON outbox (state, available_at);

CREATE TABLE action_intents (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id),
  kind TEXT NOT NULL,
  origin TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  delta TEXT NOT NULL,
  preconditions TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX action_intents_account_id_idx ON action_intents (account_id, id);
CREATE INDEX action_intents_state_idx ON action_intents (account_id, state);

CREATE TABLE action_attempts (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES action_intents (id),
  message_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  lease_token TEXT NOT NULL,
  state TEXT NOT NULL,
  before TEXT NOT NULL,
  after TEXT,
  actual_delta TEXT,
  outcome TEXT NOT NULL,
  acknowledgement TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  error_code TEXT
);
CREATE UNIQUE INDEX action_attempts_intent_number_idx ON action_attempts (intent_id, number);
CREATE INDEX action_attempts_state_idx ON action_attempts (state, started_at);

CREATE TABLE policy_rules (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id),
  name TEXT NOT NULL,
  template TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 0,
  min_confidence INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX policy_rules_account_enabled_idx ON policy_rules (account_id, enabled);

CREATE TABLE policy_evaluations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id),
  classification_id TEXT NOT NULL REFERENCES classifications (id),
  correction_revision INTEGER NOT NULL,
  rule_id TEXT NOT NULL REFERENCES policy_rules (id),
  rule_version INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  reasons TEXT NOT NULL,
  proposals TEXT NOT NULL,
  evaluated_at INTEGER NOT NULL
);
CREATE INDEX policy_evaluations_account_idx ON policy_evaluations (account_id, evaluated_at);
CREATE INDEX policy_evaluations_classification_idx ON policy_evaluations (classification_id);

CREATE TABLE protected_senders (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id),
  pattern TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX protected_senders_account_idx ON protected_senders (account_id, kind);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id),
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX audit_log_account_idx ON audit_log (account_id, created_at);
