// Read-side API and DTO contract tests. These prove the shape the PWA depends
// on, including the properties that keep mail content out of the client.

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  answerDtoSchema,
  messageBodySchema,
  messagePageSchema,
} from "../src/contracts/dto";
import { FixtureMailRepository } from "../src/server/mail/fixtures";
import { PAGE_SIZE_CAP } from "../src/server/mail/repository";

const repo = new FixtureMailRepository();

describe("list endpoint", () => {
  it("returns a page matching the DTO schema", async () => {
    const page = await repo.list({ tray: "all", pageToken: null, limit: 25 });
    expect(messagePageSchema.safeParse(page).success).toBe(true);
  });

  it("caps the page size", async () => {
    const page = await repo.list({ tray: "all", pageToken: null, limit: 5_000 });
    expect(page.messages.length).toBeLessThanOrEqual(PAGE_SIZE_CAP);
  });

  it("never returns a body field in a list row", async () => {
    const page = await repo.list({ tray: "all", pageToken: null, limit: 25 });
    for (const item of page.messages) {
      expect(item).not.toHaveProperty("body");
      expect(item).not.toHaveProperty("text");
      expect(item).not.toHaveProperty("snippet");
    }
  });

  it("routes missing-body and low-confidence mail to review", async () => {
    const review = await repo.list({ tray: "review", pageToken: null, limit: 25 });
    const ids = review.messages.map((m) => m.gmailMessageId);
    expect(ids).toContain("g-attachment-1");
    expect(ids).toContain("g-ambiguous-1");
    for (const item of review.messages) expect(item.uncertain).toBe(true);
  });

  it("surfaces a pending count for a thread with a new reply", async () => {
    const reply = await repo.list({ tray: "needs_reply", pageToken: null, limit: 25 });
    const work = reply.messages.find((m) => m.gmailMessageId === "g-work-1");
    expect(work?.pendingInThread).toBe(1);
  });
});

describe("body endpoint", () => {
  it("returns one body at a time, with a Gmail fallback link", async () => {
    const body = await repo.body("g-receipt-1");
    expect(messageBodySchema.safeParse(body).success).toBe(true);
    expect(body?.gmailUrl).toContain("mail.google.com");
  });

  it("explains an unavailable body instead of returning empty text", async () => {
    const body = await repo.body("g-attachment-1");
    expect(body?.text).toBeNull();
    expect(body?.unavailableReason).toMatch(/Gmail/);
  });

  it("returns null for an unknown message", async () => {
    expect(await repo.body("does-not-exist")).toBeNull();
  });
});

describe("corrections", () => {
  it("records an owner correction with no fabricated confidence", async () => {
    const result = await repo.recordCorrection(
      "g-receipt-1",
      [{ question: "category", operation: "set", value: "work" }],
      "actor-1",
    );
    expect(result.revision).toBeGreaterThan(0);
    const page = await repo.list({ tray: "all", pageToken: null, limit: 25 });
    const item = page.messages.find((m) => m.gmailMessageId === "g-receipt-1");
    const answer = item?.answers.find((a) => a.question === "category");
    expect(answer?.value).toBe("work");
    expect(answer?.confidence).toBeNull();
    expect(answer?.corrected).toBe(true);
  });

  it("rejects an unknown message rather than silently succeeding", async () => {
    await expect(
      repo.recordCorrection(
        "nope",
        [{ question: "category", operation: "set", value: "work" }],
        "a",
      ),
    ).rejects.toThrow();
  });

  it("keeps the correction on a later read", async () => {
    // Regression: the Worker originally built a fresh repository per request, so
    // a correction was acknowledged and then silently discarded on the next
    // read. The repository must outlive the request.
    const shared = new FixtureMailRepository();
    await shared.recordCorrection(
      "g-newsletter-1",
      [{ question: "category", operation: "set", value: "notification" }],
      "actor-1",
    );
    const page = await shared.list({ tray: "all", pageToken: null, limit: 25 });
    const item = page.messages.find((m) => m.gmailMessageId === "g-newsletter-1");
    const answer = item?.answers.find((a) => a.question === "category");
    expect(answer?.value).toBe("notification");
    expect(answer?.corrected).toBe(true);
  });
});

describe("routing over HTTP", () => {
  it("does not re-instantiate the repository per request", async () => {
    const post = await SELF.fetch(
      "https://worker.local/api/messages/g-newsletter-1/corrections",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          changes: [{ question: "category", operation: "set", value: "notification" }],
        }),
      },
    );
    expect(post.status).toBe(200);
    const listed = await SELF.fetch("https://worker.local/api/messages?tray=all");
    const page = messagePageSchema.parse(await listed.json());
    const item = page.messages.find((m) => m.gmailMessageId === "g-newsletter-1");
    const answer = item?.answers.find((a) => a.question === "category");
    expect(answer?.value).toBe("notification");
    expect(answer?.confidence).toBeNull();
  });
});

describe("DTO schemas reject malformed answers", () => {
  it("rejects a confidence outside 0..1", () => {
    const result = answerDtoSchema.safeParse({
      question: "category",
      state: "value",
      value: "work",
      confidence: 1.4,
      distribution: null,
      corrected: false,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown question", () => {
    const result = answerDtoSchema.safeParse({
      question: "vibes",
      state: "value",
      value: "good",
      confidence: null,
      distribution: null,
      corrected: false,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a rating outside 1..5", () => {
    const result = answerDtoSchema.safeParse({
      question: "urgency",
      state: "value",
      value: 9,
      confidence: null,
      distribution: null,
      corrected: false,
    });
    expect(result.success).toBe(false);
  });
});

describe("routing over HTTP", () => {
  it("serves a message list", async () => {
    const response = await SELF.fetch("https://worker.local/api/messages?tray=review");
    expect(response.status).toBe(200);
    const page = messagePageSchema.parse(await response.json());
    expect(page.messages.length).toBeGreaterThan(0);
  });

  it("marks body responses no-store", async () => {
    const response = await SELF.fetch("https://worker.local/api/messages/g-receipt-1/body");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("404s an unknown body", async () => {
    const response = await SELF.fetch("https://worker.local/api/messages/nope/body");
    expect(response.status).toBe(404);
  });

  it("reports automation as disabled", async () => {
    const response = await SELF.fetch("https://worker.local/api/automation");
    const body = (await response.json()) as { executionEnabled: boolean };
    expect(body.executionEnabled).toBe(false);
  });

  it("rejects a correction with an invalid value", async () => {
    const response = await SELF.fetch(
      "https://worker.local/api/messages/g-receipt-1/corrections",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changes: [{ question: "urgency", operation: "set", value: 42 }] }),
      },
    );
    expect(response.status).toBe(400);
  });

  it("never serves a mutation endpoint", async () => {
    for (const path of ["/api/actions", "/api/archive", "/api/send"]) {
      const response = await SELF.fetch(`https://worker.local${path}`, { method: "POST" });
      expect(response.status).toBe(404);
    }
  });
});
