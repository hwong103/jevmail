// Command Code Provider API adapter tests. No live call is made: `fetch` is
// stubbed and every response is a fixture. The happy-path body mirrors the
// documented System One shape (the same shape the Workers AI port returns), so
// the shared interpreter is proven against the wire format rather than an
// assumption about it.

import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyMessage, isProviderAuthError } from "../src/server/classification/classify";
import {
  COMMAND_CODE_BASE_URL,
  CommandCodeConfigError,
  CommandCodeJevPort,
  SYSTEMONE_PATH,
} from "../src/server/classification/commandcode";
import { normalizeMessage } from "../src/server/gmail/normalize";
import { buildClassificationPort } from "../src/server/jobs/deps";
import type { Env } from "../src/runtime/env";
import { textMessage } from "./fixtures/gmail";

afterEach(() => {
  vi.unstubAllGlobals();
});

function normalized(subject = "Review?", body = "Could you review this?") {
  const { message, headers } = textMessage({
    id: "m1",
    from: "dana@example.com",
    subject,
    body,
  });
  return normalizeMessage({ accountId: "a1", message, headers, threadContextIds: [] });
}

/** The same documented response the Workers AI port is proven against. */
const DOC_RESPONSE = {
  model: "typesafe/jev",
  answers: {
    needsReply: { type: "noul", noul: 0.95 },
    category: {
      type: "choice",
      choice: "work",
      confidence: 0.8,
      probabilities: { work: 0.87, marketing: 0, personal: 0.13 },
    },
    needsAction: { type: "noul", noul: 0.08 },
    urgency: { type: "score", score: 1.04, confidence: 0.94 },
    importance: { type: "score", score: 0, confidence: 0.5 },
    senderType: { type: "choice", choice: "person", confidence: 0.77 },
  },
  usage: { input_tokens: 426, output_tokens: 73 },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("CommandCodeJevPort request shape", () => {
  it("posts the model, state, and questions with a Bearer header", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse(DOC_RESPONSE);
    });

    const port = new CommandCodeJevPort({ apiKey: "secret-key" });
    await port.classify(normalized());

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(`${COMMAND_CODE_BASE_URL}${SYSTEMONE_PATH}`);
    expect(call.init.method).toBe("POST");
    const headers = call.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret-key");
    expect(headers["Content-Type"]).toBe("application/json");
    // No ZDR header: typesafe/jev has no ZDR upstream, so sending one is refused.
    expect(headers["x-cmd-zdr"]).toBeUndefined();

    const sent = JSON.parse(String(call.init.body)) as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(["model", "questions", "state"]);
    expect(sent.model).toBe("typesafe/jev");
    expect(sent.state).toMatchObject({ from: "dana@example.com", subject: "Review?" });
    expect(sent.questions).toMatchObject({ category: { type: "choice" } });
  });

  it("never follows a redirect, so the Bearer key and mail body cannot be replayed elsewhere", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse(DOC_RESPONSE);
    });

    await new CommandCodeJevPort({ apiKey: "secret-key" }).classify(normalized());

    // `redirect: "error"` turns a 3xx into a thrown failure rather than a follow
    // that forwards Authorization and replays the POST body to another host.
    expect(calls[0]!.init.redirect).toBe("error");
  });
});

describe("CommandCodeJevPort base URL validation", () => {
  it("rejects a non-loopback plain-http base URL", () => {
    expect(() => new CommandCodeJevPort({ apiKey: "k", baseUrl: "http://example.com" })).toThrow(
      CommandCodeConfigError,
    );
    expect(() => new CommandCodeJevPort({ apiKey: "k", baseUrl: "http://example.com" })).toThrow(
      /HTTPS/,
    );
  });

  it("allows plain http only for loopback development hosts", () => {
    for (const baseUrl of ["http://localhost:8080", "http://127.0.0.1:9", "http://[::1]:9"]) {
      expect(() => new CommandCodeJevPort({ apiKey: "k", baseUrl })).not.toThrow();
    }
  });

  it("applies the same check to a JEV_BASE_URL selected through the env", () => {
    expect(() =>
      buildClassificationPort({
        JEV_API_KEY: "k",
        JEV_BASE_URL: "http://example.com",
      } as unknown as Env),
    ).toThrow(CommandCodeConfigError);
    expect(
      buildClassificationPort({
        JEV_API_KEY: "k",
        JEV_BASE_URL: "http://localhost:8080",
      } as unknown as Env),
    ).toBeInstanceOf(CommandCodeJevPort);
  });
});

