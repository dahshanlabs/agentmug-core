// slack.send_message — post a message to a Slack channel the user
// has authorized.
//
// Definition is portable. The cloud executor uses the user's OAuth
// bot token (stored in user_credentials.provider='slack') to call
// chat.postMessage. AgentMug never sees the token after the user
// installs the AgentMug Slack app.

import type { InlineToolDefinition } from "../types";

export const slackSendMessageDefinition: InlineToolDefinition = {
  type: "inline",
  name: "slack.send_message",
  description:
    "Post a message to a Slack channel the user has authorized. The bot token never leaves the user's account; AgentMug forwards it to slack.com on the user's behalf.",
  inputSchema: {
    type: "object",
    properties: {
      channel: {
        type: "string",
        description:
          "Slack channel id (preferred, e.g. 'C01234ABCDE') or channel name (e.g. '#general'). Names are resolved by Slack server-side.",
      },
      text: {
        type: "string",
        description: "Message body. Slack mrkdwn is supported (bold _italic_ `code` etc.).",
      },
    },
    required: ["channel", "text"],
  },
};

export type SlackSendMessageInput = {
  channel: string;
  text: string;
};

export type SlackSendMessageResult = {
  ts: string;
  channel: string;
  status: "sent";
};
