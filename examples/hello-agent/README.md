# hello-agent

The minimum runnable AgentMug example. ~25 lines, no tools, no database, no setup beyond an Anthropic API key.

## Run

```bash
pnpm install
export ANTHROPIC_API_KEY=sk-ant-...
pnpm start
```

You'll see the agent stream its response to stdout, followed by a token count.

## What's happening

- `hello.agent` is a portable `.agent` JSON file — declarative spec for the agent's name, description, system prompt, model, and tool list.
- `index.ts` loads that file, validates it with `parseAgentFile()`, and runs it with `quickRun()`.
- `quickRun()` wires in-memory persistence + tracing so you don't need a database or tracing pipeline to get started.

## Next

- [examples/web-research](../web-research) — an agent that uses `web.fetch_json` to call a public API and summarize the result.
- [examples/mcp-server](../mcp-server) — expose any AgentMug agent to Claude Code / Cursor via `@agentmug/mcp-bridge`.
- [The runtime README](https://github.com/dahshanlabs/agentmug-core/tree/main/packages/runtime) — full API reference.
