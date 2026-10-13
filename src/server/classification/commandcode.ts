// Command Code Provider API adapter. A second transport for the SAME System One
// model the Workers AI binding runs (`typesafe/jev`), selected only when a key is
// set. It shares one request shape (`buildJevInput`) and one interpreter
// (`interpret`) with the Workers AI port, so the two can never drift.
//
// Wire contract (from Command Code's docs — not assumed):
//   POST {JEV_BASE_URL or https://api.commandcode.ai}/provider/v1/systemone
//   Authorization: Bearer <key>, Content-Type: application/json
//   body { model, state, questions } -> { model, answers, usage }
//   Errors use the OpenAI envelope { error: { message, type, code, param } }.
//
// Deliberately NOT sent: `x-cmd-zdr`. Command Code documents that `typesafe/jev`
// has no zero-data-retention upstream, and a ZDR request is refused with 422.

import type { NormalizedMessage } from "../../contracts/domain";
import { ProviderError, type ClassificationPort, type RawClassification } from "./classify";
import { JEV_MODEL, buildJevInput, interpret } from "./jev";

export const COMMAND_CODE_BASE_URL = "https://api.commandcode.ai";
export const SYSTEMONE_PATH = "/provider/v1/systemone";
/** Bounded so a hung provider response cannot hold the job's lease open. */
export const COMMAND_CODE_TIMEOUT_MS = 30_000;

/**
 * A Command Code failure. `status` is the upstream HTTP status, or 0 when the
 * request never got a response (network failure or timeout). `kind` is `auth`
 * for a bad key or plan (401/403) and `retryable` for everything else.
 */
export class CommandCodeError extends ProviderError {
  constructor(kind: "auth" | "retryable", status: number, message: string) {
    super(kind, message, status);
    this.name = "CommandCodeError";
  }
}

/**
 * A bad provider configuration (as opposed to a failed request). Thrown at
 * construction so a misconfigured base URL fails closed before any request.
 */
export class CommandCodeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandCodeConfigError";
  }
}

export interface CommandCodeConfig {
  apiKey: string;
  /** Overrides the default base URL. Trailing slashes are trimmed. */
  baseUrl?: string;
  /** Overrides the 30s timeout. */
  timeoutMs?: number;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

/** Hosts for which plain `http:` is acceptable (loopback development only). */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Resolves and validates the base URL. HTTPS is required; plain `http:` is
 * allowed only for a loopback host, so a local OpenAI-compatible gateway works
 * in development while a misconfigured or downgraded host cannot be reached in
 * cleartext. Validation happens here (construction), so a bad `JEV_BASE_URL`
 * fails at selection rather than mid-job.
 */
export function resolveBaseUrl(baseUrl?: string): string {
  const raw = (baseUrl ?? COMMAND_CODE_BASE_URL).replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new CommandCodeConfigError(
      `Command Code base URL is not a valid absolute URL: ${raw === "" ? "(empty)" : raw}`,
    );
  }
  if (parsed.protocol === "https:") return raw;
  if (parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
    return raw;
  }
  throw new CommandCodeConfigError(
    `Command Code base URL must be HTTPS (plain HTTP is allowed only for a loopback host): ${raw}`,
  );
}

export class CommandCodeJevPort implements ClassificationPort {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: CommandCodeConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = resolveBaseUrl(config.baseUrl);
    this.timeoutMs = config.timeoutMs ?? COMMAND_CODE_TIMEOUT_MS;
  }

  async classify(message: NormalizedMessage): Promise<RawClassification> {
    const url = `${this.baseUrl}${SYSTEMONE_PATH}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: JEV_MODEL, ...buildJevInput(message) }),
        // Never follow a redirect: Workers forwards the Authorization header
        // across hosts and a 307/308 replays the POST body, so a redirect could
        // leak the key and the mail body to another host. `error` turns any
        // redirect into a retryable failure that is never followed.
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      // No response: a network failure or a timeout. Both are transient, so the
      // job retries. Status 0 records that no HTTP response was received.
      throw new CommandCodeError(
        "retryable",
        0,
        `Command Code request failed: ${errorName(error)}`,
      );
    }

    if (!response.ok) {
      // 401/403 mean the key is bad or the plan is wrong; a retry cannot fix
      // that, so it parks the job. Everything else is treated as transient.
      const kind = response.status === 401 || response.status === 403 ? "auth" : "retryable";
      throw new CommandCodeError(
        kind,
        response.status,
        `Command Code returned HTTP ${response.status}`,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new CommandCodeError(
        "retryable",
        response.status,
        `Command Code returned a non-JSON body: ${errorName(error)}`,
      );
    }
    // Same System One shape as Workers AI, so the shared interpreter handles it
    // unchanged. A malformed or empty answers object becomes an explicit
    // `unknown`, never a default.
    return interpret(body);
  }
}
