// Dependency construction for job handlers. The integrator owns this file.
//
// Both builders return null when their preconditions are not met, so a handler
// parks its job rather than running with a half-configured dependency. That
// distinction matters: a stub that typechecks but quietly does nothing would
// leave mail unclassified while everything looked healthy.

import { JevClassificationPort } from "../classification/jev";
import { createFixturePort } from "../classification/fixture";
import type { ClassificationPort } from "../classification/classify";
import { extractBody, type GmailMessage } from "../gmail/normalize";
import {
  buildAccessTokenProvider,
  type AccessTokenProvider,
} from "../auth/credentials";
import { GmailApiError } from "../gmail/client";
import type { GoogleConfig } from "../auth/google";
import type { Env } from "../../runtime/env";
import type { BodyLoader } from "../../runtime/repository";
import type { MessageBody } from "../../contracts/dto";

export type GmailFetcher = (gmailMessageId: string) => Promise<GmailMessage | null>;

/**
 * Prefers the real Jev provider. Falls back to the deterministic fixture only
 * when explicitly asked to, so a deployed Worker can never silently classify
 * mail with test data.
 */
export function buildClassificationPort(env: Env): ClassificationPort | null {
  // The AI binding is the real provider and wins even if JEV_PROVIDER is left
  // behind in the environment.
  if (env.AI) return new JevClassificationPort(env.AI);
  if (env.JEV_PROVIDER === "fixture") return createFixturePort();
  // Nothing configured: the caller parks the job rather than classifying with
  // test data.
  return null;
}

/**
 * Fetches one message for classification. The body is returned to the caller
 * and immediately discarded: it is never written anywhere.
 */
export async function buildGmailFetcher(
  env: Env,
  accountId: string,
): Promise<GmailFetcher | null> {
  if (!env.DB) return null;
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.CREDENTIAL_KEY) return null;

  const config: GoogleConfig = {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: "",
  };
  const provider: AccessTokenProvider = buildAccessTokenProvider(
    env.DB,
    config,
    env.CREDENTIAL_KEY,
    Number(env.CREDENTIAL_KEY_VERSION ?? 1),
  );
  const adapter = await provider.adapterFor(accountId);
  return async (gmailMessageId: string) => {
    const { message } = await adapter.getMessage(gmailMessageId, "full");
    return message as unknown as GmailMessage;
  };
}

const UNAVAILABLE_REASON = {
  missing_body: "This message has no readable body. Open it in Gmail.",
  truncated: "This message was truncated. Open it in Gmail to read the rest.",
  unsupported: "This message could not be loaded from Gmail. Open it in Gmail to read it.",
} as const;

export function gmailUrlFor(gmailMessageId: string): string {
  return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(gmailMessageId)}`;
}

/**
 * Assembles the frozen `MessageBody` DTO from a fetched Gmail message. A body is
 * shown only when it was read in full: a partial or missing body is qualified
 * with an `unavailableReason` rather than presented as if it were complete.
 */
export function toMessageBody(gmailMessageId: string, raw: GmailMessage): MessageBody {
  const { text, quality } = extractBody(raw.payload);
  return {
    gmailMessageId,
    text: quality === "complete" ? text : null,
    quality,
    unavailableReason: quality === "complete" ? null : UNAVAILABLE_REASON[quality],
    gmailUrl: gmailUrlFor(gmailMessageId),
  };
}

function unsupportedBody(gmailMessageId: string): MessageBody {
  return {
    gmailMessageId,
    text: null,
    quality: "unsupported",
    unavailableReason: UNAVAILABLE_REASON.unsupported,
    gmailUrl: gmailUrlFor(gmailMessageId),
  };
}

/**
 * A definitive Gmail "not found" means the message is gone, not that the fetch
 * failed. It must reach the route as null so the answer is a 404; a missing
 * message is not a Gmail outage.
 */
function isMessageGone(error: unknown): boolean {
  return error instanceof GmailApiError && error.status === 404;
}

/**
 * Wraps a Gmail fetcher as a `BodyLoader`. A missing message returns null (the
 * route answers 404); a fetch failure or absent fetcher degrades to an
 * `unsupported` body. Nothing here invents content.
 */
export function makeBodyLoader(fetcher: GmailFetcher | null): BodyLoader {
  return async (gmailMessageId: string) => {
    if (!fetcher) return unsupportedBody(gmailMessageId);
    try {
      const raw = await fetcher(gmailMessageId);
      if (!raw) return null;
      return toMessageBody(gmailMessageId, raw);
    } catch (error) {
      // The message no longer exists: the caller's 404 path, same as an empty
      // fetch. A genuinely failed call still degrades to `unsupported`.
      if (isMessageGone(error)) return null;
      // The grant or the upstream call failed. Never fabricate a body.
      return unsupportedBody(gmailMessageId);
    }
  };
}

/**
 * The reader's body loader. The fetcher is built lazily on the first body
 * request so a list request never refreshes a Gmail token, and a failure to
 * build it degrades to `unsupported` instead of failing the request.
 */
export function buildBodyLoader(env: Env, accountId: string): BodyLoader {
  let loader: Promise<BodyLoader> | null = null;
  return async (gmailMessageId: string) => {
    loader ??= buildGmailFetcher(env, accountId).then(
      makeBodyLoader,
      () => makeBodyLoader(null),
    );
    return (await loader)(gmailMessageId);
  };
}
