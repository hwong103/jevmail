// Read-side routes. The integrator mounts this; the repository is injected so
// the same router serves fixtures locally and D1 in production.
//
// Every route here is read-only. No Gmail mutation endpoints exist in v1: the
// policy engine observes, and manual actions ship in a later gate.

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { answerValueSchema, questionSchema } from "../contracts/dto";
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_CAP, type MailRepository } from "../server/mail/repository";

type MailEnv = {
  Bindings: object;
  Variables: { repository: MailRepository; actorId: string };
};

const listQuery = z.object({
  tray: z.string().default("needs_reply"),
  pageToken: z.string().nullable().optional(),
  limit: z.coerce.number().int().positive().max(PAGE_SIZE_CAP).default(DEFAULT_PAGE_SIZE),
});

const correctionBody = z.object({
  changes: z
    .array(
      z.object({
        question: questionSchema,
        operation: z.enum(["set", "clear"]),
        value: answerValueSchema.optional(),
      }),
    )
    .min(1),
});

export function createMailRouter(): Hono<MailEnv> {
  const app = new Hono<MailEnv>();

  app.get("/messages", zValidator("query", listQuery), async (c) => {
    const query = c.req.valid("query");
    return c.json(
      await c.var.repository.list({
        tray: query.tray,
        limit: query.limit,
        pageToken: query.pageToken ?? null,
      }),
    );
  });

  app.get("/messages/:id/body", async (c) => {
    const body = await c.var.repository.body(c.req.param("id"));
    if (!body) return c.json({ error: "not_found" }, 404);
    // No-store: a body is transient and must not be cached by the browser or
    // an intermediary.
    c.header("Cache-Control", "no-store");
    return c.json(body);
  });

  app.get("/sync-status", async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(await c.var.repository.syncStatus());
  });

  app.get("/automation", async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(await c.var.repository.automationStatus());
  });

  app.post("/messages/:id/corrections", zValidator("json", correctionBody), async (c) => {
    const { changes } = c.req.valid("json");
    const result = await c.var.repository.recordCorrection(
      c.req.param("id"),
      changes,
      c.var.actorId,
    );
    return c.json({
      gmailMessageId: c.req.param("id"),
      revision: result.revision,
      appliedAt: Date.now(),
      reclassified: result.reclassified,
    });
  });

  return app;
}
