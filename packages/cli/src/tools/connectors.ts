// CLI connector executors — environment-variable credentialed.
//
// The cloud executors read per-user credentials from the encrypted
// user_credentials DB. The CLI has no DB, so it reads credentials from
// environment variables — letting `agentmug run` actually SEND messages
// (Twilio SMS/WhatsApp, Telegram, Discord, Slack) the same way the cloud
// does, for true tri-runtime parity.
//
// Each executor throws a clear "set X env var" message when unconfigured,
// so a run surfaces an actionable error instead of silently doing nothing —
// mirroring the cloud executors, which throw when a connection is missing.

import type {
  ToolExecutor,
  TwilioSendSmsInput,
  TwilioSendWhatsappInput,
  TelegramSendMessageInput,
  DiscordSendMessageInput,
  SlackSendMessageInput,
} from "@agentmug/runtime";

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

// Twilio SMS + WhatsApp share the same Messages API + credentials; the only
// difference is a "whatsapp:" prefix on the To/From addresses.
async function twilioSend(
  channel: "sms" | "whatsapp",
  to: string,
  body: string,
  from?: string,
): Promise<{ sid: string; status: string }> {
  const sid = env("TWILIO_ACCOUNT_SID");
  const token = env("TWILIO_AUTH_TOKEN");
  const fromNumber = from ?? env("TWILIO_FROM_NUMBER");
  if (!sid || !token) {
    throw new Error(
      "Twilio is not configured. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN (and TWILIO_FROM_NUMBER) environment variables.",
    );
  }
  if (!fromNumber) {
    throw new Error("No Twilio sender number. Set TWILIO_FROM_NUMBER or pass 'from'.");
  }
  const pfx = (a: string) =>
    channel === "whatsapp" ? (a.startsWith("whatsapp:") ? a : `whatsapp:${a}`) : a;
  const auth = Buffer.from(`${sid}:${token}`, "utf8").toString("base64");
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method: "POST",
      headers: {
        authorization: `Basic ${auth}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: pfx(to), From: pfx(fromNumber), Body: body }).toString(),
    },
  );
  const json = (await res.json().catch(() => ({}))) as {
    sid?: string;
    status?: string;
    message?: string;
  };
  if (!res.ok || !json.sid) {
    throw new Error(
      `Twilio rejected the message (HTTP ${res.status})${json.message ? `: ${json.message}` : ""}.`,
    );
  }
  return { sid: json.sid, status: json.status ?? "queued" };
}

export class CliTwilioSendSmsExecutor implements ToolExecutor {
  async execute(input: unknown): Promise<unknown> {
    const p = (input ?? {}) as Partial<TwilioSendSmsInput>;
    if (!p.to || !p.body) throw new Error("twilio.send_sms requires 'to' and 'body'.");
    const r = await twilioSend("sms", String(p.to), String(p.body), p.from ? String(p.from) : undefined);
    return { ...r, to: p.to };
  }
}

export class CliTwilioSendWhatsappExecutor implements ToolExecutor {
  async execute(input: unknown): Promise<unknown> {
    const p = (input ?? {}) as Partial<TwilioSendWhatsappInput>;
    if (!p.to || !p.body) throw new Error("twilio.send_whatsapp requires 'to' and 'body'.");
    const r = await twilioSend("whatsapp", String(p.to), String(p.body), p.from ? String(p.from) : undefined);
    return { ...r, to: p.to };
  }
}

export class CliTelegramSendMessageExecutor implements ToolExecutor {
  async execute(input: unknown): Promise<unknown> {
    const p = (input ?? {}) as Partial<TelegramSendMessageInput>;
    if (!p.text) throw new Error("telegram.send_message requires 'text'.");
    const botToken = env("TELEGRAM_BOT_TOKEN");
    const chatId = (p.chat_id ? String(p.chat_id) : undefined) ?? env("TELEGRAM_CHAT_ID");
    if (!botToken) {
      throw new Error("Telegram is not configured. Set TELEGRAM_BOT_TOKEN (and TELEGRAM_CHAT_ID).");
    }
    if (!chatId) throw new Error("No Telegram chat id. Set TELEGRAM_CHAT_ID or pass 'chat_id'.");
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: p.text }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      description?: string;
      result?: { message_id?: number };
    };
    if (!res.ok || !json.ok) {
      throw new Error(
        `Telegram rejected the message (HTTP ${res.status})${json.description ? `: ${json.description}` : ""}.`,
      );
    }
    return { messageId: json.result?.message_id ?? 0, chatId };
  }
}

export class CliDiscordSendMessageExecutor implements ToolExecutor {
  async execute(input: unknown): Promise<unknown> {
    const p = (input ?? {}) as Partial<DiscordSendMessageInput>;
    if (!p.content) throw new Error("discord.send_message requires 'content'.");
    const webhookUrl = env("DISCORD_WEBHOOK_URL");
    if (!webhookUrl) throw new Error("Discord is not configured. Set DISCORD_WEBHOOK_URL.");
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(p.username ? { content: p.content, username: p.username } : { content: p.content }),
    });
    if (!res.ok) {
      throw new Error(`Discord rejected the webhook post (HTTP ${res.status}).`);
    }
    return { ok: true };
  }
}

export class CliSlackSendMessageExecutor implements ToolExecutor {
  async execute(input: unknown): Promise<unknown> {
    const p = (input ?? {}) as Partial<SlackSendMessageInput>;
    if (!p.channel || !p.text) throw new Error("slack.send_message requires 'channel' and 'text'.");
    const botToken = env("SLACK_BOT_TOKEN");
    if (!botToken) throw new Error("Slack is not configured. Set SLACK_BOT_TOKEN (a Bot User OAuth token, xoxb-…).");
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { authorization: `Bearer ${botToken}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel: p.channel, text: p.text }),
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; ts?: string; channel?: string };
    if (!res.ok || !json.ok) {
      throw new Error(`Slack rejected the message${json.error ? `: ${json.error}` : ` (HTTP ${res.status})`}.`);
    }
    return { ts: json.ts ?? "", channel: json.channel ?? p.channel, status: "sent" };
  }
}
