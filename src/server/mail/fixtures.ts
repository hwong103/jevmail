// Fixture-backed repository. Synthetic mail only. This is what the PWA runs
// against until a real mailbox is connected, so the vertical slice is provable
// without credentials.

import { placeInTray } from "../../contracts/trays";
import type {
  AnswerDto,
  AnswerValue,
  MessageBody,
  MessageListItem,
  MessagePage,
  Question,
} from "../../contracts/dto";
import type { Answers, InputQuality } from "../../contracts/domain";
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_CAP, type MailRepository } from "./repository";

interface Seed {
  id: string;
  sender: string;
  subject: string;
  text: string;
  quality: InputQuality;
  answers: Answers;
  receivedAt: number;
  isUnread?: boolean;
  pendingInThread?: number;
}

const SEEDS: Seed[] = [
  {
    id: "g-receipt-1",
    sender: "billing@shop.example",
    subject: "Your order receipt",
    text: "Thanks for your purchase. Invoice 40211 is available in your account.",
    quality: "complete",
    receivedAt: 1_757_000_000_000,
    answers: {
      category: { state: "value", value: "transactional", confidence: 0.9, distribution: null },
      needsReply: { state: "value", value: false, confidence: 0.85, distribution: null },
      needsAction: { state: "value", value: false, confidence: 0.8, distribution: null },
      urgency: { state: "value", value: 2, confidence: 0.7, distribution: null },
      importance: { state: "value", value: 3, confidence: 0.7, distribution: null },
      senderType: { state: "value", value: "automated", confidence: 0.9, distribution: null },
    } as Answers,
  },
  {
    id: "g-newsletter-1",
    sender: "digest@news.example",
    subject: "This week in software",
    text: "Our weekly roundup. Unsubscribe any time.",
    quality: "complete",
    receivedAt: 1_757_003_000_000,
    answers: {
      category: { state: "value", value: "newsletter", confidence: 0.88, distribution: null },
      needsReply: { state: "value", value: false, confidence: 0.9, distribution: null },
      needsAction: { state: "value", value: false, confidence: 0.86, distribution: null },
      urgency: { state: "value", value: 1, confidence: 0.8, distribution: null },
      importance: { state: "value", value: 2, confidence: 0.75, distribution: null },
      senderType: { state: "value", value: "organization", confidence: 0.85, distribution: null },
    } as Answers,
  },
  {
    id: "g-work-1",
    sender: "dana@partner.example",
    subject: "Could you review the contract draft?",
    text: "Following up on the agreement. Could you review section 4 before Friday?",
    quality: "complete",
    receivedAt: 1_757_006_000_000,
    isUnread: true,
    pendingInThread: 1,
    answers: {
      category: { state: "value", value: "work", confidence: 0.75, distribution: null },
      needsReply: { state: "value", value: true, confidence: 0.82, distribution: null },
      needsAction: { state: "value", value: true, confidence: 0.78, distribution: null },
      urgency: { state: "value", value: 3, confidence: 0.65, distribution: null },
      importance: { state: "value", value: 4, confidence: 0.7, distribution: null },
      senderType: { state: "value", value: "person", confidence: 0.8, distribution: null },
    } as Answers,
  },
  {
    id: "g-attachment-1",
    sender: "finance@vendor.example",
    subject: "Invoice attached",
    text: "",
    quality: "missing_body",
    receivedAt: 1_757_009_000_000,
    answers: {
      category: { state: "unknown", reason: "missing" },
      needsReply: { state: "unknown", reason: "missing" },
      needsAction: { state: "unknown", reason: "missing" },
      urgency: { state: "unknown", reason: "missing" },
      importance: { state: "unknown", reason: "missing" },
      senderType: { state: "unknown", reason: "missing" },
    } as Answers,
  },
  {
    id: "g-ambiguous-1",
    sender: "no-reply@service.example",
    subject: "Account notice",
    text: "Your account requires attention.",
    quality: "complete",
    receivedAt: 1_757_012_000_000,
    answers: {
      category: { state: "value", value: "notification", confidence: 0.31, distribution: null },
      needsReply: { state: "value", value: false, confidence: 0.44, distribution: null },
      needsAction: { state: "value", value: true, confidence: 0.22, distribution: null },
      urgency: { state: "unknown", reason: "missing" },
      importance: { state: "unknown", reason: "missing" },
      senderType: { state: "value", value: "automated", confidence: 0.6, distribution: null },
    } as Answers,
  },
];

