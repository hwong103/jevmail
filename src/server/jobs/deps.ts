// Dependency construction for job handlers. The integrator owns this file.
//
// Both builders return null when their preconditions are not met, so a handler
// parks its job rather than running with a half-configured dependency. That
// distinction matters: a stub that typechecks but quietly does nothing would
// leave mail unclassified while everything looked healthy.

import { JevClassificationPort, type AiBinding } from "../classification/jev";
import { createFixturePort } from "../classification/fixture";
import type { ClassificationPort } from "../classification/classify";
import type { GmailMessage } from "../gmail/normalize";
import {
  buildAccessTokenProvider,
  type AccessTokenProvider,
} from "../auth/credentials";
import type { GoogleConfig } from "../auth/google";
import type { Env } from "../../runtime/env";

export type GmailFetcher = (gmailMessageId: string) => Promise<GmailMessage | null>;

/**
 * Prefers the real Jev provider. Falls back to the deterministic fixture only
 * when explicitly asked to, so a deployed Worker can never silently classify
 * mail with test data.
 */
export function buildClassificationPort(env: Env): ClassificationPort | null {
  const ai = (env as unknown as { AI?: AiBinding }).AI;
  if (ai) return new JevClassificationPort(ai);
  if (env.JEV_PROVIDER === "fixture") return createFixturePort();
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
