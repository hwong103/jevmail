// Jev adapter tests.
//
// The happy-path fixture below mirrors the literal response from Cloudflare's
// published `typesafe/jev` documentation, including its quirks: a noul with no
// confidence field, a choice with both confidence and probabilities, and a
// score whose level is fractional and zero-indexed. The adapter is proven
// against that shape rather than against an assumption about it.

import { describe, expect, it } from "vitest";
import { classifyMessage, normalizeRaw } from "../src/server/classification/classify";
import {
  JevClassificationPort,
  JEV_MODEL,
  buildQuestions,
  buildState,
  interpret,
  type AiBinding,
} from "../src/server/classification/jev";
import { normalizeMessage } from "../src/server/gmail/normalize";
import { textMessage } from "./fixtures/gmail";

const DOC_RESPONSE = {
  model: "jev-1.13.0",
  answers: {
    needsReply: { type: "noul", noul: 0.95 },
    category: {
      type: "choice",
      choice: "work",
      confidence: 0.8,
      probabilities: { work: 0.87, marketing: 0, personal: 0.13 },
    },
    needsAction: { type: "noul", noul: 0.08 },
    urgency: {
      type: "score",
      score: 1.04,
      confidence: 0.94,
      probabilities: { "0": 0, "1": 0.96, "2": 0.04 },
    },
    importance: { type: "score", score: 0, confidence: 0.5 },
    senderType: { type: "choice", choice: "person", confidence: 0.77 },
  },
  usage: { input_tokens: 426, output_tokens: 73 },
};

describe("interpret", () => {
  it("reads the documented response correctly", () => {
    const result = interpret(DOC_RESPONSE);
    expect(result.modelVersion).toBe("jev-1.13.0");
    expect(result.promptVersion).toBe(1);
    expect(result.raw.category).toBe("work");
    expect(result.raw.categoryConfidence).toBe(0.8);
  });

  it("treats a noul as a boolean with the probability as its confidence", () => {
    const result = interpret(DOC_RESPONSE);
    // 0.95 yes-probability.
    expect(result.raw.needsReply).toBe(true);
    expect(result.raw.needsReplyConfidence).toBe(0.95);
    // 0.08 yes-probability, so false with 0.08 certainty.
    expect(result.raw.needsAction).toBe(false);
    expect(result.raw.needsActionConfidence).toBe(0.08);
  });

  it("keeps a choice's confidence separate from its probabilities", () => {
    const result = interpret(DOC_RESPONSE);
    // Confidence is 0.8; the chosen option's probability is 0.87. Collapsing
    // them would misreport what the model actually said.
    expect(result.raw.categoryConfidence).toBe(0.8);
    expect(result.raw.categoryDistribution).toEqual([
      { value: "work", probability: 0.87 },
      { value: "marketing", probability: 0 },
      { value: "personal", probability: 0.13 },
    ]);
  });

  it("shifts a zero-indexed fractional score into 1..5", () => {
    const result = interpret(DOC_RESPONSE);
    // 1.04 rounds to 1, which is level index 1, which is 2 on a 1..5 scale.
    expect(result.raw.urgency).toBe(2);
    expect(result.raw.urgencyConfidence).toBe(0.94);
    // A level of 0 becomes 1, never 0.
    expect(result.raw.importance).toBe(1);
  });

  it("leaves a missing answer absent rather than defaulting it", () => {
    const result = interpret({
      model: "jev-1.13.0",
      answers: { category: { type: "choice", choice: "work" } },
    });
    expect(result.raw.category).toBe("work");
    // The answer exists, but no confidence was stated, so it is null. The value
    // is not downgraded and no number is invented.
    expect(result.raw.categoryConfidence).toBeNull();
    // A question the provider did not answer at all is absent entirely.
    expect(result.raw.urgency).toBeUndefined();
  });

  it("keeps boolean confidence absent when a noul has no yes-probability", () => {
    const result = interpret({
      model: "jev-1.13.0",
      answers: {
        needsReply: { type: "noul" },
        needsAction: { type: "noul", noul: undefined },
      },
    });
    // Absent probability: no derived value and no invented confidence.
    expect(result.raw.needsReply).toBeUndefined();
    expect(result.raw.needsReplyConfidence).toBeUndefined();
    expect(result.raw.needsAction).toBeUndefined();
    expect(result.raw.needsActionConfidence).toBeUndefined();
    // Through the normaliser it is `unknown` with no confidence field, never a
    // value carrying a 0 or NaN confidence.
    const needsReply = normalizeRaw(result).answers.needsReply;
    expect(needsReply.state).toBe("unknown");
    expect(needsReply).not.toHaveProperty("confidence");
  });

  it("rejects an out-of-range confidence instead of clamping it", () => {
    const result = interpret({
      answers: { category: { type: "choice", choice: "work", confidence: 1.8 } },
    });
    expect(result.raw.categoryConfidence).toBeNull();
  });

  it("survives a completely malformed response", () => {
    for (const input of [null, undefined, {}, { answers: null }, "nope", 42]) {
      const result = interpret(input);
      expect(result.raw.category).toBeUndefined();
      // Every question unusable means the message goes to review, not a tray.
      expect(normalizeRaw(result).status).toBe("review");
    }
  });
});

