// Client-safe mirrors of the domain types. Kept separate so the browser bundle
// cannot import server modules.

export type Category =
  | "personal"
  | "work"
  | "transactional"
  | "newsletter"
  | "marketing"
  | "cold_outreach"
  | "notification"
  | "other";

export type Rating = 1 | 2 | 3 | 4 | 5;

export interface AnswerValues {
  category: Category;
  needsReply: boolean;
  needsAction: boolean;
  urgency: Rating;
  importance: Rating;
  senderType: "person" | "organization" | "automated" | "unknown";
}

export type Question = keyof AnswerValues;

export type Tray =
  | "needs_reply"
  | "action"
  | "review"
  | "updates"
  | "low_priority";

export const TRAY_LABELS: Record<Tray, string> = {
  needs_reply: "Needs reply",
  action: "Action",
  review: "Review",
  updates: "Updates",
  low_priority: "Low priority",
};

export const QUESTION_LABELS: Record<Question, string> = {
  category: "Category",
  needsReply: "Needs reply",
  needsAction: "Needs action",
  urgency: "Urgency",
  importance: "Importance",
  senderType: "Sender",
};
