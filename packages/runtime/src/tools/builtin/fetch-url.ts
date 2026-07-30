// fetch_url — read a public web page or HTTP resource.
//
// Builtin (no user auth required). The executor on the cloud side
// enforces a small set of safety constraints:
//   - http/https only
//   - private IPs blocked (basic SSRF defense; not exhaustive)
//   - 10s timeout
//   - response truncated to ~50KB so a giant page doesn't blow the
//     LLM's context window
// HTML responses get tag-stripped to plain text before being returned
// to Claude — agents almost always want article content, not markup.

import type { InlineToolDefinition } from "../types";

export const fetchUrlDefinition: InlineToolDefinition = {
  type: "inline",
  name: "fetch_url",
  description:
    "Fetch a public URL and return its body as plain text. Use for reading articles, public APIs, or any web resource that doesn't require authentication. The response is truncated to 50 KB.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description:
          "The URL to fetch. Must start with http:// or https://. Private/local IPs are rejected.",
      },
      // Optional: lets the LLM say "I just want headlines" vs "I want
      // the full article" — we return the first N chars only.
      max_chars: {
        type: "number",
        description:
          "Optional max characters to return. Defaults to 50000. Clamped to 50000.",
      },
    },
    required: ["url"],
  },
};

export type FetchUrlInput = {
  url: string;
  max_chars?: number;
};

export type FetchUrlResult = {
  status: number;
  contentType: string;
  finalUrl: string;
  truncated: boolean;
  body: string;
};
