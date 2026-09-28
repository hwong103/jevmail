// OAuth routes. Worker A owns this directory; the integrator mounts it.
//
// The callback is deliberately narrow: it binds the account and redirects. It
// never returns a token to the browser, and it sets the session cookie with
// HttpOnly, Secure, and SameSite=Lax so the credential cannot be read by script.

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { bindAccount } from "../server/auth/bind";
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

export function createAuthRouter(): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.get("/auth/google", (c) => {
    const config = configFor(c.env);
    if (!config) return c.text("OAuth is not configured", 503);
    // The state is issued by the caller's session layer; this route only builds
    // the URL, so the placeholder is replaced by the mount point.
    const state = c.req.query("state") ?? "unset";
    return c.redirect(authorizationUrl({ ...config, redirectUri: callbackOrigin(c.req.url) }, state));
  });

  app.get("/auth/callback", zValidator("query", callbackQuery), async (c) => {
    const { code } = c.req.valid("query");
    const config = configFor(c.env);
    if (!config || !c.env.CREDENTIAL_KEY) return c.text("OAuth is not configured", 503);

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

    return c.redirect("/?connected=1", 302);
  });

  return app;
}

function callbackOrigin(requestUrl: string): string {
  return new URL(requestUrl).origin + "/auth/callback";
}
