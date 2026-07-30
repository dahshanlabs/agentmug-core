// discord.send_message — post a message to a Discord channel via the
// user's connected incoming webhook URL.
//
// Discord incoming webhooks are the zero-friction send path: a secret
// URL (created in a channel's settings) that accepts a JSON POST with
// no bot, OAuth, or gateway. This tool posts to the webhook URL stored
// encrypted in user_credentials (provider='discord'). It is SEND-ONLY
// (webhooks cannot read a channel) — monitoring a Discord channel would
// need a persistent gateway bot, which the stateless cloud runtime does
// not host.

import type { InlineToolDefinition } from "../types";

export const discordSendMessageDefinition: InlineToolDefinition = {
  type: "inline",
  name: "discord.send_message",
  description:
    "Post a message to a Discord channel via the user's connected incoming webhook URL. Use for 'post to Discord' or Discord notifications. SEND-ONLY (a webhook cannot read messages); posts to the channel the webhook belongs to.",
  inputSchema: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "The message text to post (Discord limit: 2000 characters).",
      },
      username: {
        type: "string",
        description: "Optional display name override for this message.",
      },
    },
    required: ["content"],
  },
};

export type DiscordSendMessageInput = {
  content: string;
  username?: string;
};

export type DiscordSendMessageResult = {
  ok: true;
};