function toDto(seed: Seed): MessageListItem {
  const placement = placeInTray(seed.answers, seed.quality);
  const answers: AnswerDto[] = (Object.entries(seed.answers) as [Question, Answers[Question]][]).map(
    ([question, answer]) => {
      const base = {
        question,
        confidence: answer.state === "value" ? answer.confidence : null,
        distribution:
          answer.state === "value"
            ? answer.distribution?.map((entry) => ({
                value: String(entry.value),
                probability: entry.probability,
              })) ?? null
            : null,
        corrected: false,
      };
      return answer.state === "value"
        ? ({ ...base, state: "value" as const, value: answer.value as AnswerValue } as AnswerDto)
        : ({ ...base, state: "unknown" as const, reason: answer.reason } as AnswerDto);
    },
  );

  return {
    gmailMessageId: seed.id,
    gmailThreadId: `t-${seed.id}`,
    sender: seed.sender,
    subject: seed.subject,
    receivedAt: seed.receivedAt,
    labelIds: seed.isUnread ? ["INBOX", "UNREAD"] : ["INBOX"],
    isUnread: Boolean(seed.isUnread),
    isStarred: false,
    classificationId: `c-${seed.id}`,
    status: placement.uncertain ? "review" : "complete",
    quality: seed.quality,
    tray: placement.tray,
    trayReasons: placement.reasons,
    uncertain: placement.uncertain,
    pendingInThread: seed.pendingInThread ?? 0,
    answers,
  };
}

export class FixtureMailRepository implements MailRepository {
  private readonly items: MessageListItem[] = SEEDS.map(toDto);
  private readonly bodies = new Map(SEEDS.map((seed) => [seed.id, seed]));

  async list(query: {
    tray: string;
    pageToken: string | null;
    limit: number;
  }): Promise<MessagePage> {
    const limit = Math.min(query.limit || DEFAULT_PAGE_SIZE, PAGE_SIZE_CAP);
    const filtered =
      query.tray === "all" ? this.items : this.items.filter((item) => item.tray === query.tray);
    const offset = query.pageToken ? Number.parseInt(query.pageToken, 10) || 0 : 0;
    const page = filtered.slice(offset, offset + limit);
    const nextOffset = offset + limit;
    return {
      messages: page,
      nextPageToken: nextOffset < filtered.length ? String(nextOffset) : null,
      total: filtered.length,
      reviewedCount: 0,
      classifiedCount: filtered.length,
    };
  }

  async body(gmailMessageId: string): Promise<MessageBody | null> {
    const seed = this.bodies.get(gmailMessageId);
    if (!seed) return null;
    const unavailable =
      seed.quality === "missing_body"
        ? "This message has no readable body. Open it in Gmail."
        : seed.quality === "truncated"
          ? "This message was truncated. Open it in Gmail to read the rest."
          : null;
    return {
      gmailMessageId,
      text: seed.quality === "complete" ? seed.text : null,
      quality: seed.quality,
      unavailableReason: unavailable,
      gmailUrl: `https://mail.google.com/mail/u/0/#all/${seed.id}`,
    };
  }

  async syncStatus() {
    return {
      state: "idle" as const,
      mode: "incremental" as const,
      processed: this.items.length,
      cursorAgeMs: 42_000,
      message: null,
    };
  }

  async automationStatus() {
    return {
      executionEnabled: false as const,
      enabledRuleCount: 0,
      totalRuleCount: 5,
      proposalCount: 0,
      killSwitch: true,
    };
  }

  async recordCorrection(
    gmailMessageId: string,
    changes: readonly { question: Question; operation: "set" | "clear"; value?: AnswerValue }[],
    // The actor id is accepted for interface parity with the D1 repository.
    // Fixture corrections are not audited, and nothing here is persisted.
    _actorId: string,
  ): Promise<{ revision: number; reclassified: boolean }> {
    const index = this.items.findIndex((item) => item.gmailMessageId === gmailMessageId);
    if (index === -1) throw new Error("Unknown message");
    const current = this.items[index]!;
    for (const change of changes) {
      if (change.operation !== "set") continue;
      const target = current.answers.find((a) => a.question === change.question);
      if (target) {
        // Owner assertion: value set, confidence explicitly absent.
        (target as { value?: unknown; confidence: number | null; corrected: boolean }).value =
          change.value;
        target.confidence = null;
        target.corrected = true;
        target.state = "value";
        delete target.reason;
      }
    }
    return { revision: 1, reclassified: false };
  }
}
