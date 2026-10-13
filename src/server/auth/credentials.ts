// Credential service. Worker A owns this directory.
//
// Background consumers (Cron, Queue) need a usable access token, and they cannot
// go through a browser. This is the single path from a stored, encrypted refresh
// token to a short-lived access token, used by sync, the body loader, and the
// reader alike.
//
// An access token lives in memory for the life of one request and is never
// written to D1, a queue, or a log.

import {
  GmailApiError,
  GmailHttpAdapter,
  isAuthFailure,
} from "../gmail/client";
import { OAuthError, openRefreshToken, refreshAccessToken, type GoogleConfig, type StoredCredential } from "./google";
import { keyringFromEnv } from "./google";

export class ReauthRequiredError extends Error {
  constructor() {
    super("The Gmail grant is no longer valid; reconnect is required.");
    this.name = "ReauthRequiredError";
  }
}

export interface AccessTokenProvider {
  accessTokenFor(accountId: string): Promise<string>;
  adapterFor(accountId: string): Promise<GmailHttpAdapter>;
}

export function buildAccessTokenProvider(
  db: D1Database,
  config: GoogleConfig,
  credentialKey: string,
  keyVersion: number,
): AccessTokenProvider {
  const keyringPromise = keyringFromEnv(credentialKey, keyVersion);

  async function resolve(accountId: string): Promise<string> {
    const row = await db
      .prepare(
        "SELECT encrypted_refresh_token, credential_iv, key_version, status FROM accounts WHERE id = ?",
      )
      .bind(accountId)
      .first<{
        encrypted_refresh_token: string | null;
        credential_iv: string | null;
        key_version: number | null;
        status: string;
      }>();
    if (!row || row.status !== "active" || !row.encrypted_refresh_token) {
      throw new ReauthRequiredError();
    }

    const stored: StoredCredential = {
      encryptedRefreshToken: row.encrypted_refresh_token,
      iv: row.credential_iv ?? "",
      keyVersion: row.key_version ?? keyVersion,
    };
    const keyring = await keyringPromise;
    let refreshToken: string;
    try {
      refreshToken = await openRefreshToken(stored, accountId, keyring);
    } catch {
      // A ciphertext that will not open is a key problem, not a transient one.
      throw new ReauthRequiredError();
    }

    try {
      const tokens = await refreshAccessToken(config, refreshToken);
      return tokens.accessToken;
    } catch (error) {
      // A definitive invalid_grant means the owner revoked access or the grant
      // aged out. Retrying would just fail again, so the account is parked and
      // the UI is asked to reconnect. Transient failures are not treated this way.
      if (error instanceof OAuthError && /invalid_grant|token_revoked/i.test(error.reason)) {
        await markReauthRequired(db, accountId);
        throw new ReauthRequiredError();
      }
      throw error;
    }
  }

  return {
    accessTokenFor: resolve,
    async adapterFor(accountId: string) {
      return new GmailHttpAdapter(await resolve(accountId));
    },
  };
}

export async function markReauthRequired(db: D1Database, accountId: string): Promise<void> {
  await db
    .prepare("UPDATE accounts SET status = 'reauth_required' WHERE id = ?")
    .bind(accountId)
    .run();
}

export { GmailApiError, isAuthFailure };
