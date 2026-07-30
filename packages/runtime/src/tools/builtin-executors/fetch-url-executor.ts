// Portable fetch_url executor — read a public web page / HTTP resource.
//
// Part of the first-party core-tools bundle (../core-plugin.ts). Browser-safe
// (uses global fetch + TextDecoder, no node:buffer / no host logger). The
// cloud keeps its own harder-edged copy; this one ships in @agentmug/runtime
// so the CLI/desktop get a working fetch_url instead of "Unknown tool".
//
// Safety: http(s) only, private/loopback hosts blocked, request timeout,
// response capped (~50 KB) so a giant page can't blow the LLM's context,
// HTML tag-stripped to plain text.

import type { ToolExecutor } from "../registry";
import type { FetchUrlInput, FetchUrlResult } from "../builtin/fetch-url";
import { isPrivateHost, safeFetchLocal } from "./net-guard";

const TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CHARS = 50_000;
const HARD_MAX_CHARS = 50_000;

export class FetchUrlExecutor implements ToolExecutor {
  async execute(input: unknown): Promise<FetchUrlResult> {
    const parsed = (input ?? {}) as Partial<FetchUrlInput>;
    if (typeof parsed.url !== "string" || !parsed.url.trim()) {
      throw new Error("fetch_url requires a 'url' string");
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(parsed.url.trim());
    } catch {
      throw new Error(`fetch_url: '${parsed.url}' is not a valid URL`);
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error(
        `fetch_url: only http(s) URLs are allowed, got '${parsedUrl.protocol}'`,
      );
    }
    if (isPrivateHost(parsedUrl.hostname)) {
      throw new Error(
        `fetch_url: refusing to fetch private/loopback host '${parsedUrl.hostname}'`,
      );
    }

    const maxChars = clamp(
      typeof parsed.max_chars === "number" ? parsed.max_chars : DEFAULT_MAX_CHARS,
      256,
      HARD_MAX_CHARS,
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      // safeFetchLocal re-validates every redirect hop so a public URL can't
      // 30x-bounce into the user's LAN / a metadata endpoint. allowHttp: this
      // tool intentionally accepts plain-http pages.
      res = await safeFetchLocal(parsedUrl.toString(), {
        allowHttp: true,
        signal: controller.signal,
        headers: {
          "user-agent": "AgentMug-Runtime/0.4 fetch_url",
          accept: "text/html,text/plain,application/json,*/*;q=0.8",
        },
      });
    } catch (err) {
      clearTimeout(timer);
      const message =
        err instanceof Error
          ? err.name === "AbortError"
            ? `fetch_url: request timed out after ${TIMEOUT_MS} ms`
            : err.message
          : String(err);
      throw new Error(message);
    }
    clearTimeout(timer);

    const contentType = res.headers.get("content-type") ?? "";
    let body = await res.text();

    if (/text\/html/i.test(contentType)) {
      body = htmlToText(body);
    }

    let truncated = false;
    if (body.length > maxChars) {
      body = body.slice(0, maxChars);
      truncated = true;
    }

    return {
      status: res.status,
      contentType,
      finalUrl: res.url || parsedUrl.toString(),
      truncated,
      body,
    };
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, " ")
    .trim();
}
