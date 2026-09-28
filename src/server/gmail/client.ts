// Gmail API adapter. Worker A owns this directory.
//
// Read-only by construction: this client has no method that modifies anything,
// and it never accepts a thread-level modify call. `gmail.modify` will be
// needed later for manual actions, but the read path only asks for readonly.

export interface GmailProfile {
  emailAddress: string;
  historyId: string;
}

export interface GmailHistoryRecord {
  id: string;
  messages?: string[];
}

export interface GmailHistoryPage {
  history: GmailHistoryRecord[];
  historyId: string | null;
  nextPageToken: string | null;
}

export interface RawMessage {
  id: string;
  threadId: string;
  internalDate?: string;
  labelIds?: string[];
  snippet?: string;
  payload?: unknown;
}

export interface GmailFetchOptions {
  maxResults: number;
  pageToken?: string | null;
}

export interface GmailAdapter {
  profile(): Promise<GmailProfile>;
  listHistory(startHistoryId: string | null, options: GmailFetchOptions): Promise<GmailHistoryPage>;
  getMessage(
    id: string,
    format: "metadata" | "full",
  ): Promise<{ message: RawMessage; headers: { name: string; value: string }[] }>;
}

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

export class GmailApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(`Gmail ${status}: ${reason}`);
    this.name = "GmailApiError";
  }
}

export class GmailHttpAdapter implements GmailAdapter {
  constructor(private readonly accessToken: string) {}

  private async request<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${BASE}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: { status?: string } };
      throw new GmailApiError(response.status, body.error?.status ?? "unknown");
    }
    return (await response.json()) as T;
  }

  async profile(): Promise<GmailProfile> {
    const body = await this.request<{ emailAddress: string; historyId: string }>("/profile");
    return { emailAddress: body.emailAddress, historyId: body.historyId };
  }

  async listHistory(
    startHistoryId: string | null,
    options: GmailFetchOptions,
  ): Promise<GmailHistoryPage> {
    const params: Record<string, string> = {
      maxResults: String(options.maxResults),
      // Every change type matters: read state, archive, trash, and label edits
      // all invalidate a stored classification or precondition.
      labelId: "INBOX",
    };
    if (startHistoryId) params.startHistoryId = startHistoryId;
    if (options.pageToken) params.pageToken = options.pageToken;
    const body = await this.request<{
      history?: { id: string; messages?: { id: string }[] }[];
      historyId?: string;
      nextPageToken?: string;
    }>("/history", params);
    return {
      history: (body.history ?? []).map((entry) => ({
        id: entry.id,
        messages: entry.messages?.map((m) => m.id),
      })),
      historyId: body.historyId ?? null,
      nextPageToken: body.nextPageToken ?? null,
    };
  }

  async getMessage(
    id: string,
    format: "metadata" | "full",
  ): Promise<{ message: RawMessage; headers: { name: string; value: string }[] }> {
    const body = await this.request<{
      id: string;
      threadId: string;
      internalDate?: string;
      labelIds?: string[];
      snippet?: string;
      payload?: { headers?: { name: string; value: string }[] } & Record<string, unknown>;
    }>(`/messages/${encodeURIComponent(id)}`, { format });
    return {
      message: {
        id: body.id,
        threadId: body.threadId,
        internalDate: body.internalDate,
        labelIds: body.labelIds,
        snippet: body.snippet,
        payload: body.payload as unknown,
      },
      headers: body.payload?.headers ?? [],
    };
  }
}

/**
 * Detects a history id that has aged out. Gmail answers with 404 and a
 * historyIdNotFound reason rather than a distinct status, so the reason is what
 * tells a cursor-expiry apart from a revoked grant.
 */
export function isHistoryExpired(error: unknown): boolean {
  return error instanceof GmailApiError && /historyIdNotFound/i.test(error.reason);
}

export function isAuthFailure(error: unknown): boolean {
  if (!(error instanceof GmailApiError)) return false;
  return error.status === 401 || /authError|unauthorized/i.test(error.reason);
}
