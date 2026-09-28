import { describe, expect, it } from "vitest";
import { extractBody, htmlToText, normalizeMessage } from "../src/server/gmail/normalize";
import { attachmentOnlyMessage, htmlOnlyMessage, textMessage } from "./fixtures/gmail";

describe("body extraction", () => {
  it("prefers text/plain over text/html", () => {
    const { message } = textMessage({
      id: "m1",
      from: "a@example.com",
      subject: "Hello",
      body: "Plain body",
    });
    const result = extractBody(message.payload);
    expect(result.text).toBe("Plain body");
    expect(result.quality).toBe("complete");
  });

  it("converts HTML-only mail instead of rendering nothing", () => {
    const { message } = htmlOnlyMessage({
      id: "m2",
      from: "b@example.com",
      subject: "HTML only",
      html: "<html><body><p>Hello&nbsp;there</p><script>evil()</script></body></html>",
    });
    const result = extractBody(message.payload);
    expect(result.text).toContain("Hello there");
    expect(result.text).not.toContain("evil");
    expect(result.quality).toBe("complete");
  });

  it("marks attachment-only mail as missing body, never as low priority", () => {
    const { message } = attachmentOnlyMessage({
      id: "m3",
      from: "c@example.com",
      subject: "Invoice attached",
      filename: "invoice.pdf",
    });
    const result = extractBody(message.payload);
    expect(result.text).toBeNull();
    expect(result.quality).toBe("missing_body");
  });

  it("flags oversized bodies as truncated", () => {
    const { message } = textMessage({
      id: "m4",
      from: "d@example.com",
      subject: "Huge",
      body: "x".repeat(70 * 1024),
    });
    const result = extractBody(message.payload);
    expect(result.quality).toBe("truncated");
    expect(result.text?.length).toBe(64 * 1024);
  });
});

describe("htmlToText", () => {
  it("does not emit tags or load remote resources", () => {
    const text = htmlToText('<img src="http://tracker.example/pixel.gif"><p>Hi</p>');
    expect(text).not.toContain("<");
    expect(text).not.toContain("http");
    expect(text.trim()).toBe("Hi");
  });
});

describe("normalisation", () => {
  it("produces a stable hash for identical input", () => {
    const { message, headers } = textMessage({
      id: "m5",
      from: "e@example.com",
      subject: "Same",
      body: "Body",
    });
    const a = normalizeMessage({ accountId: "a1", message, headers, threadContextIds: [] });
    const b = normalizeMessage({ accountId: "a1", message, headers, threadContextIds: [] });
    expect(a.revision.inputHash).toBe(b.revision.inputHash);
  });

  it("changes the hash when the body changes", () => {
    const one = textMessage({ id: "m6", from: "f@example.com", subject: "S", body: "A" });
    const two = textMessage({ id: "m6", from: "f@example.com", subject: "S", body: "B" });
    const a = normalizeMessage({ accountId: "a1", message: one.message, headers: one.headers, threadContextIds: [] });
    const b = normalizeMessage({ accountId: "a1", message: two.message, headers: two.headers, threadContextIds: [] });
    expect(a.revision.inputHash).not.toBe(b.revision.inputHash);
  });

  it("changes the context hash when thread context changes", () => {
    const { message, headers } = textMessage({
      id: "m7",
      from: "g@example.com",
      subject: "S",
      body: "B",
    });
    const a = normalizeMessage({ accountId: "a1", message, headers, threadContextIds: ["m7"] });
    const b = normalizeMessage({ accountId: "a1", message, headers, threadContextIds: ["m7", "m8"] });
    expect(a.revision.threadContextHash).not.toBe(b.revision.threadContextHash);
  });
});
