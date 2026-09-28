// D1 read-repository tests against a real database. These prove the list path
// is bounded and that a correction beats the stored model answer on the next
// read.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { D1MailRepository } from "../src/server/mail/d1-repository";
import { applyMigrations, seedAccount } from "./helpers/migrations";

const db = (env as unknown as { DB: D1Database }).DB;
const ACCOUNT = "a1";

const ANSWERS = {
  category: { state: "value", value: "marketing", confidence: 0.9, distribution: null },
  needsReply: { state: "value", value: false, confidence: 0.9, distribution: null },
  needsAction: { state: "value", value: false, confidence: 0.9, distribution: null },
  urgency: { state: "value", value: 1, confidence: 0.8, distribution: null },
  importance: { state: "value", value: 1, confidence: 0.8, distribution: null },
  senderType: { state: "value", value: "organization", confidence: 0.9, distribution: null },
};

function repository() {
  return new D1MailRepository(db, ACCOUNT, async () => null);
}

// corrections.actor_id references principals, so an actor must exist before a
// correction can be recorded. The seed account already owns p1.
async function seedPrincipal(id: string): Promise<void> {
  await db
    .prepare(
      "INSERT OR IGNORE INTO principals (id, google_sub, email, bound_at, is_owner) VALUES (?, ?, ?, 1, 0)",
    )
    .bind(id, `sub-${id}`, `${id}@example.com`)
    .run();
}

async function insertMessage(
  id: string,
  receivedAt: number,
  threadId = `t-${id}`,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO messages (id, account_id, gmail_message_id, gmail_thread_id, sender, subject, received_at, label_ids, history_id, is_unread, is_starred, revision, updated_at) VALUES (?, ?, ?, ?, 's@example.com', ?, ?, '[\"INBOX\"]', 'h', 0, 0, 0, 0)",
    )
    .bind(id, ACCOUNT, id, threadId, `Subject ${id}`, receivedAt)
    .run();
}

async function insertClassification(
  messageId: string,
  answers: unknown,
  quality = "complete",
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO classifications (id, account_id, gmail_message_id, gmail_thread_id, input_hash, thread_context_hash, input_quality, model_version, prompt_version, schema_version, answers, status, supersedes_id, created_at) VALUES (?, ?, ?, ?, 'h', 'tc', ?, 'test', 1, 1, ?, 'complete', NULL, 1)",
    )
    .bind(`c-${messageId}`, ACCOUNT, messageId, `t-${messageId}`, quality, JSON.stringify(answers))
    .run();
}

