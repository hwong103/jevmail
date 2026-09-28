import { describe, expect, it } from "vitest";
import { ACTION_KINDS, type Answers } from "../src/contracts/domain";
import { effectiveDecision, latestCorrections } from "../src/contracts/effective";
import { placeInTray } from "../src/contracts/trays";
import type { Correction } from "../src/contracts/domain";
import { answers } from "./fixtures/answers";

describe("action vocabulary", () => {
  it("cannot express sending or drafting", () => {
    expect(ACTION_KINDS).not.toContain("sendDraft");
    expect(ACTION_KINDS).not.toContain("createDraft");
    expect(ACTION_KINDS).not.toContain("trash");
  });
});

describe("correction precedence", () => {
  const base = answers({
    category: { state: "value", value: "marketing", confidence: 0.9, distribution: null },
  });

  it("a correction set beats the model and does not fabricate confidence", () => {
    const correction: Correction = {
      id: "c1",
      accountId: "a1",
      gmailMessageId: "m1",
      revision: 1,
      changes: [{ question: "category", operation: "set", value: "work" }],
      observedInputHash: "h",
      createdAt: 1,
      actorId: "p1",
    };
    const result = effectiveDecision(base, [correction]);
    expect(result.answers.category).toEqual({
      state: "value",
      value: "work",
      confidence: null,
      distribution: null,
    });
    expect(result.correctionRevision).toBe(1);
  });

  it("a clear re-exposes the model answer", () => {
    const set: Correction = {
      id: "c1",
      accountId: "a1",
      gmailMessageId: "m1",
      revision: 1,
      changes: [{ question: "category", operation: "set", value: "work" }],
      observedInputHash: null,
      createdAt: 1,
      actorId: "p1",
    };
    const clear: Correction = {
      ...set,
      id: "c2",
      revision: 2,
      changes: [{ question: "category", operation: "clear" }],
    };
    const result = effectiveDecision(base, [set, clear]);
    expect(result.answers.category).toEqual(base.category);
    expect(latestCorrections([set, clear]).size).toBe(0);
  });

  it("ignores stale revisions", () => {
    const older: Correction = {
      id: "c1",
      accountId: "a1",
      gmailMessageId: "m1",
      revision: 1,
      changes: [{ question: "category", operation: "set", value: "work" }],
      observedInputHash: null,
      createdAt: 1,
      actorId: "p1",
    };
    const newer: Correction = {
      ...older,
      id: "c2",
      revision: 2,
      changes: [{ question: "category", operation: "set", value: "personal" }],
    };
    const result = effectiveDecision(base, [older, newer]);
    expect(result.answers.category.state === "value" && result.answers.category.value).toBe("personal");
  });
});

describe("tray placement", () => {
  it("routes missing bodies to review rather than low priority", () => {
    const placement = placeInTray(answers(), "missing_body");
    expect(placement.tray).toBe("review");
    expect(placement.uncertain).toBe(true);
  });

  it("routes unanswered needs_reply to review", () => {
    const partial = {
      ...answers(),
      needsReply: { state: "unknown", reason: "invalid" },
    } as unknown as Answers;
    expect(placeInTray(partial, "complete").tray).toBe("review");
  });

  it("a high category probability does not stand in for needs_action", () => {
    const certain: Answers = answers({
      category: { state: "value", value: "transactional", confidence: 0.99, distribution: null },
      needsAction: { state: "value", value: true, confidence: 0.2, distribution: null },
    });
    expect(placeInTray(certain, "complete").tray).toBe("review");
  });

  it("places confident reply-needed mail in needs_reply", () => {
    const reply: Answers = answers({
      needsReply: { state: "value", value: true, confidence: 0.9, distribution: null },
    });
    expect(placeInTray(reply, "complete").tray).toBe("needs_reply");
  });

  it("places low-urgency marketing in low priority only when confident", () => {
    const promo: Answers = answers({
      category: { state: "value", value: "marketing", confidence: 0.9, distribution: null },
      urgency: { state: "value", value: 1, confidence: 0.8, distribution: null },
      importance: { state: "value", value: 1, confidence: 0.8, distribution: null },
    });
    expect(placeInTray(promo, "complete").tray).toBe("low_priority");
  });

  it("routes truncated input to review instead of judging it complete", () => {
    expect(placeInTray(answers(), "truncated").tray).toBe("review");
  });
});
