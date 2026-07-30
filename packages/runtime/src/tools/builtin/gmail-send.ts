// gmail.send — first MCP-style tool that uses the user's own OAuth.
//
// The DEFINITION is portable and lives here. The EXECUTOR lives in
// the cloud (api-server/src/tools/gmail-send-executor.ts) where it has
// access to the user_credentials table to fetch the user's access
// token. The desktop runtime can ship its own executor later that
// uses a credential the user pasted directly.
//
// Modeled to look as much like a standard MCP server's tool shape as
// possible so a future swap to a real `@modelcontextprotocol/server-gmail`
// is a no-op for blueprint authors.

import type { InlineToolDefinition } from "../types";

export const gmailSendDefinition: InlineToolDefinition = {
  type: "inline",
  name: "gmail.send",
  description:
    "Send an email from the user's connected Gmail account. The user has authorized AgentMug to send mail on their behalf; the token never leaves the user's account.",
  inputSchema: {
    type: "object",
    properties: {
      to: {
        type: "string",
        description: "Recipient email address (one address; CC/BCC not supported in this version).",
      },
      subject: {
        type: "string",
        description: "Email subject line.",
      },
      body: {
        type: "string",
        description: "Plain-text body of the email.",
      },
    },
    required: ["to", "subject", "body"],
  },
};

export type GmailSendInput = {
  to: string;
  subject: string;
  body: string;
};

export type GmailSendResult = {
  id: string;
  threadId: string;
  status: "sent";
};
