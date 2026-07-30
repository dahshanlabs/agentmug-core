// telegram.send_message — send a Telegram message via the user's
// connected bot.
//
// Telegram's Bot API is free and the simplest messaging channel: a
// single bot token from @BotFather authorizes both sending and (via
// getUpdates / webhooks) receiving. The cloud executor POSTs to
// api.telegram.org/bot<token>/sendMessage using the token stored
// encrypted in user_credentials (provider='telegram'). The default
// chat id (the chat the user opened with the bot) is saved at connect
// time; the agent can also pass an explicit chat_id.

import type { InlineToolDefinition } from "../types";

export const telegramSendMessageDefinition: InlineToolDefinition = {
  type: "inline",
  name: "telegram.send_message",
  description:
    "Send a Telegram message via the user's connected Telegram bot (a free @BotFather token). Use for 'message me on Telegram' or Telegram notifications. Sends to the chat saved when the bot was connected, or a chat_id you pass. The user must have started a chat with the bot first.",
  inputSchema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description:
          "The message text. Sent as PLAIN text — do not use Markdown/HTML markup (asterisks, underscores, brackets render literally).",
      },
      chat_id: {
        type: "string",
        description:
          "Optional target chat id. Defaults to the chat saved when the bot was connected.",
      },
    },
    required: ["text"],
  },
};

export type TelegramSendMessageInput = {
  text: string;
  chat_id?: string;
};

export type TelegramSendMessageResult = {
  messageId: number;
  chatId: string;
};
