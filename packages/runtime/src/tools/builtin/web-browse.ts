// web.browse — agents drive a real browser to do things APIs don't
// expose: filling forms, extracting content from JS-rendered pages,
// clicking through paywalls, scraping behind logins (with the user's
// consent), capturing screenshots of dynamic sites.
//
// One tool, multiple actions. The LLM picks an `action` per call —
// navigate, extract, screenshot, click, fill, press_key — and they
// chain across calls within the same browser session via `session_id`.
//
// Backed by Browserbase (managed Chromium-via-Playwright) in the
// cloud. Without BROWSERBASE_API_KEY the tool returns a clear "not
// configured" error and the LLM falls back to fetch_url for static
// content or to plain reasoning.
//
// User-facing label: "🌐 Browsing: <url>" — hides the mechanism, no
// "Playwright" / "headless Chromium" / "Browserbase" exposed.

import type { InlineToolDefinition } from "../types";

export const webBrowseDefinition: InlineToolDefinition = {
  type: "inline",
  name: "web.browse",
  description:
    "Drive a real browser to do things APIs don't expose: fill a form, extract content from a JavaScript-rendered page, click through a multi-step flow, capture a screenshot of a dynamic site. One call per action — chain multiple calls in sequence using session_id to keep the same browser open. Use this for: SPAs (React/Vue/Angular sites where fetch_url returns empty), paginated tables, sites with login walls, sites that require cookies, anything that's behind a form. NOT for static text content — fetch_url is faster for that.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["navigate", "extract", "screenshot", "click", "fill", "press_key", "close"],
        description:
          "What to do: navigate (open a URL), extract (return rendered text + links), screenshot (PNG of viewport), click (a link/button by text or selector), fill (an input by label or selector), press_key (Enter/Tab/Escape/etc), close (end the session). Most flows: navigate → extract or click/fill → extract again.",
      },
      url: {
        type: "string",
        description:
          "For action=navigate: the URL to open. Must be http(s). Ignored for other actions.",
      },
      session_id: {
        type: "string",
        description:
          "Reuse an existing browser session from a previous call. Required for all actions except `navigate` and the first call. The first navigate returns a fresh session_id you should pass on subsequent calls. Sessions auto-close after 5 minutes of inactivity.",
      },
      target: {
        type: "string",
        description:
          "For click/fill: what to interact with. Plain text label preferred ('Sign in' button, 'Email address' field). CSS selector also accepted if labels don't work ('#submit', 'button[type=submit]').",
      },
      value: {
        type: "string",
        description:
          "For fill: the text to type into the field. For press_key: the key to press (Enter / Tab / Escape / ArrowDown / etc).",
      },
      wait_for: {
        type: "string",
        enum: ["load", "domcontentloaded", "networkidle"],
        description:
          "For navigate: how long to wait before considering the page ready. networkidle (default) waits until ~no network activity, best for SPAs. load waits for the onload event. domcontentloaded is fastest.",
      },
      max_chars: {
        type: "number",
        description:
          "For extract: cap on returned characters. Default 8000, max 30000. Keeps the LLM context budget under control.",
      },
    },
    required: ["action"],
  },
};

export type WebBrowseInput = {
  action:
    | "navigate"
    | "extract"
    | "screenshot"
    | "click"
    | "fill"
    | "press_key"
    | "close";
  url?: string;
  session_id?: string;
  target?: string;
  value?: string;
  wait_for?: "load" | "domcontentloaded" | "networkidle";
  max_chars?: number;
};

export type WebBrowseResult = {
  status: "ok" | "error";
  /** Session id to reuse on the next call. Empty after action=close or on error. */
  session_id: string;
  /** Current page URL after the action. */
  url: string;
  /** Page title after the action. */
  title: string;
  /** Set when action=extract — clean text content + outbound links. */
  extract?: {
    text: string;
    links: Array<{ text: string; href: string }>;
    truncated: boolean;
  };
  /** Set when action=screenshot — base64 PNG of the viewport. */
  screenshot_png?: string;
  /** Human-readable summary of what happened — for the LLM trace. */
  message: string;
  /** Wall-clock ms the action took. */
  duration_ms: number;
};
