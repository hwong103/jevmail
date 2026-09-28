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
 * Fetching a body needs a live Gmail OAuth grant, which is not wired yet. This
 * returns null rather than a fetcher that cannot authenticate, so classify jobs
 * park as blocked_auth instead of failing repeatedly.
 */
export async function buildGmailFetcher(
  env: Env,
  accountId: string,
): Promise<GmailFetcher | null> {
  if (!env.DB) return null;
  const row = await env.DB.prepare(
    "SELECT encrypted_refresh_token FROM accounts WHERE id = ? AND status = 'active'",
  )
    .bind(accountId)
    .first<{ encrypted_refresh_token: string | null }>();
  if (!row?.encrypted_refresh_token) return null;
  // A grant is stored, but the OAuth layer that exchanges it for an access
  // token does not exist yet. Returning null here is the honest answer.
  return null;
}
