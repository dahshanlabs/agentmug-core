// Web Researcher example — demonstrates the web.fetch_json built-in.
//
// The agent has ONE tool (web.fetch_json) and a system prompt that
// teaches it which public APIs to use for which questions. When you
// ask "what are the top HN stories about AI?", the agent calls the
// Algolia HN search API, reads the response, and summarizes.
//
// This is the canonical demo of the runtime's catalog-unlock thesis:
// any HTTP API becomes a capability without writing a custom tool
// executor.
//
// Run:
//   pnpm install
//   export ANTHROPIC_API_KEY=sk-ant-...
//   pnpm start "what are the top Hacker News stories about ai?"

import { readFileSync } from "node:fs";
import {
  quickRun,
  parseAgentFile,
  InMemoryToolRegistry,
  fetchJsonDefinition,
  type FetchJsonInput,
  type FetchJsonResult,
  type ToolExecutor,
  type ToolExecutionContext,
} from "@agentmug/runtime";

// A tiny inline executor for web.fetch_json. A production host should add
// header scrubbing, timeouts, response limits, allowlists, and an explicit
// network policy. The example stays intentionally small so the flow is clear.
class FetchJsonExecutor implements ToolExecutor {
  async execute(
    input: unknown,
    _ctx: ToolExecutionContext,
  ): Promise<FetchJsonResult> {
    const args = (input ?? {}) as Partial<FetchJsonInput>;
    if (!args.url) {
      return { status: "error", message: "Missing url" };
    }
    try {
      const url = new URL(args.url);
      if (args.query) {
        for (const [k, v] of Object.entries(args.query)) {
          url.searchParams.set(k, String(v));
        }
      }
      const res = await fetch(url, {
        method: args.method ?? "GET",
        headers: { Accept: "application/json", ...args.headers },
        body:
          args.body && args.method && args.method !== "GET"
            ? typeof args.body === "string"
              ? args.body
              : JSON.stringify(args.body)
            : undefined,
      });
      const text = await res.text();
      const contentType = res.headers.get("content-type");
      let body: unknown = text;
      if (contentType?.includes("json")) {
        try {
          body = JSON.parse(text);
        } catch {
          /* leave as text */
        }
      }
      return {
        status: res.ok ? "ok" : "http_error",
        http_status: res.status,
        content_type: contentType,
        body,
        truncated: text.length > 64 * 1024,
      };
    } catch (err) {
      return {
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

// ─── Run ─────────────────────────────────────────────────────────────

const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
if (!anthropicApiKey) {
  console.error("Set ANTHROPIC_API_KEY in your shell first.");
  process.exit(1);
}

const question =
  process.argv.slice(2).join(" ") ||
  "What are the top 3 Hacker News stories about AI right now?";

const agentFile = parseAgentFile(
  JSON.parse(readFileSync(new URL("./researcher.agent", import.meta.url), "utf8")),
);

const tools = new InMemoryToolRegistry();
tools.register(fetchJsonDefinition, new FetchJsonExecutor());

console.error(`> ${question}\n`);

const result = await quickRun({
  agentFile,
  userInput: question,
  llm: { anthropicApiKey },
  tools,
  onEvent: (e) => {
    if (e.type === "token") process.stdout.write(e.content);
    if (e.type === "tool_start") process.stderr.write(`\n[fetch ${(e.input as { url?: string }).url ?? "?"}]\n`);
  },
});

console.log(`\n\n→ ${result.totalTokens} tokens · ${result.latencyMs}ms`);
