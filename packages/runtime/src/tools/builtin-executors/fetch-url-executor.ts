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

const RAW_TEXT_TAGS = new Set(["script", "style", "noscript"]);

type HtmlTag = {
  closing: boolean;
  name: string;
  selfClosing: boolean;
};

function isWhitespace(character: string | undefined): boolean {
  return character !== undefined && character.trim() === "";
}

function findTagEnd(html: string, start: number): number {
  let quote: '"' | "'" | null = null;
  for (let index = start + 1; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return -1;
}

function parseHtmlTag(html: string, start: number, end: number): HtmlTag | null {
  let cursor = start + 1;
  while (cursor < end && isWhitespace(html[cursor])) cursor += 1;

  const closing = html[cursor] === "/";
  if (closing) cursor += 1;
  while (cursor < end && isWhitespace(html[cursor])) cursor += 1;

  const nameStart = cursor;
  while (cursor < end) {
    const code = html.charCodeAt(cursor);
    const isLetter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    const isDigit = code >= 48 && code <= 57;
    if (!isLetter && !isDigit && code !== 45 && code !== 58) break;
    cursor += 1;
  }
  if (cursor === nameStart) return null;

  let tail = end - 1;
  while (tail > cursor && isWhitespace(html[tail])) tail -= 1;
  return {
    closing,
    name: html.slice(nameStart, cursor).toLowerCase(),
    selfClosing: !closing && html[tail] === "/",
  };
}

function startsRawTextClosingTag(html: string, start: number, expectedName: string): boolean {
  let cursor = start + 1;
  if (html[cursor] !== "/") return false;
  cursor += 1;
  while (isWhitespace(html[cursor])) cursor += 1;

  if (html.slice(cursor, cursor + expectedName.length).toLowerCase() !== expectedName) {
    return false;
  }
  const boundary = html[cursor + expectedName.length];
  return boundary === ">" || boundary === "/" || isWhitespace(boundary);
}

function stripHtmlMarkup(html: string): string {
  let text = "";
  let suppressedTag: string | null = null;
  let cursor = 0;

  while (cursor < html.length) {
    if (html[cursor] !== "<") {
      if (!suppressedTag) text += html[cursor];
      cursor += 1;
      continue;
    }

    if (suppressedTag && !startsRawTextClosingTag(html, cursor, suppressedTag)) {
      cursor += 1;
      continue;
    }

    if (html.startsWith("<!--", cursor)) {
      const commentEnd = html.indexOf("-->", cursor + 4);
      cursor = commentEnd === -1 ? html.length : commentEnd + 3;
      if (!suppressedTag) text += " ";
      continue;
    }

    const tagEnd = findTagEnd(html, cursor);
    if (tagEnd === -1) {
      if (!suppressedTag) text += html.slice(cursor);
      break;
    }

    const tag = parseHtmlTag(html, cursor, tagEnd);
    if (!tag) {
      const declaration = html[cursor + 1] === "!" || html[cursor + 1] === "?";
      if (declaration) {
        if (!suppressedTag) text += " ";
        cursor = tagEnd + 1;
      } else {
        if (!suppressedTag) text += "<";
        cursor += 1;
      }
      continue;
    }

    const wasSuppressed = suppressedTag !== null;
    if (suppressedTag) {
      if (tag.closing && tag.name === suppressedTag) suppressedTag = null;
    } else if (!tag.closing && !tag.selfClosing && RAW_TEXT_TAGS.has(tag.name)) {
      suppressedTag = tag.name;
    }
    if (!wasSuppressed || suppressedTag === null) text += " ";
    cursor = tagEnd + 1;
  }

  return text;
}

function decodeHtmlEntities(text: string): string {
  const namedEntities: Record<string, string> = {
    amp: "&",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  let decoded = "";

  for (let cursor = 0; cursor < text.length; ) {
    if (text[cursor] !== "&") {
      decoded += text[cursor];
      cursor += 1;
      continue;
    }

    let entityEnd = -1;
    const searchEnd = Math.min(text.length, cursor + 14);
    for (let index = cursor + 1; index < searchEnd; index += 1) {
      if (text[index] === ";") {
        entityEnd = index;
        break;
      }
    }
    if (entityEnd === -1) {
      decoded += "&";
      cursor += 1;
      continue;
    }

    const rawEntity = text.slice(cursor + 1, entityEnd);
    const entity = rawEntity.toLowerCase();
    let replacement = namedEntities[entity];
    if (replacement === undefined && entity.startsWith("#")) {
      let codePoint = 0;
      let valid = entity.length > 1;
      for (let index = 1; index < entity.length; index += 1) {
        const code = entity.charCodeAt(index);
        if (code < 48 || code > 57) {
          valid = false;
          break;
        }
        codePoint = codePoint * 10 + code - 48;
      }
      if (valid && codePoint <= 0x10ffff && (codePoint < 0xd800 || codePoint > 0xdfff)) {
        replacement = String.fromCodePoint(codePoint);
      }
    }

    decoded += replacement ?? text.slice(cursor, entityEnd + 1);
    cursor = entityEnd + 1;
  }

  return decoded;
}

function collapseWhitespace(text: string): string {
  let collapsed = "";
  let pendingSpace = false;
  for (const character of text) {
    if (isWhitespace(character)) {
      pendingSpace = collapsed.length > 0;
    } else {
      if (pendingSpace) collapsed += " ";
      collapsed += character;
      pendingSpace = false;
    }
  }
  return collapsed;
}

export function htmlToText(html: string): string {
  return collapseWhitespace(decodeHtmlEntities(stripHtmlMarkup(html)));
}