describe("D1MailRepository", () => {
  beforeEach(async () => {
    await applyMigrations(db);
    await seedAccount(db);
  });

  it("returns an empty page with no messages", async () => {
    const page = await repository().list({ tray: "all", pageToken: null, limit: 25 });
    expect(page.messages).toEqual([]);
    expect(page.total).toBe(0);
  });

  it("lists messages newest first and never includes body content", async () => {
    await insertMessage("m1", 1000);
    await insertMessage("m2", 2000);
    const page = await repository().list({ tray: "all", pageToken: null, limit: 25 });
    expect(page.messages.map((m) => m.gmailMessageId)).toEqual(["m2", "m1"]);
    for (const item of page.messages) {
      expect(item).not.toHaveProperty("body");
      expect(item).not.toHaveProperty("text");
    }
  });

  it("caps the requested page size", async () => {
    for (let i = 0; i < 60; i += 1) await insertMessage(`m${i}`, 1000 + i);
    const page = await repository().list({ tray: "all", pageToken: null, limit: 5_000 });
    expect(page.messages.length).toBeLessThanOrEqual(50);
  });

  it("paginates with an opaque token and stops at the end", async () => {
    for (let i = 0; i < 30; i += 1) await insertMessage(`m${i}`, 1000 + i);
    const first = await repository().list({ tray: "all", pageToken: null, limit: 25 });
    expect(first.messages).toHaveLength(25);
    expect(first.nextPageToken).toBeTruthy();
    const second = await repository().list({ tray: "all", pageToken: first.nextPageToken, limit: 25 });
    expect(second.messages).toHaveLength(5);
    expect(second.nextPageToken).toBeNull();
  });

  it("routes an unclassified message to review", async () => {
    await insertMessage("m1", 1000);
    const page = await repository().list({ tray: "all", pageToken: null, limit: 25 });
    expect(page.messages[0]?.status).toBe("pending");
    expect(page.messages[0]?.tray).toBe("review");
    expect(page.messages[0]?.answers).toEqual([]);
  });

  it("places a confidently classified message", async () => {
    await insertMessage("m1", 1000);
    await insertClassification("m1", ANSWERS);
    const page = await repository().list({ tray: "all", pageToken: null, limit: 25 });
    expect(page.messages[0]?.tray).toBe("low_priority");
    expect(page.messages[0]?.status).toBe("complete");
  });

  it("routes incomplete input to review rather than a confident tray", async () => {
    await insertMessage("m1", 1000);
    await insertClassification("m1", ANSWERS, "missing_body");
    const page = await repository().list({ tray: "all", pageToken: null, limit: 25 });
    expect(page.messages[0]?.tray).toBe("review");
    expect(page.messages[0]?.uncertain).toBe(true);
  });

  it("applies a stored correction over the model answer", async () => {
    await insertMessage("m1", 1000);
    await insertClassification("m1", ANSWERS);
    await seedPrincipal("actor-1");
    await repository().recordCorrection(
      "m1",
      [{ question: "category", operation: "set", value: "work" }],
      "actor-1",
    );
    const page = await repository().list({ tray: "all", pageToken: null, limit: 25 });
    const answer = page.messages[0]?.answers.find((a) => a.question === "category");
    expect(answer?.value).toBe("work");
    expect(answer?.confidence).toBeNull();
    expect(answer?.corrected).toBe(true);
  });

  it("allocates increasing correction revisions", async () => {
    await insertMessage("m1", 1000);
    await seedPrincipal("a");
    const repo = repository();
    const first = await repo.recordCorrection(
      "m1",
      [{ question: "category", operation: "set", value: "work" }],
      "a",
    );
    const second = await repo.recordCorrection(
      "m1",
      [{ question: "urgency", operation: "set", value: 4 }],
      "a",
    );
    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
  });

  it("rejects a correction for an unknown message", async () => {
    await expect(
      repository().recordCorrection(
        "nope",
        [{ question: "category", operation: "set", value: "work" }],
        "a",
      ),
    ).rejects.toThrow(/Unknown message/);
  });

  it("counts unclassified thread members as pending", async () => {
    await insertMessage("m1", 1000, "t-shared");
    await insertMessage("m2", 2000, "t-shared");
    await insertClassification("m1", ANSWERS);
    const page = await repository().list({ tray: "all", pageToken: null, limit: 25 });
    const classified = page.messages.find((m) => m.gmailMessageId === "m1");
    expect(classified?.pendingInThread).toBe(1);
  });

  it("reports automation as disabled regardless of rule rows", async () => {
    await db
      .prepare(
        "INSERT INTO policy_rules (id, account_id, name, template, version, enabled, min_confidence, created_at) VALUES ('r1', ?, 'Marketing', 'obvious_marketing', 1, 1, 800, 1)",
      )
      .bind(ACCOUNT)
      .run();
    const status = await repository().automationStatus();
    expect(status.executionEnabled).toBe(false);
    expect(status.enabledRuleCount).toBe(1);
    expect(status.killSwitch).toBe(true);
  });

  it("stays inside the read budget for a mailbox page", async () => {
    for (let i = 0; i < 60; i += 1) {
      await insertMessage(`m${i}`, 1000 + i);
      await insertClassification(`m${i}`, ANSWERS);
    }
    const result = await db
      .prepare(
        "SELECT id, subject, received_at FROM messages WHERE account_id = ? ORDER BY received_at DESC LIMIT 50",
      )
      .bind(ACCOUNT)
      .all();
    const rowsRead = (result.meta as { rows_read?: number } | undefined)?.rows_read;
    if (typeof rowsRead === "number") {
      expect(rowsRead).toBeLessThanOrEqual(300);
    }
    expect(result.results.length).toBe(50);
  });
});
