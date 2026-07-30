// twilio.send_sms — send an SMS text message via the user's connected
// Twilio account.
//
// Definition is portable. The cloud executor uses the user's Twilio
// Account SID + Auth Token (stored encrypted in user_credentials,
// provider='twilio') to POST to Twilio's Messages REST API. The Auth
// Token never leaves the user's account; AgentMug forwards the request
// to twilio.com on the user's behalf.

import type { InlineToolDefinition } from "../types";

export const twilioSendSmsDefinition: InlineToolDefinition = {
  type: "inline",
  name: "twilio.send_sms",
  description:
    "Send an SMS text message via the user's connected Twilio account. The Auth Token never leaves the user's account; AgentMug forwards the request to Twilio on their behalf.",
  inputSchema: {
    type: "object",
    properties: {
      to: {
        type: "string",
        description:
          "Recipient phone number in E.164 format, e.g. '+14155551234'. Optional — if omitted, defaults to the user's own saved phone number (use this to 'text me ...').",
      },
      body: {
        type: "string",
        description:
          "The text message body. Twilio splits long messages into segments automatically.",
      },
      from: {
        type: "string",
        description:
          "Optional sender number in E.164 format. Defaults to the number saved when Twilio was connected.",
      },
    },
    required: ["body"],
  },
};

export type TwilioSendSmsInput = {
  // Optional — the executor defaults to the run owner's saved phone number.
  to?: string;
  body: string;
  from?: string;
};

export type TwilioSendSmsResult = {
  sid: string;
  status: string;
  to: string;
  /** Delivery caveat for the model: a "queued"/"accepted" status means Twilio
   *  ACCEPTED the message, not that the carrier delivered it. */
  note?: string;
};