describe("CommandCodeJevPort responses", () => {
  it("returns correct typed answers with confidences", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse(DOC_RESPONSE));
    const port = new CommandCodeJevPort({ apiKey: "secret-key" });

    const outcome = await classifyMessage(port, normalized());

    expect(outcome.status).toBe("complete");
    expect(outcome.modelVersion).toBe("typesafe/jev");
    const category = outcome.answers.category;
    expect(category.state === "value" && category.value).toBe("work");
    expect(category.state === "value" && category.confidence).toBe(0.8);
    const needsReply = outcome.answers.needsReply;
    expect(needsReply.state === "value" && needsReply.value).toBe(true);
    expect(needsReply.state === "value" && needsReply.confidence).toBe(0.95);
  });

  it("turns a malformed/empty answers object into an explicit unknown, never a default", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse({ model: "typesafe/jev", answers: {} }));
    const port = new CommandCodeJevPort({ apiKey: "secret-key" });

    const outcome = await classifyMessage(port, normalized());

    expect(outcome.status).toBe("review");
    // Every question is unusable: `unknown`, not a confident default.
    expect(outcome.answers.category).toEqual({ state: "unknown", reason: "invalid" });
    expect(outcome.answers.urgency).toEqual({ state: "unknown", reason: "invalid" });
  });
});

describe("CommandCodeJevPort error mapping", () => {
  it("throws a retryable error on 429", async () => {
    vi.stubGlobal("fetch", async () =>
      jsonResponse({ error: { message: "slow down", type: "rate_limit_error" } }, 429),
    );
    const port = new CommandCodeJevPort({ apiKey: "secret-key" });

    await expect(port.classify(normalized())).rejects.toMatchObject({
      kind: "retryable",
      status: 429,
    });
  });

  it("throws a retryable error on 500", async () => {
    vi.stubGlobal("fetch", async () =>
      jsonResponse({ error: { message: "boom", type: "server_error" } }, 500),
    );
    const port = new CommandCodeJevPort({ apiKey: "secret-key" });

    await expect(port.classify(normalized())).rejects.toMatchObject({
      kind: "retryable",
      status: 500,
    });
  });

  it("throws a retryable error when the network fails", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("network down");
    });
    const port = new CommandCodeJevPort({ apiKey: "secret-key" });

    await expect(port.classify(normalized())).rejects.toMatchObject({
      kind: "retryable",
      status: 0,
    });
  });

  it("throws an auth error on 401 and re-throws it through classifyMessage", async () => {
    vi.stubGlobal("fetch", async () =>
      jsonResponse({ error: { message: "bad key", type: "authentication_error" } }, 401),
    );
    const port = new CommandCodeJevPort({ apiKey: "wrong" });

    await expect(port.classify(normalized())).rejects.toMatchObject({
      kind: "auth",
      status: 401,
    });
    // classifyMessage must surface the auth failure as an exception (so the job
    // layer can park it) rather than swallow it as a retryable failure.
    const caught = await classifyMessage(port, normalized()).catch((error: unknown) => error);
    expect(isProviderAuthError(caught)).toBe(true);
  });

  it("throws an auth error on 403", async () => {
    vi.stubGlobal("fetch", async () =>
      jsonResponse({ error: { message: "upgrade", type: "upgrade_required" } }, 403),
    );
    const port = new CommandCodeJevPort({ apiKey: "secret-key" });

    await expect(port.classify(normalized())).rejects.toMatchObject({
      kind: "auth",
      status: 403,
    });
  });
});
