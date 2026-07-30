// Hello Agent — the minimum runnable AgentMug example.
//
// Run with:
//   pnpm install
//   export ANTHROPIC_API_KEY=sk-ant-...
//   pnpm start
//
// What it does: loads `hello.agent` from disk, runs it once with
// the prompt "Say hi in 5 words.", streams tokens to stdout. Total
// lines of code in this file: ~25.
//
// The `quickRun()` helper wires in-memory persistence + tracing so
// you can run an agent without configuring a database. For
// production, see `examples/web-research` for `runAgent()` + custom
// adapters.

import { readFileSync } from "node:fs";
import { quickRun, parseAgentFile } from "@agentmug/runtime";

const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
if (!anthropicApiKey) {
  console.error("Set ANTHROPIC_API_KEY in your shell first.");
  process.exit(1);
}

const agentFile = parseAgentFile(
  JSON.parse(readFileSync(new URL("./hello.agent", import.meta.url), "utf8")),
);

const result = await quickRun({
  agentFile,
  userInput: "Say hi in 5 words.",
  llm: { anthropicApiKey },
  onEvent: (e) => {
    if (e.type === "token") process.stdout.write(e.content);
  },
});

console.log(`\n\n→ ${result.totalTokens} tokens · ${result.latencyMs}ms`);
