// Classify job handler tests. The behaviour that matters is what happens when
// the world moves underneath a queued job.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createFixturePort } from "../src/server/classification/fixture";
import type { ClassificationPort } from "../src/server/classification/classify";
import { CommandCodeJevPort } from "../src/server/classification/commandcode";
import { JevClassificationPort } from "../src/server/classification/jev";
import type { GmailMessage } from "../src/server/gmail/normalize";
import { handleClassify, type ClassifyDeps } from "../src/server/jobs/classify";
import { classifyDeps } from "../src/server/jobs/consumer";
import { buildClassificationPort } from "../src/server/jobs/deps";
import type { Env } from "../src/runtime/env";
import { textMessage } from "./fixtures/gmail";
import { applyMigrations, seedAccount } from "./helpers/migrations";

const db = (env as unknown as { DB: D1Database }).DB;
const ACCOUNT = "a1";

// A literal `typesafe/jev` response, matching the documented wire shape.
const DOC_RESPONSE = {
  model: "jev-1.13.0",
  answers: {
    needsReply: { type: "noul", noul: 0.95 },
    category: { type: "choice", choice: "work", confidence: 0.8 },
    needsAction: { type: "noul", noul: 0.08 },
    urgency: { type: "score", score: 1.04, confidence: 0.94 },
    importance: { type: "score", score: 0, confidence: 0.5 },
    senderType: { type: "choice", choice: "person", confidence: 0.77 },
  },
};

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

async function inputHashOf(id: string): Promise<string> {
  const row = await db
    .prepare("SELECT input_hash FROM classifications WHERE id = ?")
    .bind(id)
    .first<{ input_hash: string }>();
  if (!row) throw new Error(`no classification ${id}`);
  return row.input_hash;
}

/** A message fixture whose From/Subject headers match its payload. */
function messageWith(subject: string, body: string): GmailMessage {
  const { message, headers } = textMessage({
    id: "m1",
    from: "billing@shop.example",
    subject,
    body,
  });
  return { ...message, payload: { ...(message.payload ?? {}), headers } } as GmailMessage;
}

