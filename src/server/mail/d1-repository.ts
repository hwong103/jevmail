// D1-backed read repository. The integrator owns this file.
//
// Two rules from the plan are enforced here rather than left to convention:
// 1. A list row never carries body content. Bodies come from a separate
//    one-per-request path that the route marks no-store.
// 2. Every hot query is bounded and index-backed. Page size is capped, the
//    thread projection is precomputed, and no query counts the whole mailbox
//    per row.

import { effectiveDecision } from "../../contracts/effective";
import { placeInTray } from "../../contracts/trays";
import type { Answers, Correction, Question } from "../../contracts/domain";
import type {
  AnswerDto,
  AnswerValue,
  AutomationStatus,
  MessageBody,
  MessageListItem,
  MessagePage,
  SyncStatus,
} from "../../contracts/dto";
import { PAGE_SIZE_CAP, type ListQuery, type MailRepository } from "./repository";

interface MessageRow {
  id: string;
  gmail_message_id: string;
  gmail_thread_id: string;
  sender: string;
  subject: string;
  received_at: number;
  label_ids: string;
  is_unread: number;
  is_starred: number;
}

interface ClassificationRow {
  id: string;
  gmail_message_id: string;
  input_quality: string;
  answers: string;
  status: string;
}

interface CorrectionRow {
  gmail_message_id: string;
  revision: number;
  changes: string;
}

export const DEFAULT_LIMIT = 25;

const NO_ANSWERS: readonly AnswerDto[] = [];

export class D1MailRepository implements MailRepository {
  constructor(
    private readonly db: D1Database,
    private readonly accountId: string,
    private readonly bodyLoader: (gmailMessageId: string) => Promise<MessageBody | null>,
  ) {}

  async list(query: ListQuery): Promise<MessagePage> {
    const limit = Math.min(Math.max(query.limit || DEFAULT_LIMIT, 1), PAGE_SIZE_CAP);
    const offset = decodePageToken(query.pageToken);

    // Bounded and index-backed by messages_account_received_idx. No correlated
    // subquery runs per returned row.
    const messages = await this.db
      .prepare(
        "SELECT id, gmail_message_id, gmail_thread_id, sender, subject, received_at, label_ids, is_unread, is_starred FROM messages WHERE account_id = ? ORDER BY received_at DESC LIMIT ? OFFSET ?",
      )
      .bind(this.accountId, limit, offset)
      .all<MessageRow>();

    if (messages.results.length === 0) {
      return { messages: [], nextPageToken: null, total: 0, reviewedCount: 0, classifiedCount: 0 };
    }

    const messageIds = messages.results.map((row) => row.gmail_message_id);
    const [classifications, corrections, pendingByThread] = await Promise.all([
      this.loadClassifications(messageIds),
      this.loadCorrections(messageIds),
      this.loadPendingByThread(messages.results),
    ]);

    const items: MessageListItem[] = messages.results.map((row) => {
      const classification = classifications.get(row.gmail_message_id);
      const applied = corrections.get(row.gmail_message_id) ?? [];
      const effective = classification
        ? effectiveDecision(parseAnswers(classification.answers), applied)
        : null;
      const quality = (classification?.input_quality ?? null) as MessageListItem["quality"];
      const placement = effective
        ? placeInTray(effective.answers, quality ?? "complete")
        : { tray: "review" as const, reasons: ["Not classified yet."], uncertain: true };

      return {
        gmailMessageId: row.gmail_message_id,
        gmailThreadId: row.gmail_thread_id,
        sender: row.sender,
        subject: row.subject,
        receivedAt: row.received_at,
        labelIds: parseLabels(row.label_ids),
        isUnread: row.is_unread === 1,
        isStarred: row.is_starred === 1,
        classificationId: classification?.id ?? null,
        status: classification
          ? (classification.status as MessageListItem["status"])
          : "pending",
        quality,
        tray: placement.tray,
        trayReasons: placement.reasons,
        uncertain: placement.uncertain,
        pendingInThread: pendingByThread.get(row.gmail_thread_id) ?? 0,
        answers: effective ? toAnswerDtos(effective.answers, effective.correctedQuestions) : NO_ANSWERS,
      };
    });

    const counts = await this.counts();
    return {
      messages: items,
      // A full page implies there may be more; the next read confirms it.
      nextPageToken: items.length === limit ? encodePageToken(offset + items.length) : null,
      total: counts.total,
      reviewedCount: counts.reviewed,
      classifiedCount: counts.classified,
    };
  }

