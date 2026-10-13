// Repository selection. The integrator owns this file.
//
// The read side runs on fixtures until a mailbox is actually connected, then
// switches to D1 without the routes or the client changing. Selection is by the
// presence of an active account row rather than an environment flag, so a fresh
// install shows a visible fixture state instead of a confusing error.

import type { MessageBody } from "../contracts/dto";
import { D1MailRepository } from "../server/mail/d1-repository";
import { FixtureMailRepository } from "../server/mail/fixtures";
import type { MailRepository } from "../server/mail/repository";
import type { Env } from "./env";

export type BodyLoader = (gmailMessageId: string) => Promise<MessageBody | null>;

/**
 * Builds the body loader once a connected account is known. The loader is built
 * lazily by the caller, so selecting a repository never reaches Gmail.
 */
export type BodyLoaderFactory = (accountId: string) => BodyLoader;

export interface SelectedRepository {
  repository: MailRepository;
  accountId: string | null;
  source: "d1" | "fixtures";
}

export async function selectRepository(
  env: Env,
  bodyLoaderFactory: BodyLoaderFactory,
): Promise<SelectedRepository> {
  if (!env.DB) {
    return { repository: new FixtureMailRepository(), accountId: null, source: "fixtures" };
  }
  let row: { id: string } | null = null;
  try {
    row = await env.DB.prepare(
      "SELECT id FROM accounts WHERE status = 'active' ORDER BY created_at ASC LIMIT 1",
    )
      .bind()
      .first<{ id: string }>();
  } catch {
    // Migrations have not been applied yet. Fixtures keep the UI usable so a
    // fresh install is not a blank page before `wrangler d1 migrations apply`.
    return { repository: new FixtureMailRepository(), accountId: null, source: "fixtures" };
  }
  if (!row) {
    return { repository: new FixtureMailRepository(), accountId: null, source: "fixtures" };
  }
  return {
    repository: new D1MailRepository(env.DB, row.id, bodyLoaderFactory(row.id)),
    accountId: row.id,
    source: "d1",
  };
}
