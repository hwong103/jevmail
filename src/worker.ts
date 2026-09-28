// Worker entry point. The integrator owns route composition: workers export
// routers and handlers, only this file mounts them.

import { Hono } from "hono";
import { isConfigured, type Env } from "./runtime/env";
import { handleJob } from "./server/jobs/consumer";
import { scheduledSync } from "./server/sync/cron";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) =>
  c.json({
    ok: true,
    build: c.env.WORKER_VERSION ?? "dev",
    configured: isConfigured(c.env),
    // Public template: no installation-specific identifiers are echoed.
  }),
);

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
