// Worker entry point. The integrator owns route composition: workers export
// routers and handlers, only this file mounts them.

import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { isConfigured, type Env } from "./runtime/env";
import { createAuthRouter } from "./routes/auth";
import { createMailRouter } from "./routes/mail";
import { SESSION_COOKIE, verifySession } from "./server/auth/session";
import type { MailRepository } from "./server/mail/repository";
import { handleJob } from "./server/jobs/consumer";
import { scheduledSync } from "./server/sync/cron";
import { selectRepository, type BodyLoader } from "./runtime/repository";

type AppEnv = {
  Bindings: Env;
  Variables: { repository: MailRepository; actorId: string };
};

const app = new Hono<AppEnv>();

app.get("/health", (c) =>
  c.json({
    ok: true,
    build: c.env.WORKER_VERSION ?? "dev",
    configured: isConfigured(c.env),
    // Public template: no installation-specific identifiers are echoed.
  }),
);

// Until a mailbox is connected, the read side runs on synthetic fixtures. Once
// an account row exists the same routes are served from D1, and the client
// cannot tell the difference.
//
// Fixtures are cached per isolate so a correction survives the next request.
// Building a fresh repository per request looked harmless but silently
// discarded every correction: the write landed in an instance the next read
// could not see.
let cachedFixtures: MailRepository | null = null;

app.use("/api/*", async (c, next) => {
  const bodyLoader: BodyLoader = async () => null;
  const selected = await selectRepository(c.env, bodyLoader);

  if (selected.source === "d1") {
    // Live data fails closed: no valid session means no mailbox metadata and no
    // corrections. `actorId` comes from the signed session principal, never a
    // literal, so a real correction references the real principal.
    const secret = c.env.SESSION_SECRET ?? c.env.AUTH_SECRET;
    const session = await verifySession(secret, getCookie(c, SESSION_COOKIE));
    if (!session) return c.json({ error: "unauthorized" }, 401);
    c.set("repository", selected.repository);
    c.set("actorId", session.principalId);
    await next();
    return;
  }

  // No account row: the synthetic-fixture demo stays freely readable so local
  // dev and the existing browser evidence keep working.
  if (!cachedFixtures) {
    const { FixtureMailRepository } = await import("./server/mail/fixtures");
    cachedFixtures = new FixtureMailRepository();
  }
  c.set("repository", cachedFixtures as MailRepository);
  c.set("actorId", "fixture-actor");
  await next();
});

app.route("/api", createMailRouter());
app.route("/", createAuthRouter());

app.notFound((c) => c.json({ error: "not_found" }, 404));

export default {
  fetch: app.fetch,
  // Cron: mailbox sync. Push notifications are deferred by design.
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await scheduledSync(controller, env);
  },
  // Queue: classify, evaluate, apply, reconcile. ID-only envelopes.
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    await handleJob(batch, env);
  },
} satisfies ExportedHandler<Env>;
