// Account binding. Worker A owns this directory.
//
// The rule this enforces: the first Google identity to complete a callback owns
// the installation, and every later identity is rejected. A partial unique index
// on `principals(is_owner) WHERE is_owner = 1` makes that a database invariant
// rather than application logic a race could slip past.
//
// `OWNER_EMAIL`, when set, pre-pins the principal so a URL discovered before the
// owner first signs in cannot be bound by a stranger. It is an escape hatch, not
// the default path.

import { OAUTH_SCOPES } from "./google";

export type BindOutcome =
  | { status: "bound"; accountId: string; isOwner: boolean }
  | { status: "rejected"; reason: string };

export interface BindInput {
  db: D1Database;
  googleSub: string;
  email: string;
  sealed: { encryptedRefreshToken: string; keyVersion: number; iv: string };
  ownerEmail?: string;
  historyId: string;
  grantedScopes: string;
}

export async function bindAccount(input: BindInput): Promise<BindOutcome> {
  const owner = await input.db
    .prepare("SELECT id, google_sub, email FROM principals WHERE is_owner = 1 LIMIT 1")
    .bind()
    .first<{ id: string; google_sub: string; email: string }>();

  if (owner && owner.google_sub !== input.googleSub) {
    return { status: "rejected", reason: "installation_already_owned" };
  }

  if (!owner && input.ownerEmail && input.ownerEmail.toLowerCase() !== input.email.toLowerCase()) {
    // A pre-pinned owner email does not match, so this identity cannot bind.
    return { status: "rejected", reason: "not_the_configured_owner" };
  }

  const principalId = owner?.id ?? crypto.randomUUID();
  if (!owner) {
    try {
      await input.db
        .prepare(
          "INSERT INTO principals (id, google_sub, email, bound_at, is_owner) VALUES (?, ?, ?, ?, 1)",
        )
        .bind(principalId, input.googleSub, input.email, Date.now())
        .run();
    } catch {
      // The partial unique index rejected a second owner, which means another
      // request won the race. Report it as already owned rather than retrying.
      return { status: "rejected", reason: "installation_already_owned" };
    }
  } else {
    await input.db
      .prepare("UPDATE principals SET email = ? WHERE id = ?")
      .bind(input.email, principalId)
      .run();
  }

  const existingAccount = await input.db
    .prepare("SELECT id FROM accounts WHERE principal_id = ?")
    .bind(principalId)
    .first<{ id: string }>();
  const accountId = existingAccount?.id ?? crypto.randomUUID();

  if (existingAccount) {
    // Reconnecting the same identity replaces the stored credential. The account
    // id is stable, so classifications, cursors, and corrections all survive.
    await input.db
      .prepare(
        "UPDATE accounts SET encrypted_refresh_token = ?, credential_iv = ?, key_version = ?, granted_scopes = ?, status = 'active' WHERE id = ?",
      )
      .bind(
        input.sealed.encryptedRefreshToken,
        input.sealed.iv,
        input.sealed.keyVersion,
        input.grantedScopes,
        accountId,
      )
      .run();
  } else {
    await input.db
      .prepare(
        "INSERT INTO accounts (id, principal_id, gmail_address, encrypted_refresh_token, credential_iv, key_version, granted_scopes, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)",
      )
      .bind(
        accountId,
        principalId,
        input.email,
        input.sealed.encryptedRefreshToken,
        input.sealed.iv,
        input.sealed.keyVersion,
        input.grantedScopes,
        Date.now(),
      )
      .run();
  }

  const hasCheckpoint = await input.db
    .prepare("SELECT 1 AS present FROM sync_checkpoints WHERE account_id = ?")
    .bind(accountId)
    .first<{ present: number }>();
  if (!hasCheckpoint) {
    // The first sync starts from the profile's current history id, so the
    // backfill is bounded by the owner rather than the whole mailbox.
    await input.db
      .prepare(
        "INSERT INTO sync_checkpoints (account_id, version, mode, committed_history_id, page_token, scan_id, updated_at) VALUES (?, 0, 'incremental', ?, NULL, NULL, ?)",
      )
      .bind(accountId, input.historyId, Date.now())
      .run();
  }

  return { status: "bound", accountId, isOwner: true };
}

/**
 * Confirms the account's Gmail address still matches the bound identity. Called
 * on every sync, so a grant that no longer belongs to the bound mailbox is
 * caught rather than used.
 */
export async function verifyAccountIdentity(
  db: D1Database,
  accountId: string,
  profile: { emailAddress: string },
): Promise<boolean> {
  const row = await db
    .prepare("SELECT gmail_address FROM accounts WHERE id = ?")
    .bind(accountId)
    .first<{ gmail_address: string }>();
  if (!row) return false;
  return row.gmail_address.toLowerCase() === profile.emailAddress.toLowerCase();
}

export const EXPECTED_SCOPES: readonly string[] = OAUTH_SCOPES;
