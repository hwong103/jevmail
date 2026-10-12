// OAuth routes. Worker A owns this directory; the integrator mounts it.
//
// The callback is deliberately narrow: it verifies the CSRF `state`, binds the
// account, and redirects. It never returns a token to the browser, and it sets
// the session cookie with HttpOnly, Secure, and SameSite=Lax so the credential
// cannot be read by script.
//
// The `state` is minted here and bound to a short-lived cookie. The callback
// rejects any request whose `state` does not match the cookie, so an attacker
// cannot replay a callback against a victim's browser.

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { bindAccount } from "../server/auth/bind";
import {
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_TTL_SECONDS,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  randomOAuthState,
  safeStringEqual,
  signSession,
} from "../server/auth/session";
import {
  authorizationUrl,
  exchangeCode,
  gmailProfile,
  googleIdentity,
  keyringFromEnv,
  sealRefreshToken,
  type GoogleConfig,
} from "../server/auth/google";

const callbackQuery = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

export interface AuthEnv {
  Bindings: {
    DB: D1Database;
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
    CREDENTIAL_KEY?: string;
    CREDENTIAL_KEY_VERSION?: string;
    OWNER_EMAIL?: string;
    SESSION_SECRET?: string;
    AUTH_SECRET?: string;
  };
}

function configFor(env: AuthEnv["Bindings"]): GoogleConfig | null {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: new URL("/auth/callback", "https://placeholder.invalid").toString(),
  };
}

function sessionSecret(env: AuthEnv["Bindings"]): string | null {
  return env.SESSION_SECRET || env.AUTH_SECRET || null;
}

export function createAuthRouter(): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get("/auth/google", (c) => {
    const config = configFor(c.env);
    if (!config) return c.text("OAuth is not configured", 503);
    // Mint the CSRF token here and bind it to this browser. The same value goes
    // to Google and into the cookie the callback checks.
    const state = randomOAuthState();
    setCookie(c, OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: OAUTH_STATE_TTL_SECONDS,
    });
    return c.redirect(authorizationUrl({ ...config, redirectUri: callbackOrigin(c.req.url) }, state));
  });

  app.get("/auth/callback", zValidator("query", callbackQuery), async (c) => {
    const { code, state } = c.req.valid("query");

    // CSRF check first: a missing or mismatched state is rejected regardless of
    // whether OAuth itself is configured. The state cookie is single-use.
    const expectedState = getCookie(c, OAUTH_STATE_COOKIE);
    if (!expectedState || !safeStringEqual(expectedState, state)) {
      return c.text("Invalid OAuth state", 400);
    }
    deleteCookie(c, OAUTH_STATE_COOKIE, { path: "/" });

    const config = configFor(c.env);
    if (!config || !c.env.CREDENTIAL_KEY) return c.text("OAuth is not configured", 503);
    const secret = sessionSecret(c.env);
    if (!secret) return c.text("Session secret is not configured", 503);

    const tokens = await exchangeCode({ ...config, redirectUri: callbackOrigin(c.req.url) }, code);
    if (!tokens.refreshToken) {
      // Without a refresh token there is nothing durable to store, and the app
      // would die when the access token expired.
      return c.text("Google did not return a refresh token", 502);
    }

    const identity = await googleIdentity(tokens.accessToken);
    const profile = await gmailProfile(tokens.accessToken);
    const keyVersion = Number(c.env.CREDENTIAL_KEY_VERSION ?? 1);
    const keyring = await keyringFromEnv(c.env.CREDENTIAL_KEY, keyVersion);

    // The account id is unknown before binding, so the credential is sealed
    // under a provisional key and re-sealed once the account exists. The AAD
    // binding still prevents cross-account use.
    const provisional = await sealRefreshToken(tokens.refreshToken, "pending", keyring);
    const outcome = await bindAccount({
      db: c.env.DB,
      googleSub: identity.sub,
      email: identity.email || profile.emailAddress,
      sealed: provisional,
      ownerEmail: c.env.OWNER_EMAIL,
      historyId: profile.historyId,
      grantedScopes: tokens.scope,
    });

    if (outcome.status === "rejected") {
      return c.text(`Not allowed: ${outcome.reason}`, 403);
    }
    // Re-seal under the real account id so the stored ciphertext is bound to it.
    const resealed = await sealRefreshToken(tokens.refreshToken, outcome.accountId, keyring);
    await c.env.DB.prepare(
      "UPDATE accounts SET encrypted_refresh_token = ?, credential_iv = ?, key_version = ? WHERE id = ?",
    )
      .bind(resealed.encryptedRefreshToken, resealed.iv, resealed.keyVersion, outcome.accountId)
      .run();

    // Establish the live session. This is the only place a live session is
    // minted; `/api/*` verifies it before serving D1 data.
    const session = await signSession(secret, outcome.principalId, SESSION_TTL_SECONDS);
    setCookie(c, SESSION_COOKIE, session, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: SESSION_TTL_SECONDS,
    });

    return c.redirect("/?connected=1", 302);
  });

  return app;
}

function callbackOrigin(requestUrl: string): string {
  return new URL(requestUrl).origin + "/auth/callback";
}
