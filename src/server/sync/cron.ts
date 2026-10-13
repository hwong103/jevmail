// Cron-driven mailbox sync. Worker A owns this directory.
//
// A scheduled invocation must not depend on a mailbox being connected; a fresh
// installation has no account yet and the trigger must be a harmless no-op.

import { publishPending } from "../../db/outbox";
import { verifyAccountIdentity } from "../auth/bind";
import {
  buildAccessTokenProvider,
  markReauthRequired,
  ReauthRequiredError,
} from "../auth/credentials";
import type { GoogleConfig } from "../auth/google";
import { isAuthFailure, type GmailAdapter } from "../gmail/client";
import { MissingConfigError, type Env } from "../../runtime/env";
import { pollOnce } from "./poll";

export interface SyncResult {
  status: "skipped" | "ran" | "error";
  reason?: string;
  pages?: number;
  messages?: number;
  published?: number;
  errors?: string[];
}

/** Ceilings so a stuck cursor or a message storm cannot spin a single cron. */
export const MAX_PAGES = 10;
/**
 * Total Gmail API requests a single invocation may make. Gmail history can name
 * hundreds of messages in one pass; the free-plan subrequest ceiling cannot. A
 * pass stops cleanly at this ceiling with the cursor left resumable, and the
 * next run picks up where it left off.
 *
 * This bounds *requests*, not just message fetches. The non-message calls a
 * pass makes are reserved out of it up front so the arithmetic holds:
 *
 *   total requests = reserved calls + message-fetch attempts
 *                  <= RESERVED_REQUESTS + (MAX_FETCHES - RESERVED_REQUESTS)
 *                  <= MAX_FETCHES
 *
 * where RESERVED_REQUESTS covers the worst case for the other calls:
 *   1         access-token refresh (one POST when the stored grant is stale)
 *   1         profile() (confirms the grant still opens the bound mailbox)
 *   MAX_PAGES history.list (one call per page, capped at MAX_PAGES pages)
 *
 * Message metadata fetches therefore get MAX_FETCHES - RESERVED_REQUESTS, and
 * they are charged whether or not they land: a vanished (404) message or a
 * retried fetch still spent a subrequest.
 */
export const MAX_FETCHES = 40;
export const RESERVED_REQUESTS = 1 + 1 + MAX_PAGES;
const PUBLISH_LIMIT = 25;

export interface SyncOverrides {
  /** Test seam: build the Gmail adapter without live OAuth. */
  adapterFor?: (accountId: string) => Promise<GmailAdapter>;
  /** Test seam: publish to a stand-in queue when the binding is absent. */
  queue?: Queue<unknown>;
  /** Test seam: tighten the per-invocation Gmail request ceiling. */
  maxFetches?: number;
}

export async function scheduledSync(
  controller: ScheduledController,
  env: Env,
): Promise<SyncResult> {
  // A `ScheduledController` has no `waitUntil`; the handler already awaits the
  // pass, so the return value is the whole of the work.
  void controller;
  return runSync(env);
}

/**
 * One cron pass: resolve the active account, build a Gmail adapter from the
 * stored grant, confirm the grant still belongs to the bound mailbox, poll
 * history in a bounded loop, then publish whatever the pages enqueued.
 *
 * Failure handling is deliberately conservative. A poll failure leaves the
 * cursor where it was, so the next pass redoes the same page instead of
 * skipping past work. The pass surfaces the failure in its result rather than
 * retrying inline.
 */
export async function runSync(env: Env, overrides: SyncOverrides = {}): Promise<SyncResult> {
  if (!env.DB) return { status: "skipped", reason: "no_database_binding" };

  const account = await env.DB.prepare(
    "SELECT id FROM accounts WHERE status = 'active' ORDER BY created_at ASC LIMIT 1",
  )
    .bind()
    .first<{ id: string }>();
  // A fresh installation has no account row, so the first run is a no-op.
  if (!account) return { status: "skipped", reason: "no_account_connected" };
  const accountId = account.id;

  const pass = await runSyncPass(env, accountId, overrides);

  // The publish sweep is independent of Gmail health. Whatever the sync pass
  // did, queued work from an earlier page must still reach the queue, so a
  // failed adapter or profile cannot strand the outbox behind it.
  const queue = overrides.queue ?? env.JOB_QUEUE;
  const errors = pass.errors ? [...pass.errors] : [];
  let published = 0;
  if (queue) {
    const receipt = await publishPending(env.DB, queue, PUBLISH_LIMIT);
    published = receipt.published;
    if (receipt.failed > 0) errors.push("publish_failed");
  }

  if (pass.status === "skipped") {
    return {
      ...pass,
      published,
      errors: errors.length > 0 ? errors : pass.errors,
    };
  }
  if (errors.length > 0) {
    return {
      status: "error",
      reason: errors[0],
      pages: pass.pages,
      messages: pass.messages,
      published,
      errors,
    };
  }
  return {
    status: "ran",
    pages: pass.pages,
    messages: pass.messages,
    published,
  };
}

