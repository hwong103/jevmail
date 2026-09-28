// Worker entry point. The integrator owns route composition: workers export
// routers and handlers, only this file mounts them.

import { Hono } from "hono";
import { isConfigured, type Env } from "./runtime/env";
import { createMailRouter } from "./routes/mail";
import { FixtureMailRepository } from "./server/mail/fixtures";
import type { MailRepository } from "./server/mail/repository";
import { handleJob } from "./server/jobs/consumer";
import { scheduledSync } from "./server/sync/cron";

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

// Until a mailbox is connected, the read side runs on synthetic fixtures.
//
// One instance is shared across requests in an isolate, matching the lifetime a
// D1 repository would have. Building a new repository per request looked
// harmless but silently discarded every correction: the write landed in an
// instance the next read could not see.
const fixtureRepository = new FixtureMailRepository();

app.use("/api/*", async (c, next) => {
  c.set("repository", fixtureRepository);
  c.set("actorId", "fixture-actor");
  await next();
});

app.route("/api", createMailRouter());

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
