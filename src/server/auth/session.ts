// Minimal signed-session boundary for the live API. Worker A owns this file.
//
// This is a deliberate stopgap, not the target design. PLAN-v2 decision #3 calls
// for Better Auth with database sessions; wiring that (its own user/session
// tables plus an adapter) is larger than this change's budget, so the smallest
// correct boundary that fails closed is here instead:
//
//   * The OAuth callback mints a session token: a base64url JSON payload plus an
//     HMAC-SHA256 signature over that payload, keyed by SESSION_SECRET.
//   * `/api/*` verifies the token before serving any live (D1) data and derives
//     `actorId` from the signed `principalId`.
//
// Because the signature is the only thing that authorises access, a missing or
// forged token denies access rather than falling back to fixtures or to a
// hard-coded actor. TODO: replace this module with Better Auth database
// sessions once the adapter work is scheduled.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Cookie name carrying the live session. Shared by the auth routes and `/api/*`. */
export const SESSION_COOKIE = "jevmail_session";
/** Cookie name binding the OAuth `state` to this browser. */
export const OAUTH_STATE_COOKIE = "jevmail_oauth_state";
/** Ten minutes is long enough to complete consent, short enough to be safe. */
export const OAUTH_STATE_TTL_SECONDS = 600;
/** Thirty days: a self-hosted single-owner app should not re-auth weekly. */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

export interface Session {
  principalId: string;
  expiresAt: number;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

async function signingKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** Mints a signed session token for `principalId`. */
export async function signSession(
  secret: string,
  principalId: string,
  ttlSeconds: number = SESSION_TTL_SECONDS,
): Promise<string> {
  const payload: Session = { principalId, expiresAt: Date.now() + ttlSeconds * 1000 };
  const body = base64url(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign("HMAC", await signingKey(secret), encoder.encode(body));
  return `${body}.${base64url(new Uint8Array(signature))}`;
}

/**
 * Verifies a session token. Returns null for anything that is not a live,
 * correctly signed session: missing secret, malformed token, bad signature, or
 * an expired payload. Callers must treat null as "not authenticated".
 */
export async function verifySession(
  secret: string | undefined,
  token: string | undefined,
): Promise<Session | null> {
  if (!secret || !token) return null;
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;
  const signatureBytes = fromBase64url(signature);
  if (!signatureBytes) return null;
  // crypto.subtle.verify is constant-time over the signature; a manual compare
  // would leak timing.
  const valid = await crypto.subtle.verify(
    "HMAC",
    await signingKey(secret),
    signatureBytes,
    encoder.encode(body),
  );
  if (!valid) return null;
  const payloadBytes = fromBase64url(body);
  if (!payloadBytes) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(decoder.decode(payloadBytes));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const { principalId, expiresAt } = payload as Partial<Session>;
  if (typeof principalId !== "string" || !principalId) return null;
  if (typeof expiresAt !== "number" || expiresAt <= Date.now()) return null;
  return { principalId, expiresAt };
}

/** Random, unguessable OAuth `state`, bound to a cookie by the caller. */
export function randomOAuthState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/** Constant-time string comparison for the OAuth `state` check. */
export function safeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
