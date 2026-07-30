# n8n-nodes-agentmug

Run your **AgentMug** agents from inside [n8n](https://n8n.io). Drop an
**AgentMug** node into any workflow, point it at an agent, send it a message,
and get the result back — to chain into the other 1,000+ n8n nodes.

## Why it's different

The agent acts through **your own connected-account tokens** (Gmail, Sheets,
Bluesky, …) — those credentials stay yours and are never copied into the
workflow. And the agent is a **portable `.agent` file you own**: export it and
run it on the web, desktop, or CLI, rather than a node locked to one vendor's
cloud.

Two things to know before you wire it up:

- **Model inference is billed to whoever runs the endpoint.** This node calls
  the hosted AgentMug endpoint by default, where inference runs on the
  operator's key — not yours. Point `Base URL` at your own deployment if you
  want inference on your own key.
- **Tool coverage differs per host.** The cloud has the full catalog, so an
  agent that works here may hit an unwired tool when you run the same file on
  desktop or CLI.

## Install

**Community Nodes (recommended):** in n8n → **Settings → Community Nodes →
Install** → `n8n-nodes-agentmug`.

**Manual:**

```bash
cd ~/.n8n/nodes        # or your n8n custom-nodes dir
npm install n8n-nodes-agentmug
```

## Configure

1. In AgentMug → **Settings → API Keys**, create a **user key** (`am_user_…`).
2. In n8n, add an **AgentMug API** credential and paste the key. (Self-hosted?
   set **Base URL** to your instance.)

## Use

1. Add the **AgentMug** node.
2. **Agent ID** — from the agent's URL: `/agents/<id>`.
3. **Message** — what you want it to do (use n8n expressions to pass data in).
4. Output: **Full Response** (output + tool calls + tokens + cost) or **Output Only**.

### Minimal example workflow

Replace `YOUR_AGENT_ID`, import this JSON into n8n, attach your AgentMug
credential to the second node, and run it manually:

```json
{
  "name": "Run an AgentMug agent",
  "nodes": [
    {
      "parameters": {},
      "id": "manual-trigger",
      "name": "When clicking Execute Workflow",
      "type": "n8n-nodes-base.manualTrigger",
      "typeVersion": 1,
      "position": [0, 0]
    },
    {
      "parameters": {
        "agentId": "YOUR_AGENT_ID",
        "message": "Summarize what you can do in three bullets.",
        "outputField": "output"
      },
      "id": "run-agentmug",
      "name": "Run AgentMug",
      "type": "n8n-nodes-agentmug.agentMug",
      "typeVersion": 1,
      "position": [260, 0]
    }
  ],
  "connections": {
    "When clicking Execute Workflow": {
      "main": [[{ "node": "Run AgentMug", "type": "main", "index": 0 }]]
    }
  },
  "active": false,
  "settings": {}
}
```

## A2A discovery

Every marketplace-listed AgentMug agent also exposes a standards-compliant
**A2A Agent Card** at
`https://agentmug.com/api/a2a/agents/<id>/.well-known/agent.json`
and a JSON-RPC endpoint (`message/send`, `message/stream`) — so A2A-native tools
can discover and call it without this node, too.

## Build (for contributors)

```bash
npm install
npm run build      # tsc → dist/
```

MIT © Dahshan Labs

## License and trademarks

The source code in this npm package is licensed under the MIT License. The
AgentMug name, Mughead character, logos, and visual identity are trademarks of
Dahshan Labs and are not licensed for use as the identity of a fork or
unofficial distribution. See the public repository's
[trademark policy](https://github.com/dahshanlabs/agentmug-core/blob/main/TRADEMARKS.md).

## Maintainer release setup

Releases come only from the public `dahshanlabs/agentmug-core` repository's
`.github/workflows/release-n8n.yml` workflow. Protect `main` and the
`n8n-v*` tag pattern, require a reviewer on the `npm-production` environment,
and set the repository variable `AGENTMUG_RELEASE_ENABLED=true` only when the
public release is approved.

npm won't allow a trusted publisher to be configured until the unscoped
package exists. For the first version only:

1. Protect an `npm-bootstrap` GitHub environment with a required reviewer.
2. Create a granular npm token with write permission, bypass 2FA, and the
   shortest available expiry (one day). A nonexistent unscoped package cannot
   yet be selected as that token's package restriction, so use an npm owner
   with no unrelated package access where practical.
3. Save it only as the `NPM_N8N_BOOTSTRAP_TOKEN` environment secret and
   manually run **Release n8n integration** from protected `main`, entering the
   exact version and confirmation phrase requested by the workflow.
4. Immediately revoke the token and delete the GitHub secret.

The bootstrap path is deliberately resumable. If npm accepts `0.1.0` but a
later evidence or GitHub-release job fails, revoke the token anyway and rerun
the same protected dispatch with the same version and confirmation. The
workflow verifies the registry integrity, skips a second publish, and resumes
the draft release. Never create a replacement version just to repair release
metadata.

Then configure the npm trusted publisher for organization `dahshanlabs`,
repository `agentmug-core`, workflow `release-n8n.yml`, environment
`npm-production`, and permission `npm publish`. Set npm publishing access to
require 2FA and disallow tokens. Enable GitHub immutable releases before any
publication. Every later release is an OIDC-only protected `n8n-v<version>`
tag; rerunning that exact tag is the recovery path after a partial workflow.
The workflow verifies the exact registry tarball, generates an SPDX SBOM,
records GitHub attestations, stages and verifies every asset on a draft, then
publishes and asserts that the matching GitHub release is immutable.
