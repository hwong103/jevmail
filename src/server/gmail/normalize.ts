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

function contentDisposition(part: GmailPart): string {
  const header = part.headers?.find(
    (h) => h.name.toLowerCase() === "content-disposition",
  );
  return (header?.value ?? "").trim().toLowerCase();
}

/**
 * A leaf is an attachment when it is named, carries an attachment id, or says so
 * in its Content-Disposition. Its bytes are never treated as the message body,
 * so a `text/plain` *attachment* cannot be mistaken for the body text.
 */
function isAttachmentLike(part: GmailPart): boolean {
  return (
    Boolean(part.filename) ||
    Boolean(part.body?.attachmentId) ||
    contentDisposition(part).startsWith("attachment")
  );
}

/**
 * An encapsulated message (`message/rfc822` and friends) is a whole nested
 * message, not this message's own body. Its parsed children must never surface
 * as the outer body, even when it carries no attachment markers.
 */
function isEncapsulatedMessage(part: GmailPart): boolean {
  const mimeType = part.mimeType.toLowerCase();
  return (
    mimeType === "message/rfc822" ||
    mimeType === "message/global" ||
    mimeType === "message/news"
  );
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
 * Walks MIME parts depth-first, collecting the body candidates. Attachment-like
 * and encapsulated-message parts are opaque subtrees: neither their own data nor
 * anything beneath them is the body, so a text *attachment* or an attached
 * container cannot be mistaken for the body and a message that only carries
 * attachments reads as `missing_body`. Attachment bodies behind an attachmentId
 * are deliberately not downloaded: that is a user-attachment fetch, out of scope
 * for classification.
 *
 * text/plain wins over text/html. When several unambiguous candidates of the
 * chosen type remain, the body is ambiguous: the first is used but the message
 * is marked `truncated` rather than claiming a `complete` read of a body that
 * may be partial or wrong.
 */
export function extractBody(payload: GmailPart | undefined): ExtractedBody {
  if (!payload) return { text: null, quality: "missing_body" };

  const plain: string[] = [];
  const html: string[] = [];
  let totalBytes = 0;

  const walk = (part: GmailPart): void => {
    totalBytes += part.body?.size ?? 0;
    // Stop at attachment-like or encapsulated-message subtrees: their own bytes
    // and every descendant are outside the message's own body.
    if (isAttachmentLike(part) || isEncapsulatedMessage(part)) return;
    const text = part.body?.data ? decodeBody(part) : null;
    if (text !== null && text.trim().length > 0) {
      if (part.mimeType === "text/plain") plain.push(text);
      else if (part.mimeType === "text/html") html.push(text);
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);

  const candidates = plain.length > 0 ? plain : html.map(htmlToText);
  // More than one candidate of the chosen type means the message has no single
  // unambiguous body, so it is never reported as `complete`.
  const ambiguous = candidates.length > 1;
  const chosen = candidates[0] ?? null;
  if (!chosen || chosen.trim().length === 0) {
    return { text: null, quality: "missing_body" };
  }

  const truncated = ambiguous || chosen.length > MAX_TEXT_BYTES;
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
