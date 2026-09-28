// OAuth tests. The behaviours that matter are the binding rule and the failure
// modes that must not be mistaken for transient ones.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "./helpers/migrations";
import { bindAccount, verifyAccountIdentity } from "../src/server/auth/bind";
import { OAUTH_SCOPES, authorizationUrl } from "../src/server/auth/google";

const db = (env as unknown as { DB: D1Database }).DB;

const SEALED = { encryptedRefreshToken: "cipher", keyVersion: 1, iv: "iv" };

function input(overrides: Partial<Parameters<typeof bindAccount>[0]> = {}) {
  return {
    db,
    googleSub: "sub-1",
    email: "owner@example.com",
    sealed: SEALED,
    historyId: "h0",
    grantedScopes: OAUTH_SCOPES.join(" "),
    ...overrides,
  } as Parameters<typeof bindAccount>[0];
}

describe("bindAccount", () => {
  beforeEach(async () => {
    await applyMigrations(db);
  });

  it("binds the first identity as owner and seeds a checkpoint", async () => {
    const result = await bindAccount(input());
    expect(result.status).toBe("bound");

    const principal = await db
      .prepare("SELECT google_sub, is_owner FROM principals WHERE is_owner = 1")
      .bind()
      .first<{ google_sub: string; is_owner: number }>();
    const checkpoint = await db
      .prepare("SELECT committed_history_id FROM sync_checkpoints WHERE account_id = ?")
      .bind((result as { accountId: string }).accountId)
      .first<{ committed_history_id: string }>();
    expect(principal?.google_sub).toBe("sub-1");
    expect(principal?.is_owner).toBe(1);
    // Sync starts from the current history id, not from the whole mailbox.
    expect(checkpoint?.committed_history_id).toBe("h0");
  });

  it("rejects a second identity once an owner exists", async () => {
    await bindAccount(input());
    const second = await bindAccount(input({ googleSub: "sub-2", email: "stranger@example.com" }));
    expect(second).toEqual({ status: "rejected", reason: "installation_already_owned" });
  });

  it("rejects an identity that is not a pre-pinned owner", async () => {
    const result = await bindAccount(
      input({ ownerEmail: "someone-else@example.com" }),
    );
    expect(result).toEqual({ status: "rejected", reason: "not_the_configured_owner" });
    const owners = await db.prepare("SELECT COUNT(*) AS n FROM principals").first<{ n: number }>();
    expect(owners?.n).toBe(0);
  });

  it("allows the pre-pinned owner to bind", async () => {
    const result = await bindAccount(input({ ownerEmail: "owner@example.com" }));
    expect(result.status).toBe("bound");
  });

  it("keeps the same account id when the owner reconnects", async () => {
    const first = await bindAccount(input());
    const second = await bindAccount(input({ sealed: { ...SEALED, encryptedRefreshToken: "new" } }));
    expect(second.status).toBe("bound");
    expect((second as { accountId: string }).accountId).toBe((first as { accountId: string }).accountId);
    const stored = await db
      .prepare("SELECT encrypted_refresh_token FROM accounts WHERE id = ?")
      .bind((first as { accountId: string }).accountId)
      .first<{ encrypted_refresh_token: string }>();
    expect(stored?.encrypted_refresh_token).toBe("new");
  });

  it("stores the credential iv alongside the ciphertext", async () => {
    const result = await bindAccount(input());
    const stored = await db
      .prepare("SELECT encrypted_refresh_token, credential_iv FROM accounts WHERE id = ?")
      .bind((result as { accountId: string }).accountId)
      .first<{ encrypted_refresh_token: string; credential_iv: string }>();
    expect(stored?.encrypted_refresh_token).toBe("cipher");
    expect(stored?.credential_iv).toBe("iv");
  });

  it("never stores the grant in plaintext", async () => {
    const result = await bindAccount(input());
    const row = await db
      .prepare("SELECT * FROM accounts WHERE id = ?")
      .bind((result as { accountId: string }).accountId)
      .first<Record<string, unknown>>();
    const serialised = JSON.stringify(row);
    expect(serialised).not.toContain("ya29.");
    expect(serialised).not.toContain("1//");
  });

  it("rejects a grant whose mailbox does not match the bound account", async () => {
    const result = await bindAccount(input());
    const accountId = (result as { accountId: string }).accountId;
    expect(await verifyAccountIdentity(db, accountId, { emailAddress: "owner@example.com" })).toBe(true);
    expect(await verifyAccountIdentity(db, accountId, { emailAddress: "other@example.com" })).toBe(false);
  });

  it("refuses a second owner even under a race", async () => {
    await Promise.all([bindAccount(input()), bindAccount(input({ googleSub: "sub-2" }))]);
    const owners = await db
      .prepare("SELECT COUNT(*) AS n FROM principals WHERE is_owner = 1")
      .first<{ n: number }>();
    // The partial unique index is the authority, not the application logic.
    expect(owners?.n).toBe(1);
  });
});

describe("authorizationUrl", () => {
  it("requests offline access and read-only scope", () => {
    const url = new URL(
      authorizationUrl(
        { clientId: "cid", clientSecret: "secret", redirectUri: "https://x.test/auth/callback" },
        "state-123",
      ),
    );
    expect(url.origin + url.pathname).toContain("accounts.google.com");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("scope")).toBe(OAUTH_SCOPES.join(" "));
    expect(url.searchParams.get("state")).toBe("state-123");
  });

  it("asks only for gmail.readonly, never modify or send", () => {
    expect(OAUTH_SCOPES).toEqual(["https://www.googleapis.com/auth/gmail.readonly"]);
    expect(OAUTH_SCOPES.join(" ")).not.toContain("modify");
    expect(OAUTH_SCOPES.join(" ")).not.toContain("send");
  });
});
