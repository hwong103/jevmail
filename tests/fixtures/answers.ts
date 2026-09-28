import type { Answers } from "../../src/contracts/domain";

export function answers(overrides: Partial<Answers> = {}): Answers {
  return {
    category: { state: "value", value: "other", confidence: 0.8, distribution: null },
    needsReply: { state: "value", value: false, confidence: 0.8, distribution: null },
    needsAction: { state: "value", value: false, confidence: 0.8, distribution: null },
    urgency: { state: "value", value: 3, confidence: 0.7, distribution: null },
    importance: { state: "value", value: 3, confidence: 0.7, distribution: null },
    senderType: { state: "value", value: "organization", confidence: 0.8, distribution: null },
    ...overrides,
  } as Answers;
}
