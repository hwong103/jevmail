// Security boundary tests. Three properties must hold for the repo to be safe
// to publish: the live API fails closed, the OAuth state is verified, and the
// synthetic-fixture demo stays open.

import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signSession } from "../src/server/auth/session";
import { applyMigrations, seedAccount, seedMessages } from "./helpers/migrations";

const db = (env as unknown as { DB: D1Database }).DB;
const SESSION_SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;

const CORRECTION = JSON.stringify({
  changes: [{ question: "category", operation: "set", value: "work" }],
});

async function seedLiveAccount(): Promise<void> {
  await applyMigrations(db);
  await seedAccount(db);
  await seedMessages(db, 1);
}

describe("live API fails closed", () => {
  it("rejects an anonymous read with 401", async () => {
    await seedLiveAccount();
    const response = await SELF.fetch("https://worker.local/api/messages?tray=all");
    expect(response.status).toBe(401);
  });

  it("rejects an anonymous correction write with 401", async () => {
    await seedLiveAccount();
    const response = await SELF.fetch("https://worker.local/api/messages/g0/corrections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: CORRECTION,
    });
    expect(response.status).toBe(401);
  });

  it("rejects a forged session token", async () => {
    await seedLiveAccount();
    const response = await SELF.fetch("https://worker.local/api/messages?tray=all", {
      headers: { Cookie: "jevmail_session=forged.signature" },
    });
    expect(response.status).toBe(401);
  });

  it("serves live data and derives actorId from the session principal", async () => {
    await seedLiveAccount();
    const token = await signSession(SESSION_SECRET, "p1");
    const cookie = `jevmail_session=${token}`;

    const listed = await SELF.fetch("https://worker.local/api/messages?tray=all", {
      headers: { Cookie: cookie },
    });
    expect(listed.status).toBe(200);

    const written = await SELF.fetch("https://worker.local/api/messages/g0/corrections", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: CORRECTION,
    });
    expect(written.status).toBe(200);

    // The correction is attributed to the session principal, never to a literal.
    const row = await db
      .prepare(
        "SELECT actor_id FROM corrections WHERE gmail_message_id = 'g0' ORDER BY created_at DESC LIMIT 1",
      )
      .bind()
      .first<{ actor_id: string }>();
    expect(row?.actor_id).toBe("p1");
  });
});

describe("fixture demo stays open", () => {
  it("serves fixtures to an anonymous request when no account row exists", async () => {
    // Schema present, but no account row: the worker must fall back to
    // synthetic fixtures without requiring a session. applyMigrations drops and
    // recreates every table, so this is independent of test ordering.
    await applyMigrations(db);
    const response = await SELF.fetch("https://worker.local/api/messages?tray=all");
    expect(response.status).toBe(200);
  });
});

describe("oauth state is verified", () => {
  it("rejects a callback with no state cookie", async () => {
    const response = await SELF.fetch("https://worker.local/auth/callback?code=c&state=s");
    expect(response.status).toBe(400);
  });

  it("rejects a callback whose state does not match the cookie", async () => {
    const response = await SELF.fetch("https://worker.local/auth/callback?code=c&state=mismatch", {
      headers: { Cookie: "jevmail_oauth_state=expected" },
    });
    expect(response.status).toBe(400);
  });

  it("rejects a callback with no state parameter", async () => {
    const response = await SELF.fetch("https://worker.local/auth/callback?code=c");
    expect(response.status).toBe(400);
  });
});
