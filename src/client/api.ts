// Thin fetch wrapper. Bodies are requested one at a time and never retained
// across navigation, which is what keeps mail content out of any store.

import type {
  AutomationStatus,
  CorrectionRequest,
  CorrectionResponse,
  MessageBody,
  MessagePage,
  SyncStatus,
} from "../contracts/dto";

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal, headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`${path} failed: ${response.status}`);
  return (await response.json()) as T;
}

export function listMessages(
  tray: string,
  pageToken: string | null,
  signal?: AbortSignal,
): Promise<MessagePage> {
  const params = new URLSearchParams({ tray });
  if (pageToken) params.set("pageToken", pageToken);
  return get<MessagePage>(`/api/messages?${params.toString()}`, signal);
}

export function fetchBody(gmailMessageId: string, signal?: AbortSignal): Promise<MessageBody> {
  return get<MessageBody>(`/api/messages/${encodeURIComponent(gmailMessageId)}/body`, signal);
}

export function fetchSyncStatus(signal?: AbortSignal): Promise<SyncStatus> {
  return get<SyncStatus>("/api/sync-status", signal);
}

export function fetchAutomation(signal?: AbortSignal): Promise<AutomationStatus> {
  return get<AutomationStatus>("/api/automation", signal);
}

export async function submitCorrection(
  gmailMessageId: string,
  request: CorrectionRequest,
): Promise<CorrectionResponse> {
  const response = await fetch(`/api/messages/${encodeURIComponent(gmailMessageId)}/corrections`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw new Error(`Correction failed: ${response.status}`);
  return (await response.json()) as CorrectionResponse;
}
