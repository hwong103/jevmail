// Gate A proofs that are verifiable without external credentials: migrations
// from empty, query plans, worker boot, auth rejection, and cron behaviour.
//
// Proofs that CANNOT be verified here (OAuth consent, provider latency, a real
// scheduled invocation on Cloudflare, Jev response shape) are recorded in
// docs/spike-status.md rather than faked.

import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { parseEnvelope } from "../src/server/jobs/consumer";
import { runSync } from "../src/server/sync/cron";
import { applyMigrations, seedAccount, seedMessages } from "./helpers/migrations";

const db = (env as unknown as { DB: D1Database }).DB;

describe("migrations apply from empty", () => {
  beforeAll(() => applyMigrations(db));

  it("creates every table", async () => {
    const result = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all<{ name: string }>();
    const names = result.results.map((r) => r.name);
    for (const table of ["principals", "accounts", "messages", "classifications", "jobs", "outbox"]) {
      expect(names).toContain(table);
    }
  });

  it("stores no message body, snippet, or extracted text", async () => {
    const result = await db.prepare("PRAGMA table_info(messages)").all<{ name: string }>();
    const columns = result.results.map((r) => r.name);
    for (const forbidden of ["body", "snippet", "text", "content", "extracted"]) {
      expect(columns).not.toContain(forbidden);
    }
    expect(columns).toContain("sender");
    expect(columns).toContain("subject");
  });

  it("enforces a single owner principal", async () => {
    await db
      .prepare("INSERT INTO principals (id, google_sub, email, bound_at, is_owner) VALUES ('p1', 'sub-1', 'a@example.com', 1, 1)")
      .run();
    await expect(
      db
        .prepare("INSERT INTO principals (id, google_sub, email, bound_at, is_owner) VALUES ('p2', 'sub-2', 'b@example.com', 1, 1)")
        .run(),
    ).rejects.toThrow();
  });
});

describe("query plans use indexes on hot tables", () => {
  beforeAll(async () => {
    await applyMigrations(db);
    await seedAccount(db);
    await seedMessages(db);
  });

  async function plan(sql: string): Promise<string> {
    const result = await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all<{ detail: string }>();
    return result.results.map((r) => r.detail).join(" | ");
  }

  it("the tray query uses an index, not a scan", async () => {
    const detail = await plan(
      "SELECT id, subject, received_at FROM messages WHERE account_id = 'a1' ORDER BY received_at DESC LIMIT 50",
    );
    expect(detail).toMatch(/USING (COVERING )?INDEX/i);
    expect(detail).not.toMatch(/\bSCAN messages\b/);
  });

  it("the unread filter uses an index", async () => {
    const detail = await plan(
      "SELECT id FROM messages WHERE account_id = 'a1' AND is_unread = 1 ORDER BY received_at DESC LIMIT 50",
    );
    expect(detail).toMatch(/USING (COVERING )?INDEX/i);
    expect(detail).not.toMatch(/\bSCAN messages\b/);
  });

  it("the job poll uses an index", async () => {
    const detail = await plan("SELECT id FROM jobs WHERE state = 'ready' AND available_at < 1 LIMIT 10");
    expect(detail).toMatch(/USING (COVERING )?INDEX/i);
    expect(detail).not.toMatch(/\bSCAN jobs\b/);
  });

  it("reports a bounded read count for a mailbox page", async () => {
    const result = await db
      .prepare(
        "SELECT id, subject, received_at FROM messages WHERE account_id = 'a1' ORDER BY received_at DESC LIMIT 50",
      )
      .all();
    // Miniflare exposes meta.rows_read; production D1 does too. The budget from
    // PLAN-v2 is 300 rows per page, so a 50-row page must not scan the table.
    const rowsRead = (result.meta as { rows_read?: number } | undefined)?.rows_read;
    if (typeof rowsRead === "number") {
      expect(rowsRead).toBeLessThanOrEqual(300);
    }
    expect(result.results.length).toBeLessThanOrEqual(50);
  });
});

describe("worker boot and auth rejection", () => {
  it("reports health without leaking configuration", async () => {
    const response = await SELF.fetch("https://worker.local/health");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/@|secret|token|key/i);
  });

  it("rejects an unknown path", async () => {
    const response = await SELF.fetch("https://worker.local/nope");
    expect(response.status).toBe(404);
  });
});

describe("cron on a fresh installation", () => {
  it("is a harmless no-op when no mailbox is connected", async () => {
    // The pool shares one database across this file's tests, and the query-plan
    // suite above seeds an account. Re-apply the schema so this test is the
    // fresh-install case it claims to be.
    await applyMigrations(db);
    const result = await runSync({ DB: db } as never);
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("no_account_connected");
  });
});

describe("queue envelope validation", () => {
  it("accepts an id-only envelope", () => {
    expect(parseEnvelope({ version: 1, jobId: "job-1" })).toEqual({ version: 1, jobId: "job-1" });
  });

  it("rejects a payload carrying anything else", () => {
    expect(parseEnvelope({ version: 1, jobId: "job-1", body: "secret" })).toBeNull();
    expect(parseEnvelope({ version: 2, jobId: "job-1" })).toBeNull();
    expect(parseEnvelope({ version: 1 })).toBeNull();
    expect(parseEnvelope(null)).toBeNull();
    expect(parseEnvelope("job-1")).toBeNull();
  });
});
