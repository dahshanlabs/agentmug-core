// Portable web.fetch_json executor — generic HTTP/JSON for any URL.
//
// Part of the first-party core-tools bundle (../core-plugin.ts). Browser-safe
// (global fetch + URL, env reads guarded). The cloud keeps its DNS-resolving
// safeFetch copy; this one ships in @agentmug/runtime so the CLI/desktop get a
// working web.fetch_json instead of "Unknown tool".
//
// Safety: HTTPS-only by default (set FETCH_JSON_ALLOW_HTTP=true to allow plain
// http for local services), private/loopback hosts blocked, request timeout,
// body capped at 64 KB (sets truncated:true so the model can paginate/narrow).

import type { ToolExecutor } from "../registry";
import type { FetchJsonInput, FetchJsonResult } from "../builtin/fetch-json";
import { isPrivateHost, readEnv, safeFetchLocal } from "./net-guard";

const RESPONSE_CAP_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 8_000;

export class FetchJsonExecutor implements ToolExecutor {
  async execute(input: unknown): Promise<FetchJsonResult> {
    const parsed = (input ?? {}) as Partial<FetchJsonInput>;
    if (!parsed.url || typeof parsed.url !== "string") {
      return { status: "error", message: "Missing or non-string `url`." };
    }

    let target: URL;
    try {
      target = new URL(parsed.url);
    } catch {
      return { status: "error", message: `Invalid URL: ${parsed.url}` };
    }

    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return {
        status: "error",
        message: `Only http(s) URLs are allowed, got '${target.protocol}'.`,
      };
    }
    const allowHttp = readEnv("FETCH_JSON_ALLOW_HTTP") === "true";
    if (target.protocol !== "https:" && !allowHttp) {
      return {
        status: "error",
        message:
          "Only HTTPS URLs are allowed. Set FETCH_JSON_ALLOW_HTTP=true to override (local development only).",
      };
    }
    if (isPrivateHost(target.hostname)) {
      return {
        status: "error",
        message: `Refusing to fetch private/loopback host '${target.hostname}'.`,
      };
    }

    if (parsed.query && typeof parsed.query === "object") {
      for (const [k, v] of Object.entries(parsed.query)) {
        target.searchParams.set(k, String(v));
      }
    }

    const method = (parsed.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {
      Accept: "application/json, text/plain;q=0.9, */*;q=0.5",
      "User-Agent": "AgentMug-Runtime/0.4 web.fetch_json",
    };
    if (parsed.headers && typeof parsed.headers === "object") {
      for (const [k, v] of Object.entries(parsed.headers)) {
        if (typeof v === "string") headers[k] = v;
      }
    }

    let body: string | undefined;
    if (parsed.body !== undefined && parsed.body !== null && method !== "GET") {
      if (typeof parsed.body === "string") {
        body = parsed.body;
      } else {
        body = JSON.stringify(parsed.body);
        if (!headers["Content-Type"] && !headers["content-type"]) {
          headers["Content-Type"] = "application/json";
        }
      }
    }

    const timeoutMs = Number(readEnv("FETCH_JSON_TIMEOUT_MS")) || DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      // safeFetchLocal re-validates every redirect hop (no blind redirect:follow
      // into a private target). allowHttp mirrors the FETCH_JSON_ALLOW_HTTP gate
      // already applied above.
      res = await safeFetchLocal(target.toString(), {
        method,
        headers,
        body,
        allowHttp,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const message =
        err instanceof Error
          ? err.name === "AbortError"
            ? `Request timed out after ${timeoutMs}ms`
            : err.message
          : String(err);
      return { status: "error", message };
    }
    clearTimeout(timer);

    const contentType = res.headers.get("content-type");
    const isJson = !!contentType && /json/i.test(contentType);

    const raw = await res.text();
    const truncated = raw.length > RESPONSE_CAP_BYTES;
    const capped = truncated ? raw.slice(0, RESPONSE_CAP_BYTES) : raw;

    let parsedBody: unknown = capped;
    if (isJson && capped.trim()) {
      try {
        parsedBody = JSON.parse(capped);
      } catch {
        parsedBody = capped;
      }
    }

    const baseResult = {
      http_status: res.status,
      content_type: contentType,
      body: parsedBody,
      truncated,
    };

    return res.ok
      ? { status: "ok", ...baseResult }
      : { status: "http_error", ...baseResult };
  }
}
