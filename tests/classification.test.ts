import { describe, expect, it } from "vitest";
import { classifyMessage, normalizeRaw } from "../src/server/classification/classify";
import { createFixturePort } from "../src/server/classification/fixture";
import { normalizeMessage } from "../src/server/gmail/normalize";
import { attachmentOnlyMessage, textMessage } from "./fixtures/gmail";

const port = createFixturePort();

describe("raw normalisation", () => {
  it("keeps an absent confidence absent instead of fabricating 1", () => {
    const outcome = normalizeRaw({
      modelVersion: "test",
      promptVersion: 1,
      schemaVersion: 1,
      raw: { category: "work", needsReply: false, needsAction: false, urgency: 3, importance: 3, senderType: "person" },
    });
    const category = outcome.answers.category;
    expect(category.state).toBe("value");
    expect(category.state === "value" && category.confidence).toBeNull();
  });

  it("marks an invalid category as invalid rather than defaulting", () => {
    const outcome = normalizeRaw({
      modelVersion: "test",
      promptVersion: 1,
      schemaVersion: 1,
      raw: { category: "promotional", needsReply: false, needsAction: false, urgency: 3, importance: 3, senderType: "person" },
    });
    expect(outcome.answers.category).toEqual({ state: "unknown", reason: "invalid" });
    expect(outcome.status).toBe("review");
  });

  it("rejects an out-of-range rating", () => {
    const outcome = normalizeRaw({
      modelVersion: "test",
      promptVersion: 1,
      schemaVersion: 1,
      raw: { category: "work", needsReply: false, needsAction: false, urgency: 9, importance: 3, senderType: "person" },
    });
    expect(outcome.answers.urgency).toEqual({ state: "unknown", reason: "invalid" });
  });
});

describe("classification flow", () => {
  it("does not attempt classification on a missing body", async () => {
    const { message, headers } = attachmentOnlyMessage({
      id: "m1",
      from: "a@example.com",
      subject: "Invoice attached",
      filename: "invoice.pdf",
    });
    const normalized = normalizeMessage({ accountId: "a1", message, headers, threadContextIds: [] });
    const outcome = await classifyMessage(port, normalized);
    expect(outcome.status).toBe("review");
    expect(outcome.answers.category).toEqual({ state: "unknown", reason: "missing" });
  });

  it("classifies a receipt as transactional", async () => {
    const { message, headers } = textMessage({
      id: "m2",
      from: "billing@shop.example",
      subject: "Your order receipt",
      body: "Thanks for your purchase. Your invoice is attached in your account.",
    });
    const normalized = normalizeMessage({ accountId: "a1", message, headers, threadContextIds: [] });
    const outcome = await classifyMessage(port, normalized);
    expect(outcome.status).toBe("complete");
    expect(outcome.answers.category.state === "value" && outcome.answers.category.value).toBe("transactional");
  });

  it("surfaces a provider error as a retryable failure", async () => {
    const failing = {
      async classify() {
        throw new Error("timeout");
      },
    };
    const { message, headers } = textMessage({
      id: "m3",
      from: "a@example.com",
      subject: "Hello",
      body: "Body",
    });
    const normalized = normalizeMessage({ accountId: "a1", message, headers, threadContextIds: [] });
    const outcome = await classifyMessage(failing, normalized);
    expect(outcome.status).toBe("failed");
    expect(outcome.answers.category).toEqual({ state: "unknown", reason: "provider_error" });
  });
});
