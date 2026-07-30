# web-research

An AgentMug agent that calls public HTTP APIs to answer questions with current data. Demonstrates the `web.fetch_json` built-in tool.

## Run

```bash
pnpm install
export ANTHROPIC_API_KEY=sk-ant-...

pnpm start "What are the top Hacker News stories about AI?"
pnpm start "What's the current USD to EUR rate?"
pnpm start "When was the moon landing?"
```

## What's happening

- `researcher.agent` declares one tool: `web.fetch_json`. The system prompt teaches the agent which public APIs to use for which kinds of questions.
- `index.ts` registers a tiny inline `FetchJsonExecutor`. Production hosts should add header scrubbing, timeouts, allowlists, response limits, and explicit network policy.
- When you ask a question, the agent picks an API, calls it via the tool, reads the response, and summarizes.

This is the canonical demo of the runtime's catalog-unlock thesis: **any HTTP API becomes a capability without writing a custom tool executor**.

## Try modifying

- Change the system prompt to add new API recommendations.
- Add a second tool: register `web.fetch_json` again with a different name + an allowlist of base URLs (e.g. `internal_api.fetch_json` restricted to your company's domain).
- Wire `runAgent()` with a Postgres persistence adapter to log every query for analysis.
