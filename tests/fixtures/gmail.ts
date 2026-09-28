// Synthetic Gmail fixtures. No real mail, no real addresses, no tokens.

import type { GmailHeader, GmailMessage, GmailPart } from "../../src/server/gmail/normalize";

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

export function textMessage(input: {
  id: string;
  threadId?: string;
  from: string;
  subject: string;
  body: string;
  internalDate?: number;
  labelIds?: string[];
}): { message: GmailMessage; headers: GmailHeader[] } {
  const headers: GmailHeader[] = [
    { name: "From", value: input.from },
    { name: "Subject", value: input.subject },
  ];
  const payload: GmailPart = {
    mimeType: "multipart/alternative",
    parts: [
      { mimeType: "text/plain", body: { data: base64Url(input.body), size: input.body.length } },
    ],
  };
  return {
    message: {
      id: input.id,
      threadId: input.threadId ?? `t-${input.id}`,
      internalDate: String(input.internalDate ?? 1_757_000_000_000),
      payload,
      labelIds: input.labelIds ?? ["INBOX"],
    },
    headers,
  };
}

export function htmlOnlyMessage(input: {
  id: string;
  from: string;
  subject: string;
  html: string;
}): { message: GmailMessage; headers: GmailHeader[] } {
  return {
    message: {
      id: input.id,
      threadId: `t-${input.id}`,
      internalDate: "1757000000000",
      payload: {
        mimeType: "text/html",
        body: { data: base64Url(input.html), size: input.html.length },
      },
      labelIds: ["INBOX"],
    },
    headers: [
      { name: "From", value: input.from },
      { name: "Subject", value: input.subject },
    ],
  };
}

export function attachmentOnlyMessage(input: {
  id: string;
  from: string;
  subject: string;
  filename: string;
}): { message: GmailMessage; headers: GmailHeader[] } {
  return {
    message: {
      id: input.id,
      threadId: `t-${input.id}`,
      internalDate: "1757000000000",
      payload: {
        mimeType: "multipart/mixed",
        parts: [
          {
            mimeType: "application/pdf",
            filename: input.filename,
            body: { attachmentId: "att-1", size: 2048 },
          },
        ],
      },
      labelIds: ["INBOX"],
    },
    headers: [
      { name: "From", value: input.from },
      { name: "Subject", value: input.subject },
    ],
  };
}
