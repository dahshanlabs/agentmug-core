// twilio.send_whatsapp — send a WhatsApp message via the user's
// connected Twilio account.
//
// Twilio sends SMS and WhatsApp through the SAME Messages REST API +
// the SAME Account SID / Auth Token — the only difference is a
// "whatsapp:" prefix on the To/From addresses. So this tool reuses the
// exact Twilio connection the user already pasted for twilio.send_sms;
// there is no separate credential. The recipient must have messaged the
// Twilio WhatsApp number within the last 24h (session window), or the
// body must match a pre-approved WhatsApp template.

import type { InlineToolDefinition } from "../types";

export const twilioSendWhatsappDefinition: InlineToolDefinition = {
  type: "inline",
  name: "twilio.send_whatsapp",
  description:
    "Send a WhatsApp message via the user's connected Twilio account (the SAME connection as twilio.send_sms — Twilio sends both). Use for 'message me on WhatsApp' or WhatsApp replies. The recipient must have messaged the Twilio WhatsApp number in the last 24h, or the body must be an approved template.",
  effect: {
    provider: "twilio",
    operation: "whatsapp.message.deliver",
    requiredProof: "delivered",
    verification: "callback",
    required: true,
  },
  inputSchema: {
    type: "object",
    properties: {
      to: {
        type: "string",
        description:
          "Recipient WhatsApp number in E.164 format, e.g. '+14155551234'. Optional — if omitted, defaults to the user's own saved phone number (use this to 'message me on WhatsApp ...'). The 'whatsapp:' channel prefix is added automatically.",
      },
      body: {
        type: "string",
        description: "The WhatsApp message text.",
      },
      from: {
        type: "string",
        description:
          "Optional Twilio WhatsApp-enabled sender number in E.164. Defaults to the number saved when Twilio was connected.",
      },
    },
    required: ["body"],
  },
};

export type TwilioSendWhatsappInput = {
  // Optional — the executor defaults to the run owner's saved phone number.
  to?: string;
  body: string;
  from?: string;
};

export type TwilioSendWhatsappResult = {
  sid: string;
  status: string;
  to: string;
  /**
   * Human-readable delivery caveat for the model to relay honestly. Twilio
   * returns "queued"/"accepted" the instant it ACCEPTS the message — that is
   * NOT a delivery confirmation, and for the WhatsApp sandbox the message is
   * silently dropped unless the recipient has joined it. So the agent must not
   * claim "delivered/sent ✓"; it should say "queued — you'll receive it if your
   * number has joined the sandbox."
   */
  note?: string;
};
