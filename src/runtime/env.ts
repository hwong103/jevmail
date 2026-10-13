// Environment resolution. Fail-closed on anything security-relevant: a missing
// secret disables the feature rather than silently degrading it.

import type { AiBinding } from "../server/classification/jev";

export interface Env {
  DB: D1Database;
  JOB_QUEUE: Queue<unknown>;
  /** Workers AI binding. The real Jev classifier runs through this. */
  AI?: AiBinding;
  SESSION_SECRET?: string;
  CREDENTIAL_KEY?: string;
  CREDENTIAL_KEY_VERSION?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /**
   * Command Code Provider API key. Set with `wrangler secret put JEV_API_KEY`.
   * When present it selects the Command Code transport for `typesafe/jev` and
   * wins over the Workers AI binding. Never put this in wrangler.jsonc.
   */
  JEV_API_KEY?: string;
  /** Accepted alias for `JEV_API_KEY`; the latter is preferred. */
  CMD_API_KEY?: string;
  /** Overrides the Command Code base URL. Defaults to https://api.commandcode.ai. */
  JEV_BASE_URL?: string;
  /** Only the literal "fixture" is honoured; it opts into the local classifier. */
  JEV_PROVIDER?: string;
  OWNER_EMAIL?: string;
  AUTH_SECRET?: string;
  WORKER_VERSION?: string;
}

export class MissingConfigError extends Error {
  constructor(readonly keys: readonly string[]) {
    super(`Missing required configuration: ${keys.join(", ")}`);
    this.name = "MissingConfigError";
  }
}

export function requireConfig<T extends Record<string, string | undefined>>(
  env: T,
  keys: readonly string[],
): Record<string, string> {
  const missing = keys.filter((key) => {
    const value = env[key];
    return value === undefined || value === "";
  });
  if (missing.length > 0) throw new MissingConfigError(missing);
  return Object.fromEntries(keys.map((key) => [key, env[key] as string]));
}

export function isConfigured(env: Env): boolean {
  return Boolean(
    env.GOOGLE_CLIENT_ID &&
      env.GOOGLE_CLIENT_SECRET &&
      (env.SESSION_SECRET || env.AUTH_SECRET) &&
      env.CREDENTIAL_KEY,
  );
}
