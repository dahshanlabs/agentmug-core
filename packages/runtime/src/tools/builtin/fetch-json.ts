// web.fetch_json — generic HTTP-API tool. The catalog unlock.
//
// Phase 28. Until now, every new integration needed either:
//   (a) a hand-written native executor (gmail.send, slack.send, …)
//   (b) an MCP server installed and routed through the proxy
//   (c) a Nango entry with provider config + UI affordance
//
// All three require code changes. That means any agent generated
// from a prompt could only reference tools the runtime already
// knew about. If an agent wanted to call, say, the Hacker News
// Algolia API or a customer's internal /status endpoint, it was
// stuck.
//
// `web.fetch_json` removes the bottleneck. The agent describes
// the HTTP call inline — method, URL, headers, body — and the
// runtime makes it. The response (parsed if JSON, raw text
// otherwise) is returned to the agent for reasoning.
//
// Security model:
//   - The host can restrict allowed origins via runtime config
//     (passing `allowedOrigins` to the executor at registration).
//     When unset, defaults to "any HTTPS origin" — appropriate
//     for sandboxed cloud + desktop deployments where the user
//     pre-approves the agent.
//   - We enforce HTTPS-only unless explicitly opted out.
//   - We cap response bodies at 64KB so a runaway agent can't
//     blow the context window.
//   - We never log Authorization / API-Key headers in the run
//     trace — the executor scrubs them before tracing.

import type { InlineToolDefinition } from "../types";

export const fetchJsonDefinition: InlineToolDefinition = {
  type: "inline",
  name: "web.fetch_json",
  description:
    "Make an HTTP request to any URL and return the response. Use this for APIs the runtime doesn't have a dedicated tool for — internal services, public APIs (HN, Wikipedia, Hacker News, weather, currency, etc.), webhooks. Returns parsed JSON when the response is JSON; otherwise returns the body as a string. Prefer dedicated tools (gmail.send, slack.send_message, etc.) when available — they handle OAuth + retries. DO NOT use for: authenticated endpoints requiring complex OAuth flows (use the dedicated tools), large file downloads (response capped at 64KB), or scraping HTML (use web.browse for that).",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description:
          "Full URL including scheme. HTTPS strongly preferred. Examples: 'https://hn.algolia.com/api/v1/search?query=ai', 'https://api.exchangerate.host/latest?base=USD'.",
      },
      method: {
        type: "string",
        enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
        description: "HTTP method. Defaults to GET.",
      },
      headers: {
        type: "object",
        description:
          "Optional headers as a flat key-value map. Common: { 'Authorization': 'Bearer ...', 'Accept': 'application/json' }. Avoid putting secrets here unless the user has explicitly authorized it.",
      },
      body: {
        description:
          "Optional request body. If a string, sent as-is. If an object, JSON.stringify'd and Content-Type defaulted to application/json.",
      },
      query: {
        type: "object",
        description:
          "Optional query parameters as a flat key-value map. Appended to the URL. Use this instead of building the query string by hand.",
      },
    },
    required: ["url"],
  },
};

export type FetchJsonInput = {
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
  query?: Record<string, string | number | boolean>;
};

export type FetchJsonResult =
  | {
      status: "ok";
      http_status: number;
      content_type: string | null;
      /** Parsed JSON if Content-Type is JSON; otherwise raw string. */
      body: unknown;
      truncated: boolean;
    }
  | {
      status: "http_error";
      http_status: number;
      content_type: string | null;
      body: unknown;
      truncated: boolean;
    }
  | {
      status: "error";
      message: string;
    };
