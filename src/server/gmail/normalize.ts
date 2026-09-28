// Gmail payload normalisation. Worker A owns this directory.
//
// The reader and the classifier share one extraction path, so what the owner
// reads and what the model sees cannot silently diverge. Three failure modes
// from review are handled explicitly rather than left to the caller:
// HTML-only mail, nested MIME, and attachment-only or oversized bodies.

import {
  NORMALIZER_VERSION,
  type InputQuality,
  type NormalizedMessage,
} from "../../contracts/domain";

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailPart {
  mimeType: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { attachmentId?: string; data?: string; size?: number };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  internalDate?: string;
  payload?: GmailPart;
  labelIds?: string[];
}

export const MAX_TEXT_BYTES = 64 * 1024;

export interface ExtractedBody {
  text: string | null;
  quality: InputQuality;
}

function decodeBase64Url(data: string): Uint8Array {
  const padded = data.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function decodeBody(part: GmailPart): string | null {
  const data = part.body?.data;
  if (!data) return null;
  try {
    return new TextDecoder("utf-8").decode(decodeBase64Url(data));
  } catch {
    return null;
  }
}

/** Strip tags without ever loading remote resources. Never returns HTML. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Walks MIME parts depth-first, preferring text/plain. Attachment bodies behind
 * an attachmentId are deliberately not downloaded: that is a user-attachment
 * fetch, out of scope for classification.
 */
export function extractBody(payload: GmailPart | undefined): ExtractedBody {
  if (!payload) return { text: null, quality: "missing_body" };

  let plain: string | null = null;
  let html: string | null = null;
  let sawAttachment = false;
  let totalBytes = 0;

  const walk = (part: GmailPart): void => {
    totalBytes += part.body?.size ?? 0;
    if (part.filename || part.body?.attachmentId) sawAttachment = true;
    if (part.mimeType === "text/plain" && part.body?.data) {
      plain ??= decodeBody(part);
    } else if (part.mimeType === "text/html" && part.body?.data) {
      html ??= decodeBody(part);
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);

  const chosen = plain ?? (html ? htmlToText(html) : null);
  if (!chosen || chosen.trim().length === 0) {
    return { text: null, quality: "missing_body" };
  }

  const truncated = chosen.length > MAX_TEXT_BYTES;
  return {
    text: truncated ? chosen.slice(0, MAX_TEXT_BYTES) : chosen,
    quality: truncated ? "truncated" : "complete",
  };
}

export function headerValue(headers: readonly GmailHeader[], name: string): string {
  const match = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return match?.value ?? "";
}

export interface NormalizeInput {
  accountId: string;
  message: GmailMessage;
  headers: readonly GmailHeader[];
  threadContextIds: readonly string[];
}

export function normalizeMessage(input: NormalizeInput): NormalizedMessage {
  const { message } = input;
  const body = extractBody(message.payload);
  const receivedAt = message.internalDate ? Number(message.internalDate) : 0;
  const sender = headerValue(input.headers, "From");
  const subject = headerValue(input.headers, "Subject");

  const inputHashSource = [
    NORMALIZER_VERSION,
    sender,
    subject,
    String(receivedAt),
    body.quality,
    body.text ?? "",
  ].join("\u0000");

  return {
    accountId: input.accountId,
    messageId: message.id,
    threadId: message.threadId,
    sender,
    subject,
    receivedAt,
    text: body.text,
    revision: {
      inputHash: hashString(inputHashSource),
      threadContextHash: hashString(input.threadContextIds.join("\u0000")),
      contextMessageIds: [...input.threadContextIds],
      normalizerVersion: NORMALIZER_VERSION,
      quality: body.quality,
    },
  };
}

/** FNV-1a. Deterministic and dependency-free; the property that matters is
 * that an unchanged input always yields an unchanged hash. */
export function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
