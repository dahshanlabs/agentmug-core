---
name: agentmug-worker-author
description: Author a portable AgentMug worker (.agent file) that validates, imports, and actually runs. Use when asked to build, generate, or export an AI worker/agent for AgentMug, to write a .agent file, or to deploy an agent to agentmug.com.
---

# Authoring AgentMug workers (.agent files)

A worker is ONE JSON file — no code, no secrets. The same file runs on the
AgentMug cloud, desktop app, and CLI. You author it, validate it locally,
and push it; the recipient connects their own accounts.

## The loop

```bash
npm i @agentmug/runtime          # parser + schema + capability matrix, versioned together
# 1. author (see below)
npx agentmug validate worker.agent --strict   # exit 0 = will import; warnings name unrunnable tools
npx agentmug push worker.agent --preview-only # dry-run: connections, rebinds, consent gates
npx agentmug push worker.agent                # imports; needs AGENTMUG_API_KEY (am_user_..., Settings → API)
```

## Author with buildAgentFile(), not hand-written JSON

`buildAgentFile()` validates by construction — it round-trips through the
exact parser every runtime executes, so what it returns cannot fail import
parsing:

```js
import { buildAgentFile, serializeAgentFile } from "@agentmug/runtime";
import { writeFileSync } from "node:fs";

const file = buildAgentFile({
  id: "invoice-chaser",              // stable slug
  name: "Invoice chaser",
  description: "Chases overdue invoices weekly and reports what it sent.",
  version: "1.0.0",
  exportedAt: new Date().toISOString(),
  blueprint: {
    primaryModel: "claude-sonnet-4-6",
    systemPrompt: "...",             // full instructions; reference {{params.tone}} placeholders
    tools: ["nango:outlook:list_messages", "nango:outlook:send_mail"],
  },
  parameters: [{ name: "tone", label: "Tone", type: "select", required: true,
    options: [{ value: "friendly", label: "Friendly" }, { value: "firm", label: "Firm" }] }],
  inputs: { accepts: ["text"] },
  triggers: [{ type: "schedule", cron: "0 9 * * 1", prompt: "Chase every overdue invoice.",
    timezone: "Asia/Riyadh", label: "Monday chase" }],
});
writeFileSync("worker.agent", serializeAgentFile(file));
```

## Rule 1 — only declare tools that exist

Check the capability matrix BEFORE picking tools; a tool outside it imports
but never fires:

```js
import matrix from "@agentmug/runtime/capabilities/agent-capabilities.v1.json" with { type: "json" };
// per tool: { id, provider, requiresConnection, cloud: { available, safeForPublicRuns }, runtimeCore: { available } }
```

Live copy: https://agentmug.com/schemas/agent-capabilities.v1.json

- `cloud.available: false` → do not target the cloud with it (e.g. `shell.execute` is desktop-only).
- `requiresConnection: true` → the importing user must connect that provider before runs work; say so in the worker's description.
- Anything not in the matrix → route through an MCP tool reference instead of inventing a builtin id.

## Rule 2 — declare honesty, don't fake capability

If the request asks for something no tool covers, do NOT write a prompt that
pretends. Declare a caveat — AgentMug shows it to the user before they run:

```js
blueprint: {
  caveats: [{
    requested: "Read my Apple Notes",
    doing: "Reads Notion pages instead",
    why: "No Apple Notes connector exists.",
  }],
  ...
}
```

Imports pass a creation-truth gate: a worker whose claims don't hold together
imports as **blocked**, not silently runnable. Coherent caveats are how a
generated worker passes on the first try.

## Rule 3 — never put private data in the file

No secrets, keys, file paths, addresses, or sample rows — the format carries
requirements, not values. Private files → `parameters` with `type: "file"`
plus a structural `artifact` contract, or `sources` requirements the
recipient rebinds. Delivery targets → references like `to: "owner"`, never a
literal address.

## What happens on import (so you can predict it)

- Unknown tools: imported, inert until an operator adds them.
- Schedules: imported **disabled**; the user enables them explicitly.
- Skills in the file: quarantined until the runtime re-verifies them.
- Brain/memory blocks: activate only with explicit consent (`--confirm-private-knowledge`).
- Sources: never inherit the author's bindings; the recipient rebinds their own.

## References

- Format spec: https://agentmug.com/spec/agent-v1.md (media type `application/vnd.agentmug.agent+json`)
- JSON Schema (CI-guarded against the parser): https://agentmug.com/schemas/agent.v1.json — also `@agentmug/runtime/schemas/agent.v1.json`
- Import API: `POST https://agentmug.com/api/agents/import` (and `/preview`), Bearer `am_user_` key
