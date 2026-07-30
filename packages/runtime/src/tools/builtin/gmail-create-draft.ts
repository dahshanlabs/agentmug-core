// gmail.create_draft — save a reply as a DRAFT in the user's Gmail (never sends).
//
// The trust primitive for draft-only inbox agents: triage with
// gmail.list_messages, then leave ready-to-edit drafts INSIDE the right threads
// for the human to review and send. A wrong draft costs nothing; a wrong send
// ends adoption.
//
// Like gmail.send, the DEFINITION is portable and lives here so BOTH the cloud
// executor (api-server, Postgres-backed credentials) and the desktop executor
// (local OAuth store, token never leaves the machine) register the same tool.

import type { InlineToolDefinition } from "../types";

export const gmailCreateDraftDefinition: InlineToolDefinition = {
  type: "inline",
  name: "gmail.create_draft",
  description:
    "Save a reply as a DRAFT in the user's connected Gmail — it is NOT sent, it lands in their Drafts folder for them to review and send. Prefer this over gmail.send whenever a human should approve before anything goes out (e.g. morning inbox triage that pre-writes the boring replies). Pass the threadId from gmail.list_messages to attach the draft INSIDE the original conversation, and set subject to 'Re: <original subject>' for a reply.",
  inputSchema: {
    type: "object",
    properties: {
      to: {
        type: "string",
        description: "Recipient email address (one address).",
      },
      subject: {
        type: "string",
        description: "Subject line. For a reply, use 'Re: <original subject>'.",
      },
      body: {
        type: "string",
        description: "Plain-text body of the draft reply.",
      },
      threadId: {
        type: "string",
        description:
          "Optional Gmail thread id (from gmail.list_messages) to attach the draft to, so it appears as a reply inside that conversation. Omit for a brand-new draft.",
      },
    },
    required: ["to", "subject", "body"],
  },
};

export type GmailCreateDraftInput = {
  to: string;
  subject: string;
  body: string;
  threadId?: string;
};

export type GmailCreateDraftResult = {
  /** The Gmail draft id (stable handle for the draft itself). */
  id: string;
  /** The underlying message id of the draft. */
  messageId: string;
  /** The thread the draft belongs to. */
  threadId: string;
  status: "draft_created";
};