describe("question schema", () => {
  it("asks every question the app stores", () => {
    expect(Object.keys(buildQuestions()).sort()).toEqual(
      ["category", "importance", "needsAction", "needsReply", "senderType", "urgency"].sort(),
    );
  });

  it("uses noul for booleans, choice for categories, score for ratings", () => {
    const questions = buildQuestions();
    expect(questions.needsReply.type).toBe("noul");
    expect(questions.needsAction.type).toBe("noul");
    expect(questions.category.type).toBe("choice");
    expect(questions.senderType.type).toBe("choice");
    expect(questions.urgency.type).toBe("score");
  });
});

describe("buildState", () => {
  it("sends the body and nothing else transient", () => {
    const { message, headers } = textMessage({
      id: "m1",
      from: "a@example.com",
      subject: "Hello",
      body: "Body text",
    });
    const normalized = normalizeMessage({ accountId: "a1", message, headers, threadContextIds: [] });
    const state = buildState(normalized);
    expect(state.body).toBe("Body text");
    expect(state.from).toBe("a@example.com");
    expect(state.input_quality).toBe("complete");
    expect(Object.keys(state).sort()).toEqual([
      "body",
      "from",
      "input_quality",
      "received_at",
      "subject",
      "thread_message_count",
    ]);
  });
});

describe("JevClassificationPort", () => {
  it("calls the documented model id and returns an interpretable result", async () => {
    let seenModel = "";
    const ai: AiBinding = {
      async run(model) {
        seenModel = model;
        return DOC_RESPONSE;
      },
    };
    const { message, headers } = textMessage({
      id: "m1",
      from: "dana@example.com",
      subject: "Review?",
      body: "Could you review this?",
    });
    const normalized = normalizeMessage({ accountId: "a1", message, headers, threadContextIds: [] });
    const outcome = await classifyMessage(new JevClassificationPort(ai), normalized);

    expect(seenModel).toBe(JEV_MODEL);
    expect(outcome.status).toBe("complete");
    const category = outcome.answers.category;
    expect(category.state === "value" && category.value).toBe("work");
  });

  it("surfaces a provider failure as a retryable failure, not a verdict", async () => {
    const ai: AiBinding = {
      async run() {
        throw new Error("gateway timeout");
      },
    };
    const { message, headers } = textMessage({
      id: "m2",
      from: "a@example.com",
      subject: "Hello",
      body: "Body",
    });
    const normalized = normalizeMessage({ accountId: "a1", message, headers, threadContextIds: [] });
    const outcome = await classifyMessage(new JevClassificationPort(ai), normalized);
    expect(outcome.status).toBe("failed");
    expect(outcome.answers.category).toEqual({ state: "unknown", reason: "provider_error" });
  });
});
