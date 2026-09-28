// Tray derivation. Worker B owns this; worker D displays the result and must not
// reimplement it.
//
// Every rule is deliberately conservative: uncertainty routes to Review rather
// than to a confident low-priority verdict. A missing answer is not evidence of
// low importance.

import type { Answers, InputQuality, Rating } from "./domain";

export const TRAYS = [
  "needs_reply",
  "action",
  "review",
  "updates",
  "low_priority",
] as const;

export type Tray = (typeof TRAYS)[number];

export interface TrayPlacement {
  tray: Tray;
  reasons: readonly string[];
  // True when the model was not confident enough to place this on its own.
  uncertain: boolean;
}

function value<T>(answers: Answers, key: keyof Answers): T | null {
  const answer = answers[key];
  return answer.state === "value" ? (answer.value as T) : null;
}

function confidence(answers: Answers, key: keyof Answers): number | null {
  const answer = answers[key];
  return answer.state === "value" ? answer.confidence : null;
}

export const DEFAULT_MIN_CONFIDENCE = 0.6;

export function placeInTray(
  answers: Answers,
  quality: InputQuality,
  minConfidence: number = DEFAULT_MIN_CONFIDENCE,
): TrayPlacement {
  const reasons: string[] = [];

  if (quality === "missing_body") {
    return {
      tray: "review",
      reasons: ["Message body unavailable; classification input was incomplete."],
      uncertain: true,
    };
  }
  if (quality === "unsupported") {
    return {
      tray: "review",
      reasons: ["Message format unsupported by the classifier."],
      uncertain: true,
    };
  }

  const needsReply = value<boolean>(answers, "needsReply");
  const needsAction = value<boolean>(answers, "needsAction");
  const urgency = value<Rating>(answers, "urgency");
  const importance = value<Rating>(answers, "importance");
  const category = value<string>(answers, "category");
  const replyConfidence = confidence(answers, "needsReply");
  const actionConfidence = confidence(answers, "needsAction");
  const categoryConfidence = confidence(answers, "category");

  if (needsReply === null) {
    return {
      tray: "review",
      reasons: ["needs_reply was not answered."],
      uncertain: true,
    };
  }

  if (needsReply && (replyConfidence === null || replyConfidence >= minConfidence)) {
    reasons.push("Model indicates a reply is expected.");
    return { tray: "needs_reply", reasons, uncertain: false };
  }

  if (needsAction) {
    if (actionConfidence !== null && actionConfidence < minConfidence) {
      reasons.push("needs_action was low confidence; routed to review.");
      return { tray: "review", reasons, uncertain: true };
    }
    reasons.push("Model indicates action is required.");
    return { tray: "action", reasons, uncertain: false };
  }

  // A category probability never certifies a joint claim about needs_action.
  // Each question is gated on its own confidence.
  const categoryUncertain =
    categoryConfidence === null || categoryConfidence < minConfidence;

  if (category === "transactional" || category === "notification") {
    reasons.push("Transactional or notification mail.");
    if ((urgency ?? 1) >= 4 || (importance ?? 1) >= 4) {
      reasons.push("High urgency or importance; surfaced for review.");
      return { tray: "review", reasons, uncertain: true };
    }
    return { tray: "updates", reasons, uncertain: false };
  }

  if (categoryUncertain) {
    reasons.push("Category confidence below threshold; routed to review.");
    return { tray: "review", reasons, uncertain: true };
  }

  if (
    (category === "marketing" || category === "newsletter") &&
    (urgency ?? 3) <= 2 &&
    (importance ?? 3) <= 2
  ) {
    reasons.push("Low-urgency bulk or promotional mail.");
    return { tray: "low_priority", reasons, uncertain: false };
  }

  if (quality === "truncated") {
    reasons.push("Input was truncated; routed to review rather than judged complete.");
    return { tray: "review", reasons, uncertain: true };
  }

  reasons.push("No action or reply expected.");
  return { tray: "updates", reasons, uncertain: false };
}

export function isUncertainStatus(status: "complete" | "review" | "failed" | "stale"): boolean {
  return status === "review" || status === "failed" || status === "stale";
}
