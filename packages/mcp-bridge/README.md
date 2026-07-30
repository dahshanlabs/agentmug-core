# @agentmug/mcp-bridge

Expose any [AgentMug](https://agentmug.com) agent as a Model Context Protocol (MCP) tool. Works with Claude Desktop, Claude Code, Cursor, Continue, Cline, and any other MCP-compatible client.

## Why

You designed an agent on AgentMug (with its OAuth-connected Gmail / Slack / GitHub / Notion / Linear access, its memory, its prompt-engineered system message). Now you want to call that agent from inside Claude Code while you're working on a different task.

This bridge makes the agent show up as a tool in your MCP client. No new code paths, no second OAuth, no copying credentials around — the agent runs server-side on AgentMug with its existing setup, and the result comes back to your client.

## Install

In your MCP client config (example: Claude Desktop / Claude Code at `~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "email-assistant": {
      "command": "npx",
      "args": [
        "-y",
        "@agentmug/mcp-bridge",
        "https://agentmug.com/api/external/agents/<YOUR_AGENT_ID>"
      ],
      "env": {
        "AGENTMUG_API_KEY": "am_agent_..."
      }
    }
  }
}
```

Generate the agent ID and API key from your AgentMug agent's **Deploy → External access** tab.

## Usage

Once configured, the agent appears as a callable tool in your MCP client. In Claude Code:

```
> use email-assistant to summarize my unread emails from this week
```

The bridge forwards the call to AgentMug, the agent runs there (with its Gmail OAuth), and the answer streams back into your conversation.

## Config

- `AGENTMUG_API_KEY` (required) — per-agent API key from the Deploy tab.
- `AGENTMUG_HOST` (optional) — if you pass only an agent ID rather than a full URL, this is the host the bridge prepends. Defaults to `https://agentmug.com`.
- `AGENTMUG_ALLOW_INSECURE_LOCALHOST=1` (local development only) — permits an
  `http://localhost/...` manifest. Remote manifests are HTTPS-only.

The first positional arg can be either:
- A full manifest URL: `https://agentmug.com/api/external/agents/<id>`
- A bare agent ID: `<id>` (uses `AGENTMUG_HOST` to build the URL)

API keys belong in the environment, never in the URL or command arguments. The
bridge rejects credentials, query strings, fragments, redirects, non-AgentMug
manifest paths, and insecure remote HTTP before sending the key.

## Grounded sources and run receipts

An agent can declare private source requirements such as `knowledge workbook`,
`working folder`, or `KLYPIX brain snapshot`. The bridge exposes the secret-free
requirement/readiness contract as an MCP resource:

```text
agentmug://agents/<id>/source-contract
```

The resource tells the MCP host which roles are ready, missing, or stale. It
never contains the bound filename, local/provider path, account id, cursor, or
source content. If a required source is missing, AgentMug refuses the run rather
than quietly answering ungrounded.

For a web-attached `.klypix`, AgentMug uses a complete correction-aware
current-card projection of the saved snapshot as grounding; Archive history is
excluded and incomplete projections fail closed. **Grounding only — not
coordination.** The MCP bridge exposes readiness and invokes the AgentMug
agent; it does **not** turn that snapshot into a live KLYPIX MCP session or
join `brain_sync` coordination, peer presence, messages, or file-overlap
detection.

For a KLYPIX snapshot, `stale` means the snapshot/file revision drifted from
its verification pin, or verification expired, before the model was called. It
does not mean that a card is old, and it is not derived from `brain_doctor`.
Saving the original brain requires attaching and verifying a new snapshot.

After a call, the bridge also exposes:

```text
agentmug://agents/<id>/latest-run-receipt
```

That receipt summarizes evidence reads, writes, approvals, and evaluations for
the run. A KLYPIX read includes the brain revision, its trust label
(`owner-client` in web, `host-computed` in local runtimes), the independently
hashed evidence projection, consumed card ids, and actual read timestamp. The
tool result includes the same receipt as structured MCP content so automation
can inspect it without scraping prose.

## How it works

1. On startup, the bridge fetches `<manifest-url>` with the API key. AgentMug returns the agent's name, description, input schema, and a private-data-free source readiness summary.
2. The bridge starts an MCP server on stdio and registers the agent as one tool plus inspectable source/receipt resources.
3. When the MCP client calls the tool, the bridge `POST`s to `<manifest-url>/invoke` with the user's message.
4. AgentMug runs the agent server-side (using its OAuth tokens, its memory, its full tool catalog) and returns the result.
5. The bridge wraps the result as MCP text content and hands it back to the client.

All AgentMug-side complexity stays behind the HTTP API. This package is intentionally minimal (~250 lines) so it stays easy to audit.

## License

Apache-2.0. Existing versions published under MIT remain MIT.
