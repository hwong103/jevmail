// Deterministic classification fixture. Used by tests and local development so
// the vertical slice is provable without a provider account. The real provider
// adapter replaces this; the port stays the same.

import type { NormalizedMessage } from "../../contracts/domain";
import type { ClassificationPort, RawClassification } from "./classify";

interface FixtureRule {
  match: (message: NormalizedMessage) => boolean;
  raw: Record<string, unknown>;
}

function haystack(message: NormalizedMessage): string {
  return `${message.subject} ${message.text ?? ""}`;
}

const RULES: FixtureRule[] = [
  {
    match: (m) => /receipt|invoice|order|delivery|payment/i.test(haystack(m)),
    raw: {
      category: "transactional",
      categoryConfidence: 0.9,
      needsReply: false,
      needsReplyConfidence: 0.85,
      needsAction: false,
      needsActionConfidence: 0.8,
      urgency: 2,
      urgencyConfidence: 0.7,
      importance: 3,
      importanceConfidence: 0.7,
      senderType: "automated",
      senderTypeConfidence: 0.9,
    },
  },
  {
    match: (m) => /unsubscribe|sale|offer|discount|% off|promo/i.test(haystack(m)),
    raw: {
      category: "marketing",
      categoryConfidence: 0.92,
      needsReply: false,
      needsReplyConfidence: 0.9,
      needsAction: false,
      needsActionConfidence: 0.88,
      urgency: 1,
      urgencyConfidence: 0.8,
      importance: 1,
      importanceConfidence: 0.82,
      senderType: "organization",
      senderTypeConfidence: 0.85,
    },
  },
  {
    match: (m) => /\?$|could you|can you|please review|following up|your input/i.test(m.subject),
    raw: {
      category: "work",
      categoryConfidence: 0.75,
      needsReply: true,
      needsReplyConfidence: 0.82,
      needsAction: true,
      needsActionConfidence: 0.78,
      urgency: 3,
      urgencyConfidence: 0.65,
      importance: 4,
      importanceConfidence: 0.7,
      senderType: "person",
      senderTypeConfidence: 0.8,
    },
  },
];

export const FIXTURE_MODEL_VERSION = "fixture-v1";

export function createFixturePort(): ClassificationPort {
  return {
    async classify(message: NormalizedMessage): Promise<RawClassification> {
      for (const rule of RULES) {
        if (rule.match(message)) {
          return {
            modelVersion: FIXTURE_MODEL_VERSION,
            promptVersion: 1,
            schemaVersion: 1,
            raw: rule.raw,
          };
        }
      }
      return {
        modelVersion: FIXTURE_MODEL_VERSION,
        promptVersion: 1,
        schemaVersion: 1,
        raw: {
          category: "other",
          categoryConfidence: 0.4,
          needsReply: false,
          needsReplyConfidence: 0.55,
          needsAction: false,
          needsActionConfidence: 0.55,
          urgency: 3,
          urgencyConfidence: 0.4,
          importance: 3,
          importanceConfidence: 0.4,
          senderType: "unknown",
          senderTypeConfidence: 0.35,
        },
      };
    },
  };
}
