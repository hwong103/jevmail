// Classify job handler tests. The behaviour that matters is what happens when
// the world moves underneath a queued job.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createFixturePort } from "../src/server/classification/fixture";
import type { ClassificationPort } from "../src/server/classification/classify";
import type { GmailMessage } from "../src/server/gmail/normalize";
import { handleClassify, type ClassifyDeps } from "../src/server/jobs/classify";
import { textMessage } from "./fixtures/gmail";
import { applyMigrations, seedAccount } from "./helpers/migrations";

const db = (env as unknown as { DB: D1Database }).DB;
const ACCOUNT = "a1";

async function insertMessage(revision = 0): Promise<void> {
  await db
    .prepare(
      "INSERT INTO messages (id, account_id, gmail_message_id, gmail_thread_id, sender, subject, received_at, label_ids, history_id, is_unread, is_starred, revision, updated_at) VALUES ('m1', ?, 'm1', 't1', 'a@example.com', 'Your order receipt', 1757000000000, '[\"INBOX\"]', 'h', 0, 0, ?, 0)",
    )
    .bind(ACCOUNT, revision)
    .run();
}

async function classificationCount(): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM classifications").first<{ n: number }>();
  return row?.n ?? 0;
}

function deps(overrides: Partial<ClassifyDeps> = {}): ClassifyDeps {
  const { message, headers } = textMessage({
    id: "m1",
    from: "billing@shop.example",
    subject: "Your order receipt",
    body: "Thanks for your purchase. Your invoice is ready.",
  });
  const withHeaders = {
    ...message,
    payload: { ...(message.payload ?? {}), headers },
  } as GmailMessage;
  return {
    db,
    accountId: ACCOUNT,
    port: createFixturePort(),
    fetchMessage: async () => withHeaders,
    ...overrides,
  };
}

describe("handleClassify", () => {
  beforeEach(async () => {
    await applyMigrations(db);
    await seedAccount(db);
  });

  it("stores a classification and never writes the body", async () => {
    await insertMessage(0);
    const result = await handleClassify(deps(), "m1", 0);
    expect(result.status).toBe("stored");
    const row = await db
      .prepare("SELECT answers, input_quality, status FROM classifications WHERE id = ?")
      .bind(result.classificationId)
      .first<{ answers: string; input_quality: string; status: string }>();
    const answers = JSON.parse(row?.answers ?? "{}") as { category?: { value?: string } };
    expect(answers.category?.value).toBe("transactional");
    expect(row?.input_quality).toBe("complete");
    // The body text is nowhere in the classification row.
    expect(row?.answers).not.toContain("Thanks for your purchase");
  });

  it("discards a completion for an input that has since changed", async () => {
    // The message moved to revision 1 after the job was queued at revision 0.
    await insertMessage(1);
    const result = await handleClassify(deps(), "m1", 0);
    expect(result.status).toBe("stale");
    expect(await classificationCount()).toBe(0);
  });

  it("stores a review classification when there is no body", async () => {
    await insertMessage(0);
    const result = await handleClassify(
      deps({
        fetchMessage: async () =>
          ({
            id: "m1",
            threadId: "t1",
            internalDate: "1757000000000",
            labelIds: ["INBOX"],
            payload: { mimeType: "multipart/mixed", parts: [] },
          }) as GmailMessage,
      }),
      "m1",
      0,
    );
    expect(result.status).toBe("no_body");
    const row = await db
      .prepare("SELECT status, input_quality, answers FROM classifications")
      .first<{ status: string; input_quality: string; answers: string }>();
    expect(row?.input_quality).toBe("missing_body");
    expect(row?.status).toBe("review");
    expect(JSON.parse(row?.answers ?? "{}")).toMatchObject({
      category: { state: "unknown", reason: "missing" },
    });
  });

  it("stores a review classification when the model is unsure", async () => {
    await insertMessage(0);
    const unsurePort: ClassificationPort = {
      async classify() {
        return {
          modelVersion: "test",
          promptVersion: 1,
          schemaVersion: 1,
          raw: {
            category: "notification",
            categoryConfidence: 0.1,
            needsReply: false,
            needsReplyConfidence: 0.2,
            needsAction: true,
            needsActionConfidence: 0.15,
            urgency: 5,
            urgencyConfidence: 0.5,
            importance: 5,
            importanceConfidence: 0.5,
            senderType: "automated",
            senderTypeConfidence: 0.4,
          },
        };
      },
    };
    const result = await handleClassify(deps({ port: unsurePort }), "m1", 0);
    const row = await db
      .prepare("SELECT status FROM classifications WHERE id = ?")
      .bind(result.classificationId)
      .first<{ status: string }>();
    expect(row?.status).toBe("review");
  });

  it("skips an unknown message rather than inventing a decision", async () => {
    const result = await handleClassify(deps(), "does-not-exist", 0);
    expect(result.status).toBe("skipped");
    expect(await classificationCount()).toBe(0);
  });

  it("skips when the message cannot be fetched", async () => {
    await insertMessage(0);
    const result = await handleClassify(deps({ fetchMessage: async () => null }), "m1", 0);
    expect(result.status).toBe("skipped");
    expect(await classificationCount()).toBe(0);
  });

  it("records a provider failure as a retryable failure", async () => {
    await insertMessage(0);
    const failingPort: ClassificationPort = {
      classify: () => Promise.reject(new Error("timeout")),
    };
    const result = await handleClassify(deps({ port: failingPort }), "m1", 0);
    const row = await db
      .prepare("SELECT status, answers FROM classifications WHERE id = ?")
      .bind(result.classificationId)
      .first<{ status: string; answers: string }>();
    expect(row?.status).toBe("review");
    expect(JSON.parse(row?.answers ?? "{}")).toMatchObject({
      category: { state: "unknown", reason: "provider_error" },
    });
  });
});
