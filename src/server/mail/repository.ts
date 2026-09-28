// Read-side repository port. Worker A implements it against D1; the fixture
// implementation backs local development and tests. Worker D depends on this
// interface, never on D1 directly.

import type {
  AutomationStatus,
  AnswerValue,
  MessageBody,
  MessageListItem,
  MessagePage,
  Question,
  SyncStatus,
} from "../../contracts/dto";

export interface ListQuery {
  tray: string;
  pageToken: string | null;
  limit: number;
}

export interface MailRepository {
  list(query: ListQuery): Promise<MessagePage>;
  /**
   * Fetches one body for immediate display. Callers must not batch this: the
   * contract is one body per request so nothing accumulates client-side.
   */
  body(gmailMessageId: string): Promise<MessageBody | null>;
  syncStatus(): Promise<SyncStatus>;
  automationStatus(): Promise<AutomationStatus>;
  recordCorrection(
    gmailMessageId: string,
    changes: readonly {
      question: Question;
      operation: "set" | "clear";
      value?: AnswerValue;
    }[],
    actorId: string,
  ): Promise<{ revision: number; reclassified: boolean }>;
}

export const PAGE_SIZE_CAP = 50;
export const DEFAULT_PAGE_SIZE = 25;
