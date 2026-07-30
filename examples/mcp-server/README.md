# mcp-server example

Expose any AgentMug agent as a Model Context Protocol server. The result: your agent becomes a callable tool inside Claude Desktop, Claude Code, Cursor, Continue, Cline — any MCP-compatible client.

You don't write code for this. You configure the client.

## Two paths

### Path A — Use an agent hosted on agentmug.com

The most common path. Build an agent at agentmug.com, generate an API key from the Deploy tab, then drop the bridge into your MCP client config:

```json
{
  "mcpServers": {
    "my-agent": {
      "command": "npx",
      "args": [
        "-y",
        "@agentmug/mcp-bridge",
        "https://agentmug.com/api/external/agents/<AGENT_ID>"
      ],
      "env": { "AGENTMUG_API_KEY": "am_agent_..." }
    }
  }
}
```

For Claude Desktop, paste this into `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%/Claude/claude_desktop_config.json` (Windows).

For Claude Code, paste it into `~/.claude/settings.json`.

For Cursor: Settings → Features → MCP → Add new MCP server, use `command` mode with the same npx invocation.

### Path B — Run your own AgentMug agent locally + expose it via MCP

If you've embedded `@agentmug/runtime` in your own backend and want to expose those agents via MCP, you need two things:

1. An HTTP endpoint at your host that mirrors AgentMug's manifest + invoke contract:
   - `GET /api/external/agents/<id>` returns the agent's tool definition
   - `POST /api/external/agents/<id>/invoke` runs the agent and returns the result
2. `@agentmug/mcp-bridge` pointed at your host instead of agentmug.com.

See [the bridge source](../../packages/mcp-bridge) for the contract — it's ~250 lines and the contract is small enough to re-implement against your own backend.

## What the bridge does

On startup, the bridge calls `GET <url>` to fetch the agent's manifest (name, description, input schema). It registers ONE MCP tool with that shape.

When the MCP host (Claude Desktop / Code / Cursor) calls the tool, the bridge `POST`s to `<url>/invoke` with the user's message. Your agent runs server-side — using whatever OAuth tokens it has, whatever memory it's accumulated — and the result comes back as MCP text content.

No new auth dance. No client-side state. The bridge is pure glue.