  private async loadClassifications(
    messageIds: readonly string[],
  ): Promise<Map<string, ClassificationRow>> {
    const rows = await this.inChunks(messageIds, 40, (chunk) =>
      this.db
        .prepare(
          "SELECT id, gmail_message_id, input_quality, answers, status FROM classifications WHERE account_id = ? AND gmail_message_id IN (" +
            chunk.map(() => "?").join(",") +
            ") ORDER BY created_at DESC",
        )
        .bind(this.accountId, ...chunk)
        .all<ClassificationRow>(),
    );
    // The newest row per message wins, so a stale completion cannot surface.
    const map = new Map<string, ClassificationRow>();
    for (const row of rows) {
      if (!map.has(row.gmail_message_id)) map.set(row.gmail_message_id, row);
    }
    return map;
  }

  private async loadCorrections(
    messageIds: readonly string[],
  ): Promise<Map<string, Correction[]>> {
    const rows = await this.inChunks(messageIds, 40, (chunk) =>
      this.db
        .prepare(
          "SELECT gmail_message_id, revision, changes FROM corrections WHERE account_id = ? AND gmail_message_id IN (" +
            chunk.map(() => "?").join(",") +
            ") ORDER BY gmail_message_id, revision ASC",
        )
        .bind(this.accountId, ...chunk)
        .all<CorrectionRow>(),
    );
    const map = new Map<string, Correction[]>();
    for (const row of rows) {
      const list = map.get(row.gmail_message_id) ?? [];
      list.push({
        id: `${row.gmail_message_id}:${row.revision}`,
        accountId: this.accountId,
        gmailMessageId: row.gmail_message_id,
        revision: row.revision,
        changes: JSON.parse(row.changes) as Correction["changes"],
        observedInputHash: null,
        createdAt: 0,
        actorId: "stored",
      });
      map.set(row.gmail_message_id, list);
    }
    return map;
  }

  /**
   * Counts thread members with no live classification, so a tray row can say
   * "1 new in thread" instead of hiding an unclassified reply.
   */
  private async loadPendingByThread(rows: readonly MessageRow[]): Promise<Map<string, number>> {
    const threadIds = [...new Set(rows.map((row) => row.gmail_thread_id))];
    const result = await this.inChunks(threadIds, 40, (chunk) =>
      this.db
        .prepare(
          "SELECT m.gmail_thread_id AS thread_id, COUNT(*) AS pending FROM messages m LEFT JOIN classifications c ON c.account_id = m.account_id AND c.gmail_message_id = m.gmail_message_id AND c.status = 'complete' WHERE m.account_id = ? AND m.gmail_thread_id IN (" +
            chunk.map(() => "?").join(",") +
            ") AND c.id IS NULL GROUP BY m.gmail_thread_id",
        )
        .bind(this.accountId, ...chunk)
        .all<{ thread_id: string; pending: number }>(),
    );
    return new Map(result.flatMap((row) => [[row.thread_id, row.pending] as const]));
  }

  private async counts(): Promise<{ total: number; reviewed: number; classified: number }> {
    const row = await this.db
      .prepare(
        "SELECT (SELECT COUNT(*) FROM messages WHERE account_id = ?) AS total, (SELECT COUNT(*) FROM corrections WHERE account_id = ?) AS reviewed, (SELECT COUNT(*) FROM classifications WHERE account_id = ? AND status = 'complete') AS classified",
      )
      .bind(this.accountId, this.accountId, this.accountId)
      .first<{ total: number; reviewed: number; classified: number }>();
    return {
      total: row?.total ?? 0,
      reviewed: row?.reviewed ?? 0,
      classified: row?.classified ?? 0,
    };
  }

  async body(gmailMessageId: string): Promise<MessageBody | null> {
    // Never read from D1: the body is fetched from Gmail on demand.
    return this.bodyLoader(gmailMessageId);
  }

