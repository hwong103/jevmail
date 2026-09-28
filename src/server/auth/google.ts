// Google OAuth for Gmail. Worker A owns this directory.
//
// Scope policy: this build requests `gmail.readonly` and nothing else. The plan
// requires `gmail.modify` only once Gmail actions are actually activated, and
// that scope also authorises sending, so the narrower scope is not a
// placeholder to be widened later without a deliberate decision.
//
// Token policy: the refresh token is encrypted before it touches D1 and is
// never returned to a browser. The access token is short-lived, held only in
// memory for the life of one request, and never logged.

import {
  decryptCredential,
  encryptCredential,
  importCredentialKey,
  type CredentialKeyring,
} from "../../runtime/crypto";

export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const OAUTH_SCOPES = [GMAIL_READONLY_SCOPE];

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const PROFILE_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/profile";

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface StoredCredential {
  encryptedRefreshToken: string;
  keyVersion: number;
  iv: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number;
  scope: string;
}

export interface PrincipalBinding {
  id: string;
  googleSub: string;
  email: string;
  boundAt: number;
  isOwner: boolean;
}

export class OAuthError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

/**
 * Builds the consent URL. `state` must be a value the callback can verify; the
 * caller supplies it and is responsible for binding it to a session.
 */
export function authorizationUrl(config: GoogleConfig, state: string): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  // Offline access is what yields a refresh token. Without it, the grant would
  // die with the access token and there would be nothing to store.
  url.searchParams.set("access_type", "offline");
  // The user may have already granted these scopes, in which case Google omits a
  // refresh token from the response. Re-prompting is correct here, otherwise a
  // reconnect would silently produce an account with no stored credential.
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("scope", OAUTH_SCOPES.join(" "));
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeCode(
  config: GoogleConfig,
  code: string,
): Promise<TokenSet> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new OAuthError(
      body.error ?? "token_exchange_failed",
      `Token exchange failed: ${response.status}`,
    );
  }
  const body = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
  };
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresInSeconds: body.expires_in,
    scope: body.scope ?? OAUTH_SCOPES.join(" "),
  };
}

export async function refreshAccessToken(
  config: GoogleConfig,
  refreshToken: string,
): Promise<TokenSet> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new OAuthError(
      body.error ?? "refresh_failed",
      `Token refresh failed: ${response.status}`,
    );
  }
  const body = (await response.json()) as { access_token: string; expires_in: number; scope?: string };
  return {
    accessToken: body.access_token,
    // A refresh response normally omits the refresh token; the existing one
    // remains valid and must be kept.
    refreshToken: null,
    expiresInSeconds: body.expires_in,
    scope: body.scope ?? OAUTH_SCOPES.join(" "),
  };
}

export interface GmailProfileResult {
  emailAddress: string;
  historyId: string;
}

export async function gmailProfile(accessToken: string): Promise<GmailProfileResult> {
  const response = await fetch(PROFILE_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new OAuthError("profile_failed", `Gmail profile failed: ${response.status}`);
  }
  return (await response.json()) as GmailProfileResult;
}

/**
 * Identifies the signed-in Google user. The sub is the stable identity; the
 * email can change, so it is never used as the primary key.
 */
export async function googleIdentity(
  accessToken: string,
): Promise<{ sub: string; email: string }> {
  const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new OAuthError("identity_failed", `Identity lookup failed: ${response.status}`);
  }
  const body = (await response.json()) as { sub?: string; email?: string; email_verified?: boolean };
  if (!body.sub) throw new OAuthError("identity_failed", "Identity response had no sub");
  return { sub: body.sub, email: body.email ?? "" };
}

export async function keyringFromEnv(raw: string, version: number): Promise<CredentialKeyring> {
  return { activeVersion: version, keys: new Map([[version, await importCredentialKey(raw)]]) };
}

export async function sealRefreshToken(
  refreshToken: string,
  accountId: string,
  keyring: CredentialKeyring,
): Promise<StoredCredential> {
  const sealed = await encryptCredential(refreshToken, accountId, keyring);
  return {
    encryptedRefreshToken: sealed.ciphertext,
    keyVersion: sealed.keyVersion,
    iv: sealed.iv,
  };
}

export async function openRefreshToken(
  stored: StoredCredential,
  accountId: string,
  keyring: CredentialKeyring,
): Promise<string> {
  return decryptCredential(
    { ciphertext: stored.encryptedRefreshToken, iv: stored.iv, keyVersion: stored.keyVersion },
    accountId,
    keyring,
  );
}
