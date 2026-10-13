import { describe, expect, it } from "vitest";
import { extractBody, htmlToText, normalizeMessage } from "../src/server/gmail/normalize";
import type { GmailPart } from "../src/server/gmail/normalize";
import { attachmentOnlyMessage, htmlOnlyMessage, textMessage } from "./fixtures/gmail";

function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

/** A multipart/mixed message whose first text leaf is a *text attachment*. */
function mixedWithTextAttachment(): GmailPart {
  return {
    mimeType: "multipart/mixed",
    parts: [
      {
        mimeType: "text/plain",
        filename: "notes.txt",
        body: { data: b64("ATTACHMENT CONTENT"), size: 18 },
      },
      { mimeType: "text/plain", body: { data: b64("Real message body"), size: 17 } },
      {
        mimeType: "application/pdf",
        filename: "invoice.pdf",
        body: { attachmentId: "att-1", size: 2048 },
      },
    ],
  };
}

/** Two competing text/plain leaves: no single unambiguous body. */
function twoPlainBodies(): GmailPart {
  return {
    mimeType: "multipart/mixed",
    parts: [
      { mimeType: "text/plain", body: { data: b64("first candidate"), size: 15 } },
      { mimeType: "text/plain", body: { data: b64("second candidate"), size: 16 } },
    ],
  };
}

/** A normal multipart/alternative: the plain-text branch is the body. */
function multipartAlternative(): GmailPart {
  return {
    mimeType: "multipart/alternative",
    parts: [
      { mimeType: "text/plain", body: { data: b64("Plain version"), size: 13 } },
      { mimeType: "text/html", body: { data: b64("<p>HTML version</p>"), size: 19 } },
    ],
  };
}

/**
 * A forwarded message carried as an attached `multipart/mixed` container whose
 * only content is a nested plain-text child. Not the outer message's body.
 */
function attachedMixedContainer(): GmailPart {
  return {
    mimeType: "multipart/mixed",
    parts: [
      {
        mimeType: "multipart/mixed",
        filename: "forwarded.eml",
        body: { attachmentId: "att-2", size: 4096 },
        parts: [
          { mimeType: "text/plain", body: { data: b64("Nested attachment body"), size: 22 } },
        ],
      },
      {
        mimeType: "application/pdf",
        filename: "invoice.pdf",
        body: { attachmentId: "att-1", size: 2048 },
      },
    ],
  };
}

/** A message whose payload is the *attached* message/rfc822 itself. */
function encapsulatedRfc822Attachment(): GmailPart {
  return {
    mimeType: "message/rfc822",
    filename: "Fwd - hello.eml",
    headers: [
      {
        name: "Content-Disposition",
        value: 'attachment; filename="Fwd - hello.eml"',
      },
    ],
    parts: [
      { mimeType: "text/plain", body: { data: b64("Inner attachment text"), size: 21 } },
    ],
  };
}

/** An inline encapsulated message/rfc822 with no attachment markers. */
function inlineRfc822(): GmailPart {
  return {
    mimeType: "message/rfc822",
    parts: [
      { mimeType: "text/plain", body: { data: b64("Inner message text"), size: 18 } },
    ],
  };
}

/** A real text body alongside an attached container that also has a text child. */
function bodyPlusAttachedContainer(): GmailPart {
  return {
    mimeType: "multipart/mixed",
    parts: [
      { mimeType: "text/plain", body: { data: b64("Real message body"), size: 17 } },
      {
        mimeType: "multipart/mixed",
        filename: "attachment.eml",
        body: { attachmentId: "att-3", size: 1024 },
        parts: [
          { mimeType: "text/plain", body: { data: b64("Nested body"), size: 11 } },
        ],
      },
    ],
  };
}

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

  it("selects the body, not a text/plain attachment that appears first", () => {
    const result = extractBody(mixedWithTextAttachment());
    expect(result.text).toBe("Real message body");
    expect(result.text).not.toContain("ATTACHMENT CONTENT");
    // One legitimate body part, chosen correctly, so the read is complete.
    expect(result.quality).toBe("complete");
  });

  it("does not claim a complete body when there are several candidates", () => {
    const result = extractBody(twoPlainBodies());
    // The body is ambiguous, so it is never reported as `complete`.
    expect(result.quality).not.toBe("complete");
    expect(result.quality).toBe("truncated");
  });

  it("resolves a normal multipart/alternative to the plain-text body", () => {
    const result = extractBody(multipartAlternative());
    expect(result.text).toBe("Plain version");
    expect(result.quality).toBe("complete");
  });

  it("never surfaces text from an attached multipart container", () => {
    const result = extractBody(attachedMixedContainer());
    // Only attachments here, so there is no body of the message's own.
    expect(result.text).toBeNull();
    expect(result.quality).toBe("missing_body");
  });

  it("never surfaces text from an encapsulated message/rfc822 attachment", () => {
    const result = extractBody(encapsulatedRfc822Attachment());
    expect(result.text).toBeNull();
    expect(result.quality).toBe("missing_body");
  });

  it("never surfaces text from an inline encapsulated message/rfc822", () => {
    const result = extractBody(inlineRfc822());
    expect(result.text).toBeNull();
    expect(result.quality).toBe("missing_body");
  });

  it("keeps the real body and ignores an attached container's nested text", () => {
    const result = extractBody(bodyPlusAttachedContainer());
    expect(result.text).toBe("Real message body");
    expect(result.text).not.toContain("Nested body");
    // One non-attachment body part remains, so the read is complete.
    expect(result.quality).toBe("complete");
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