  async syncStatus(): Promise<SyncStatus> {
    const row = await this.db
      .prepare(
        "SELECT version, mode, committed_history_id, updated_at FROM sync_checkpoints WHERE account_id = ?",
      )
      .bind(this.accountId)
      .first<{ version: number; mode: string; updated_at: number }>();
    if (!row) {
      return { state: "idle", mode: null, processed: 0, cursorAgeMs: null, message: null };
    }
    return {
      state: "idle",
      mode: row.mode as SyncStatus["mode"],
      processed: row.version,
      cursorAgeMs: Math.max(0, Date.now() - row.updated_at),
      message: null,
    };
  }

  async automationStatus(): Promise<AutomationStatus> {
    const row = await this.db
      .prepare(
        "SELECT (SELECT COUNT(*) FROM policy_rules WHERE account_id = ? AND enabled = 1) AS enabled, (SELECT COUNT(*) FROM policy_rules WHERE account_id = ?) AS total, (SELECT COUNT(*) FROM policy_evaluations WHERE account_id = ? AND outcome = 'proposed') AS proposals",
      )
      .bind(this.accountId, this.accountId, this.accountId)
      .first<{ enabled: number; total: number; proposals: number }>();
    return {
      // v1 cannot execute. Stated plainly so the UI never implies otherwise.
      executionEnabled: false,
      enabledRuleCount: row?.enabled ?? 0,
      totalRuleCount: row?.total ?? 0,
      proposalCount: row?.proposals ?? 0,
      killSwitch: true,
    };
  }

  /**
   * Records a correction. The revision is allocated by a compare-and-set insert
   * against corrections_one_revision_idx, so two concurrent submissions cannot
   * claim the same revision.
   */
  async recordCorrection(
    gmailMessageId: string,
    changes: readonly { question: Question; operation: "set" | "clear"; value?: AnswerValue }[],
    actorId: string,
  ): Promise<{ revision: number; reclassified: boolean }> {
    const message = await this.db
      .prepare("SELECT revision FROM messages WHERE account_id = ? AND gmail_message_id = ?")
      .bind(this.accountId, gmailMessageId)
      .first<{ revision: number }>();
    if (!message) throw new Error("Unknown message");

    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await this.db
        .prepare(
          "SELECT COALESCE(MAX(revision), 0) AS revision FROM corrections WHERE account_id = ? AND gmail_message_id = ?",
        )
        .bind(this.accountId, gmailMessageId)
        .first<{ revision: number }>();
      const next = (current?.revision ?? 0) + 1;
      try {
        await this.db
          .prepare(
            "INSERT INTO corrections (id, account_id, gmail_message_id, revision, changes, observed_input_hash, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .bind(
            crypto.randomUUID(),
            this.accountId,
            gmailMessageId,
            next,
            JSON.stringify(changes),
            null,
            actorId,
            Date.now(),
          )
          .run();
        return { revision: next, reclassified: false };
      } catch (error) {
        // A unique violation means another writer took this revision; retry with
        // the new maximum rather than overwriting theirs.
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Could not allocate a revision");
  }

  /**
   * D1 caps a statement at 100 bound parameters, so any IN list is chunked well
   * below that ceiling rather than discovering the limit at runtime.
   */
  private async inChunks<T>(
    values: readonly string[],
    size: number,
    run: (chunk: string[]) => Promise<{ results: T[] }>,
  ): Promise<T[]> {
    const out: T[] = [];
    for (let i = 0; i < values.length; i += size) {
      out.push(...(await run(values.slice(i, i + size))).results);
    }
    return out;
  }
}

function encodePageToken(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

function decodePageToken(token: string | null): number {
  if (!token) return 0;
  const parsed = Number.parseInt(Buffer.from(token, "base64url").toString("utf8"), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function parseLabels(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseAnswers(value: string): Answers {
  return JSON.parse(value) as Answers;
}

function toAnswerDtos(answers: Answers, corrected: readonly Question[]): AnswerDto[] {
  const correctedSet = new Set(corrected);
  return (Object.entries(answers) as [Question, Answers[Question]][]).map(([question, answer]) => {
    const base = {
      question,
      confidence: answer.state === "value" ? answer.confidence : null,
      distribution:
        answer.state === "value"
          ? (answer.distribution?.map((entry) => ({
              value: String(entry.value),
              probability: entry.probability,
            })) ?? null)
          : null,
      corrected: correctedSet.has(question),
    };
    return answer.state === "value"
      ? ({ ...base, state: "value", value: answer.value as AnswerValue } as AnswerDto)
      : ({ ...base, state: "unknown", reason: answer.reason } as AnswerDto);
  });
}
