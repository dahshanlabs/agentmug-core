// gmail.list_messages — READ recent messages from the user's Gmail inbox.
//
// Like gmail.send / gmail.create_draft, the DEFINITION is portable and lives
// here so BOTH the cloud executor (api-server, Postgres-backed credentials) and
// the desktop executor (local OAuth store, token never leaving the machine)
// register the same tool. Read-only; pair with gmail.create_draft for
// draft-only inbox triage.

import type { InlineToolDefinition } from "../types";

export const gmailListMessagesDefinition: InlineToolDefinition = {
  type: "inline",
  name: "gmail.list_messages",
  description:
    "Read recent messages from the user's connected Gmail inbox. Returns id, threadId, from, subject, date, snippet, and an unread flag per message. Pass a Gmail search query (same syntax as the Gmail search box) to filter — e.g. 'is:unread', 'newer_than:7d', 'from:sarah@acme.com', 'has:attachment'. Read-only; pair with gmail.create_draft to triage then draft replies.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Gmail search query in Gmail search-box syntax, e.g. 'is:unread newer_than:7d', 'from:boss@example.com', 'has:attachment'. Omit to get the most recent messages.",
      },
      maxResults: {
        type: "number",
        description: "How many messages to return (1-25). Default 10.",
      },
    },
  },
};

export type GmailListMessagesInput = {
  query?: string;
  maxResults?: number;
};

export type GmailListMessage = {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  date: string;
  /**
   * Gmail's server-side receive time, epoch milliseconds as a string.
   * `date` above is the sender-controlled RFC2822 Date HEADER — the two can
   * disagree (backdated resends, skewed sender clocks). Consumers comparing
   * against Gmail's `after:` search clock must use this field.
   */
  internalDate?: string;
  snippet: string;
  unread: boolean;
};

export type GmailListMessagesResult = {
  messages: GmailListMessage[];
  resultSizeEstimate: number;
};