/** A leased classify job, so the write fence has a lease token to check. */
async function insertLeasedJob(jobId: string, leaseToken: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO jobs (id, account_id, payload, dedupe_key, state, attempts, available_at, lease_token, lease_expires_at, created_at) VALUES (?, ?, ?, ?, 'leased', 1, 0, ?, ?, 0)",
    )
    .bind(
      jobId,
      ACCOUNT,
      JSON.stringify({ kind: "classify", messageId: "m1", expectedMessageRevision: 0 }),
      `${ACCOUNT}:classify:m1:${jobId}`,
      leaseToken,
      Date.now() + 60_000,
    )
    .run();
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

  it("returns a transient provider failure as retryable with no stored row", async () => {
    await insertMessage(0);
    const failingPort: ClassificationPort = {
      classify: () => Promise.reject(new Error("timeout")),
    };
    const result = await handleClassify(deps({ port: failingPort }), "m1", 0, {
      jobId: "j",
      leaseToken: "t",
    });
    // A transient failure is not a classification: nothing is stored, so a
    // later attempt with the same input is not suppressed by a "failed" row.
    expect(result.status).toBe("retryable");
    expect(await classificationCount()).toBe(0);
  });

  it("persists the provider's real model and prompt versions, not literals", async () => {
    await insertMessage(0);
    const versioned: ClassificationPort = {
      async classify() {
        return {
          modelVersion: "jev-9.9.9",
          promptVersion: 7,
          schemaVersion: 1,
          raw: {
            category: "work",
            categoryConfidence: 0.9,
            needsReply: true,
            needsReplyConfidence: 0.9,
            needsAction: false,
            needsActionConfidence: 0.9,
            urgency: 3,
            urgencyConfidence: 0.8,
            importance: 3,
            importanceConfidence: 0.8,
            senderType: "person",
            senderTypeConfidence: 0.9,
          },
        };
      },
    };
    const result = await handleClassify(deps({ port: versioned }), "m1", 0);
    const row = await db
      .prepare("SELECT model_version, prompt_version FROM classifications WHERE id = ?")
      .bind(result.classificationId)
      .first<{ model_version: string; prompt_version: number }>();
    expect(row?.model_version).toBe("jev-9.9.9");
    expect(row?.prompt_version).toBe(7);
  });

  it("classifies with the AI binding and stores the response's model version", async () => {
    await insertMessage(0);
    const port = buildClassificationPort({
      AI: { run: async () => DOC_RESPONSE },
    } as unknown as Env);
    expect(port).not.toBeNull();
    const result = await handleClassify(deps({ port: port as ClassificationPort }), "m1", 0);
    const row = await db
      .prepare("SELECT model_version FROM classifications WHERE id = ?")
      .bind(result.classificationId)
      .first<{ model_version: string }>();
    expect(row?.model_version).toBe("jev-1.13.0");
  });

  it("does not write when the lease is reclaimed mid-classification", async () => {
    await insertMessage(0);
    await insertLeasedJob("jv-lease", "old");
    // Another worker reclaims the lease while the model call is in flight.
    const port: ClassificationPort = {
      async classify(normalized) {
        await db.prepare("UPDATE jobs SET lease_token = 'reclaimed' WHERE id = 'jv-lease'").run();
        return createFixturePort().classify(normalized);
      },
    };
    const result = await handleClassify(deps({ port }), "m1", 0, {
      jobId: "jv-lease",
      leaseToken: "old",
    });
    expect(result.status).toBe("stale");
    expect(await classificationCount()).toBe(0);
  });

  it("does not overwrite a newer revision that lands mid-classification", async () => {
    await insertMessage(0);
    await insertLeasedJob("jv-rev", "live");
    const port: ClassificationPort = {
      async classify(normalized) {
        // A newer revision is classified by another worker while this one runs.
        await db.prepare("UPDATE messages SET revision = 1 WHERE id = 'm1'").run();
        await db
          .prepare(
            "INSERT INTO classifications (id, account_id, gmail_message_id, gmail_thread_id, input_hash, thread_context_hash, input_quality, model_version, prompt_version, schema_version, answers, status, supersedes_id, created_at) VALUES ('newer', ?, 'm1', 't1', 'newer-hash', 'tc', 'complete', 'm', 1, 1, '{}', 'complete', NULL, ?)",
          )
          .bind(ACCOUNT, Date.now())
          .run();
        return createFixturePort().classify(normalized);
      },
    };
    const result = await handleClassify(deps({ port }), "m1", 0, {
      jobId: "jv-rev",
      leaseToken: "live",
    });
    expect(result.status).toBe("stale");
    // The newer row is untouched: still complete, not superseded.
    const rows = await db
      .prepare("SELECT id, input_hash, status FROM classifications")
      .all<{ id: string; input_hash: string; status: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toMatchObject({
      id: "newer",
      input_hash: "newer-hash",
      status: "complete",
    });
  });

  it("returns to A as the current row for an A -> B -> A input sequence", async () => {
    await insertMessage(0);
    const A = messageWith("Your order receipt", "Thanks for your purchase. Your invoice is ready.");
    const B = messageWith("Weekly team update", "Here are the notes from the planning meeting.");

    const first = await handleClassify(deps({ fetchMessage: async () => A }), "m1", 0);
    expect(first.status).toBe("stored");
    const aHash = await inputHashOf(first.classificationId as string);

    await db.prepare("UPDATE messages SET revision = 1 WHERE id = 'm1'").run();
    const second = await handleClassify(deps({ fetchMessage: async () => B }), "m1", 1);
    expect(second.status).toBe("stored");
    expect(await inputHashOf(second.classificationId as string)).not.toBe(aHash);

    // A returns at a new revision. The stale A history must not be reused: A is
    // stored as the current row again.
    await db.prepare("UPDATE messages SET revision = 2 WHERE id = 'm1'").run();
    const third = await handleClassify(deps({ fetchMessage: async () => A }), "m1", 2);
    expect(third.status).toBe("stored");

    const current = await db
      .prepare(
        "SELECT input_hash FROM classifications WHERE account_id = ? AND gmail_message_id = 'm1' AND status NOT IN ('stale', 'failed')",
      )
      .bind(ACCOUNT)
      .all<{ input_hash: string }>();
    expect(current.results).toHaveLength(1);
    expect(current.results[0]?.input_hash).toBe(aHash);
  });
});

describe("provider selection", () => {
  beforeEach(async () => {
    await applyMigrations(db);
    await seedAccount(db);
  });

  it("selects the fixture only on an explicit opt-in, which wins over everything else", () => {
    expect(buildClassificationPort({} as unknown as Env)).toBeNull();
    expect(
      buildClassificationPort({ JEV_PROVIDER: "fixture" } as unknown as Env),
    ).not.toBeNull();
    // An explicit fixture opt-in now wins even when a key or the AI binding is
    // present: it is a deliberate local choice.
    const withFixture = buildClassificationPort({
      AI: { run: async () => ({}) },
      JEV_API_KEY: "k",
      JEV_PROVIDER: "fixture",
    } as unknown as Env);
    expect(withFixture).not.toBeInstanceOf(JevClassificationPort);
    expect(withFixture).not.toBeInstanceOf(CommandCodeJevPort);
  });

  it("prefers a Command Code key over the AI binding, and falls back to AI", () => {
    // A key is an explicit choice, so it wins over the Workers AI binding.
    expect(
      buildClassificationPort({
        AI: { run: async () => ({}) },
        JEV_API_KEY: "k",
      } as unknown as Env),
    ).toBeInstanceOf(CommandCodeJevPort);
    expect(
      buildClassificationPort({ CMD_API_KEY: "k" } as unknown as Env),
    ).toBeInstanceOf(CommandCodeJevPort);
    // With no key, the AI binding is the default.
    expect(
      buildClassificationPort({ AI: { run: async () => ({}) } } as unknown as Env),
    ).toBeInstanceOf(JevClassificationPort);
  });

  it("parks a classify job only when truly unconfigured", async () => {
    // The account exists, but with no AI binding and no Gmail config there is no
    // provider and no fetcher, so the job parks rather than guessing.
    expect(await classifyDeps({ DB: db } as unknown as Env)).toBeNull();
  });
});
