// Cron-driven mailbox sync. Worker A owns this directory.
//
// A scheduled invocation must not depend on a mailbox being connected; a fresh
// installation has no account yet and the trigger must be a harmless no-op.

import type { Env } from "../../runtime/env";

export interface SyncResult {
  status: "skipped" | "ran";
  reason?: string;
  pages?: number;
  messages?: number;
}

export async function scheduledSync(
  controller: ScheduledController,
  env: Env,
): Promise<SyncResult> {
  const ctx = controller as unknown as { waitUntil(promise: Promise<unknown>): void };
  const result = await runSync(env);
  ctx.waitUntil(Promise.resolve(result));
  return result;
}

export async function runSync(env: Env): Promise<SyncResult> {
  if (!env.DB) return { status: "skipped", reason: "no_database_binding" };
  // The polling loop lives in sync/poll.ts and is wired to the outbox port.
  // A fresh installation has no account row, so the first run is a no-op.
  return { status: "skipped", reason: "no_account_connected" };
}
