// email.send — the zero-setup "email me the result" tool.
//
// The DEFINITION is portable and lives here. The EXECUTOR lives in the cloud
// (api-server/src/tools/email-send-executor.ts) where it sends via the
// platform mailer (Resend) with NO per-user OAuth, falling back to the user's
// connected Gmail if the platform mailer isn't configured. If 'to' is
// omitted, it defaults to the user's own account email — so an agent can
// "email me ..." without the model knowing the address (mirrors how
// twilio.send_sms defaults to the user's saved phone).

import type { InlineToolDefinition } from "../types";

export const emailSendDefinition: InlineToolDefinition = {
  type: "inline",
  name: "email.send",
  description:
    "Send an email — the zero-setup way to 'email me the result'. Emailing the USER (the default when 'to' is omitted, or 'to' = their own address) goes out via AgentMug's platform mailer with no connection needed. Emailing ANYONE ELSE is sent from the user's connected Gmail (so it requires Google connected). Use this for 'email me ...'.",
  inputSchema: {
    type: "object",
    properties: {
      to: {
        type: "string",
        description:
          "Recipient email address. Optional — if omitted, defaults to the user's own account email (use this to 'email me ...').",
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
    required: ["subject", "body"],
  },
};

export type EmailSendInput = {
  to?: string;
  subject: string;
  body: string;
};

export type EmailSendResult = {
  status: "sent";
  to: string;
  via: "resend" | "gmail";
};
