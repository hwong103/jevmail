// Applies the real schema to the test database. Each test file gets its own
// isolated D1, so every file sets its own schema up.
//
// The Workers test runtime has no filesystem, so the SQL is imported through
// Vite's ?raw suffix. scripts/check-migrations.mjs keeps this file in step with
// the numbered migrations wrangler applies to a real database.

import schemaSql from "../../migrations/0000.sql?raw";

export const TABLES = [
  "audit_log",
  "protected_senders",
  "policy_evaluations",
  "policy_rules",
  "action_attempts",
  "action_intents",
  "outbox",
  "jobs",
  "corrections",
  "classifications",
  "messages",
  "sync_checkpoints",
  "accounts",
  "principals",
] as const;

export function schemaStatements(): string[] {
  return schemaSql
    .split("\n")
    .filter((line: string) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s: string) => s.trim())
    .filter(Boolean)
    // Order matters: a table must exist before an index or foreign key that
    // references it. Sorting alphabetically would break that, so the file's own
    // order is preserved.
    ;
}

export async function applyMigrations(db: D1Database): Promise<void> {
  for (const table of TABLES) {
    await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  }
  for (const statement of schemaStatements()) {
    await db.prepare(statement).run();
  }
}

export async function seedAccount(db: D1Database): Promise<void> {
  await db
    .prepare(
      "INSERT OR IGNORE INTO principals (id, google_sub, email, bound_at, is_owner) VALUES ('p1', 'sub-1', 'a@example.com', 1, 1)",
    )
    .run();
  await db
    .prepare(
      "INSERT OR IGNORE INTO accounts (id, principal_id, gmail_address, granted_scopes, status, created_at) VALUES ('a1', 'p1', 'a@example.com', '[]', 'active', 1)",
    )
    .run();
}

export async function seedMessages(db: D1Database, count = 60): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await db
      .prepare(
        "INSERT INTO messages (id, account_id, gmail_message_id, gmail_thread_id, sender, subject, received_at, label_ids, history_id, is_unread, is_starred, revision, updated_at) VALUES (?, 'a1', ?, ?, 's@example.com', 'subject', ?, '[\"INBOX\"]', 'h', ?, 0, 0, 1)",
      )
      .bind(`m${i}`, `g${i}`, `t${i}`, 1_757_000_000_000 + i, i % 2)
      .run();
  }
}
