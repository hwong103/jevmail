// Body loader: the read-side path from a stored grant to the frozen
// `MessageBody` DTO. Gmail is mocked at the fetcher boundary, so nothing here
// touches a live account.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { messageBodySchema } from "../src/contracts/dto";
import type { Env } from "../src/runtime/env";
import { selectRepository } from "../src/runtime/repository";
import { extractBody } from "../src/server/gmail/normalize";
import type { GmailMessage, GmailPart } from "../src/server/gmail/normalize";
import { makeBodyLoader, toMessageBody } from "../src/server/jobs/deps";
import { GmailApiError } from "../src/server/gmail/client";
import { attachmentOnlyMessage, textMessage } from "./fixtures/gmail";
import { applyMigrations, seedAccount } from "./helpers/migrations";

const db = (env as unknown as { DB: D1Database }).DB;

function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

describe("toMessageBody", () => {
  it("returns a complete body for a readable message", () => {
    const { message } = textMessage({
      id: "m1",
      from: "a@example.com",
      subject: "Hi",
      body: "Hello there",
    });
    const body = toMessageBody("m1", message);
    expect(messageBodySchema.safeParse(body).success).toBe(true);
    expect(body.quality).toBe("complete");
    expect(body.text).toBe("Hello there");
    expect(body.unavailableReason).toBeNull();
    expect(body.gmailUrl).toContain("mail.google.com");
  });

  it("qualifies a missing body instead of inventing text", () => {
    const { message } = attachmentOnlyMessage({
      id: "m2",
      from: "a@example.com",
      subject: "Invoice attached",
      filename: "invoice.pdf",
    });
    const body = toMessageBody("m2", message);
    expect(body.quality).toBe(extractBody(message.payload).quality);
    expect(body.quality).toBe("missing_body");
    expect(body.text).toBeNull();
    expect(body.unavailableReason).toMatch(/Gmail/);
  });

  it("qualifies an attachment-container-only message instead of using nested text", () => {
    const payload: GmailPart = {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "message/rfc822",
          filename: "forwarded.eml",
          body: { attachmentId: "att-9", size: 4096 },
          parts: [
            { mimeType: "text/plain", body: { data: b64("Nested attachment body"), size: 22 } },
          ],
        },
      ],
    };
    const message: GmailMessage = {
      id: "m3",
      threadId: "t-m3",
      internalDate: "1757000000000",
      payload,
      labelIds: ["INBOX"],
    };
    const body = toMessageBody("m3", message);
    expect(body.quality).toBe(extractBody(payload).quality);
    expect(body.quality).toBe("missing_body");
    expect(body.text).toBeNull();
    expect(body.unavailableReason).toMatch(/Gmail/);
  });
});

describe("makeBodyLoader", () => {
  it("loads a mocked Gmail message through the fetcher", async () => {
    const { message } = textMessage({
      id: "m1",
      from: "a@example.com",
      subject: "Hi",
      body: "Hello there",
    });
    const body = await makeBodyLoader(async () => message)("m1");
    expect(body?.quality).toBe("complete");
    expect(body?.text).toBe("Hello there");
  });

  it("returns null for a message Gmail does not know", async () => {
    expect(await makeBodyLoader(async () => null)("nope")).toBeNull();
  });

  it("maps a definitive Gmail 404 to null, not a fabricated unavailable body", async () => {
    const load = makeBodyLoader(async () => {
      throw new GmailApiError(404, "notFound");
    });
    expect(await load("gone")).toBeNull();
  });

  it("keeps a non-404 Gmail error as unsupported, not a 404", async () => {
    const load = makeBodyLoader(async () => {
      throw new GmailApiError(500, "backendError");
    });
    const body = await load("m1");
    expect(body?.quality).toBe("unsupported");
    expect(body?.text).toBeNull();
  });

  it("degrades to unsupported when the fetch fails, never fabricating a body", async () => {
    const load = makeBodyLoader(async () => {
      throw new Error("reauth required");
    });
    const body = await load("m1");
    expect(body?.quality).toBe("unsupported");
    expect(body?.text).toBeNull();
    expect(body?.unavailableReason).toMatch(/Gmail/);
  });

  it("degrades to unsupported when no fetcher could be built", async () => {
    const body = await makeBodyLoader(null)("m1");
    expect(body?.quality).toBe("unsupported");
    expect(body?.text).toBeNull();
  });
});

describe("selectRepository body wiring", () => {
  beforeEach(async () => {
    await applyMigrations(db);
    await seedAccount(db);
  });

  it("serves a body through the D1 repository using the injected loader", async () => {
    const { message } = textMessage({
      id: "g1",
      from: "a@example.com",
      subject: "Hi",
      body: "Hello there",
    });
    const selected = await selectRepository(env as unknown as Env, () =>
      makeBodyLoader(async () => message),
    );
    expect(selected.source).toBe("d1");
    const body = await selected.repository.body("g1");
    expect(body?.quality).toBe("complete");
    expect(body?.text).toBe("Hello there");
  });
});