/**
 * The Gmail half of a cron pass: resolve the adapter, confirm the grant still
 * opens the bound mailbox, and poll history in a bounded loop. Publishing is
 * deliberately not done here, so the caller can sweep the outbox even when
 * this step fails.
 */
async function runSyncPass(
  env: Env,
  accountId: string,
  overrides: SyncOverrides,
): Promise<SyncResult> {
  let adapter: GmailAdapter;
  try {
    adapter = await resolveAdapter(env, accountId, overrides);
  } catch (error) {
    if (error instanceof MissingConfigError) {
      return { status: "skipped", reason: "sync_not_configured" };
    }
    if (error instanceof ReauthRequiredError) {
      return { status: "skipped", reason: "reauth_required" };
    }
    return {
      status: "error",
      reason: error instanceof Error ? error.name : "adapter_failed",
      errors: [error instanceof Error ? error.name : "adapter_failed"],
    };
  }

  let profile: { emailAddress: string };
  try {
    profile = await adapter.profile();
  } catch (error) {
    if (isAuthFailure(error)) {
      await markReauthRequired(env.DB, accountId);
      return { status: "skipped", reason: "reauth_required" };
    }
    const name = error instanceof Error ? error.name : "profile_failed";
    return { status: "error", reason: name, errors: [name] };
  }

  // A grant that no longer opens the bound mailbox must stop the sync rather
  // than poll the wrong inbox.
  if (!(await verifyAccountIdentity(env.DB, accountId, profile))) {
    await markReauthRequired(env.DB, accountId);
    return { status: "skipped", reason: "identity_mismatch" };
  }

  // Charge reserved calls first: the metadata fetch budget is whatever ceiling
  // is left once the token refresh, profile, and history pages are paid for.
  const requestCeiling = overrides.maxFetches ?? MAX_FETCHES;
  const fetchBudget = Math.max(0, requestCeiling - RESERVED_REQUESTS);
  const errors: string[] = [];
  let pages = 0;
  let messages = 0;
  let attempted = 0;
  let stop = false;
  while (!stop && pages < MAX_PAGES && attempted < fetchBudget) {
    const result = await pollOnce({
      db: env.DB,
      gmail: adapter,
      accountId,
      maxFetches: fetchBudget - attempted,
    });
    pages += 1;
    messages += result.messagesChanged;
    // Charge the budget by attempts, not commits: a 404 or a retried fetch
    // spent a request too, so counting only messagesChanged would let each page
    // spend the full budget over again.
    attempted += result.fetchesAttempted;
    switch (result.status) {
      case "ok":
        // Keep going while the checkpoint holds resumable work (a page token or
        // deferred ids). When it clears, this pass is caught up.
        stop = !result.more;
        break;
      case "skipped":
        stop = true;
        break;
      case "blocked_auth":
        errors.push("blocked_auth");
        stop = true;
        break;
      case "expired":
        errors.push("history_id_expired");
        stop = true;
        break;
      default:
        errors.push(result.reason ?? "sync_error");
        stop = true;
        break;
    }
  }

  if (errors.length > 0) {
    return { status: "error", reason: errors[0], pages, messages, errors };
  }
  return { status: "ran", pages, messages };
}

async function resolveAdapter(
  env: Env,
  accountId: string,
  overrides: SyncOverrides,
): Promise<GmailAdapter> {
  if (overrides.adapterFor) return overrides.adapterFor(accountId);
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, CREDENTIAL_KEY } = env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !CREDENTIAL_KEY) {
    throw new MissingConfigError(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "CREDENTIAL_KEY"]);
  }
  const config: GoogleConfig = {
    clientId: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    // The refresh-token grant does not use a redirect URI; it is only needed
    // for the interactive consent flow.
    redirectUri: "",
  };
  const provider = buildAccessTokenProvider(
    env.DB,
    config,
    CREDENTIAL_KEY,
    Number(env.CREDENTIAL_KEY_VERSION ?? 1),
  );
  return provider.adapterFor(accountId);
}
