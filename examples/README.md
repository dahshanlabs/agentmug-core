# AgentMug examples

Runnable examples that demonstrate the runtime. Each subdirectory is a complete standalone project — clone or copy into your own repo and adapt.

| Example                          | What it shows                                                                                                                                 | Lines |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| [`hello-agent`](./hello-agent)   | The 25-line minimum: load a `.agent` file, run with `quickRun()`, stream tokens.                                                              | ~25   |
| [`web-research`](./web-research) | Agent that uses `web.fetch_json` to call public APIs (Hacker News, exchange rates, Wikipedia) and summarize results. The catalog-unlock demo. | ~85   |
| [`mcp-server`](./mcp-server)     | Expose an AgentMug agent as a Model Context Protocol server for Claude Desktop, Claude Code, Cursor, Continue. Configuration only — no code.  | 0     |

## Running the examples in this monorepo

```bash
pnpm install               # links the workspace @agentmug/runtime package
export ANTHROPIC_API_KEY=sk-ant-...
pnpm --filter agentmug-example-hello start
pnpm --filter agentmug-example-web-research start "what's hot on hn?"
```

## Running them outside the monorepo

Each example's `package.json` references `@agentmug/runtime` at `^0.1.0`, so you can copy a directory anywhere and `npm install && npm start` after publishing the runtime to npm.
