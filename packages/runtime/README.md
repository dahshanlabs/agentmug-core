# @agentmug/runtime

Runtime for defining and executing **portable AI workers**. One engine reads the same `.agent` file in AgentMug Cloud, on the desktop (Tauri), from the CLI, and embedded in your own Node service.

> **Terminology.** *Worker* is the product concept; **`.agent`** is the portable format, and this package's API keeps `agent` throughout.
>
> **Host parity is partial, not identical.** The engine, format, streaming, and pause/resume behave the same everywhere, but each host supplies its own tool executors — so tool catalogs genuinely differ. A tool that is not registered on a host returns an `Unknown tool` result for that call and the run continues. Check what a given host actually wired before assuming parity.

```bash
npm install @agentmug/runtime
```

## Hello agent in 10 lines

```typescript
import { quickRun, parseAgentFile } from "@agentmug/runtime";
import { readFileSync } from "node:fs";

const agentFile = parseAgentFile(JSON.parse(readFileSync("./hello.agent", "utf8")));

const result = await quickRun({
  agentFile,
  userInput: "Say hi in 5 words.",
  llm: { anthropicApiKey: process.env.ANTHROPIC_API_KEY! },
  onEvent: (e) => e.type === "token" && process.stdout.write(e.content),
});

console.log("\n→", result.totalTokens, "tokens");
```

That's the whole API for a quickstart. `quickRun()` wires in-memory persistence + tracing for you. When you need production storage, swap in `runAgent()` directly with your own adapters — everything below is optional power.

## What you get out of the box

- **Multi-LLM** — Anthropic, OpenAI, Gemini. Routes by model-ID prefix (`claude-sonnet-4-6`, `claude-opus-4-8`, `gpt-4o`, `gemini-2.0-flash`). No allowlist, so newer model IDs work without a runtime upgrade. Per-model token pricing.
- **Pluggable adapters** — persistence, tracing, LLM, transcription, reminders, OAuth. Swap any layer.
- **Streaming events** — `started`, `token`, `tool_start`, `tool_complete`, `paused`, `error`, `done`.
- **Abort + pause/resume** — `AbortSignal` aborts mid-run (cuts the in-flight LLM stream). `ask_user` pauses for input; resume from a snapshot.
- **Learns durable preferences** — runs carry a "learn from feedback" directive, so when a user states a lasting preference the agent can write it into its own instructions as a new, reversible version. This is prompt-mediated and human-reviewable — it is **not** autonomous self-optimization.
- **Tool registry** — built-in tool *definitions* (Gmail, Slack, GitHub, Calendar, web search/browse, image gen, code exec, memory, shell, Twilio/WhatsApp/Telegram/Discord, Sheets, and more), plus pluggable MCP and HTTP tools. **Executors are supplied by the host**, so which of these actually run depends on where you run it.
- **MCP tool client** — call out to MCP servers (LangGraph, Continue toolbox, etc.). To be called *as* an MCP server, use [`@agentmug/mcp-bridge`](https://npmjs.com/package/@agentmug/mcp-bridge), which proxies to a hosted worker; this package does not contain an MCP server.
- **Portable `.agent` files** — declarative JSON spec (system prompt + tools + parameters + inputs/outputs + source requirements). Version-controllable. Forkable.
- **Verified sources + receipts** — a worker declares what evidence its job requires; the host binds the private material at runtime (files, folders, workspaces, providers, or KLYPIX brain snapshots). A required source that is missing, unauthorized, stale, or unreadable fails **before the first LLM call**, retrieved evidence carries citations and revisions, and every run returns a structured receipt of what it read. Sources are **read-only** — no adapter implements `write()`, and there is no upstream sync. Which source kinds are readable depends on the host adapter.

## The `.agent` file format

```json
{
  "$schema": "https://agentmug.com/schemas/agent.v1.json",
  "id": "email-triage",
  "name": "Email Triage",
  "description": "Sorts your unread Gmail and drafts replies.",
  "emoji": "📧",
  "blueprint": {
    "primaryModel": "claude-sonnet-4-6",
    "systemPrompt": "You triage emails…",
    "tools": ["gmail.send", "memory.save", "ask_user"]
  },
  "inputs": { "accepts": ["text"] },
  "outputs": { "shape": "text" }
}
```

Load it with `parseAgentFile(json)` and pass it to `quickRun()`. Production
hosts call `runAgent()` with a `PersistenceAdapter` that supplies the agent and
blueprint records.

### Private artifact bindings

A portable agent can require a document, table, or image without embedding the
author's private file. The `.agent` carries only a secret-free compatibility
contract:

```json
{
  "name": "source_file_1",
  "label": "Source table 1",
  "type": "file",
  "required": true,
  "artifact": {
    "kind": "table",
    "accepts": [".csv", ".xlsx"],
    "structure": ["Sheet \"Invoices\" columns: invoice_id, amount, due_date"]
  }
}
```

Every host binds its owner's local equivalent. Check it before ingesting any
private content:

```typescript
import { checkArtifactCompatibility } from "@agentmug/runtime";

const result = checkArtifactCompatibility(fileParameter, {
  filename: "my-invoices.xlsx",
  mimeType:
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  kind: "table",
  structure: ["Sheet \"Invoices\" columns: invoice_id, amount, due_date"],
});

if (!result.compatible) throw new Error(result.message);
```

File values, filenames, rows, prose, image bytes, credentials, brain pages, and
run history never belong in a shareable `.agent`. Storage and retrieval of the
bound content are host responsibilities; the AgentMug web builder is the
reference implementation.

### Source contracts

Use a `type: "file"` parameter when the user supplies one explicit file input.
Use top-level `sources[]` when an agent needs a durable knowledge source,
KLYPIX brain snapshot, working artifact, template, inbox, or output across runs:

```json
{
  "sources": [
    {
      "id": "operating_policy",
      "label": "Operating policy",
      "role": "knowledge",
      "kind": "file",
      "required": true,
      "accepts": { "extensions": [".pdf", ".docx"] },
      "truth": {
        "authority": "authoritative",
        "priority": 90,
        "conflictPolicy": "fail",
        "citations": "required"
      },
      "access": { "capabilities": ["read", "cite"] },
      "sharing": { "strategy": "rebind" }
    }
  ]
}
```

An attached `.klypix` in the AgentMug web builder is correction-aware grounding
from that saved snapshot. Its complete projection removes Archive history and
cards reversed by saved `superseded by` / `closed by` lifecycle edges or a
valid KLYPIX correction overlay; incomplete projections fail closed.

In the web flow, the authenticated owner client hashes the selected raw file
bytes (`idAttestation: "owner-client"`). Cloud independently hashes the indexed
current-card projection, but does not receive or reparse the original archive
bytes. Receipts preserve that trust label, the projection digest, consumed card
ids, and actual read time. CLI/Desktop hash the bytes in the host adapter and
use `idAttestation: "host-computed"`.

**Grounding only — not coordination.** A KLYPIX snapshot binding does **not**
call or join `brain_sync` coordination,
peer presence, messages, or file-overlap detection. For this binding, `stale`
means the snapshot/file revision no longer matches its verification pin, or the
verification expired, before the first model request. It does not mean that a
card is old, and it is not derived from `brain_doctor`. Saving the original
brain again does not update an already attached snapshot; attach and verify the
new saved revision.

Selected private card content, ids, and revision evidence are processed by the
configured embedding/model providers for grounding. They do not enter the
portable `.agent` or become public source data.

The contract above is portable. The actual path/provider item and credential
reference are a private `SourceBinding` supplied by each runtime:

```typescript
import {
  parseAgentFile,
  quickRun,
  type SourceAdapter,
  type SourceBinding,
} from "@agentmug/runtime";

const agentFile = parseAgentFile(agentJson);

const binding: SourceBinding = {
  id: "local-policy",
  sourceId: "operating_policy",
  adapterId: "local-documents",
  kind: "file",
  status: "ready",
  locator: { path: "/private/company-policy.pdf" }, // never serialized
  capabilities: ["read", "cite"],
};

const sourceAdapter: SourceAdapter = yourLocalDocumentsAdapter;

const result = await quickRun({
  agentFile,
  userInput: "What is the refund approval rule?",
  llm: yourLlmClient,
  sourceBindings: [binding],
  sourceAdapters: [sourceAdapter],
  // Optional: semantic retrieval and durable receipt storage.
  knowledge: yourKnowledgeAdapter,
  receipts: yourReceiptAdapter,
});

console.log(result.receipt);
```

`quickRun()` automatically passes `agentFile.sources` into the engine. A
missing required binding, permission, source adapter, structure, or freshness
guarantee fails before the first LLM request. Retrieved chunks are injected as
untrusted evidence with stable source/revision citations; an adapter cannot
relabel a chunk as another source. Evidence can inform an answer but can never
authorize a write, send, delete, credential use, or permission change.

The engine-populated `RunReceipt` records source reads, revisions, evidence
references, output hash, and final status. The portable receipt schema also
has typed fields for writes, approvals, and evaluation results as hosts wire
those execution seams. If receipt persistence is unavailable after a
successful run, the engine does not repeat completed side effects: it returns
the receipt with
`metadata.receiptPersistence === "failed"` so the host can surface the audit
storage outage honestly.

## Adapters — the universality lever

The runtime knows nothing about where it's running. Everything that touches the outside world is an adapter:

| Adapter | What it does | Example impls |
|---|---|---|
| `LlmClient` | Sends messages, streams tokens | `AnthropicLlmClient`, `OpenAiLlmClient`, `GeminiLlmClient`, or write your own |
| `PersistenceAdapter` | Creates/updates run records | Postgres (cloud), in-memory (CLI), `.agent` file (desktop) |
| `TracingAdapter` | Records LLM call telemetry | Postgres, console, OpenTelemetry |
| `TranscriptionAdapter` | Audio → text | Gemini live |
| `RemindersAdapter` | Where reminders land | iCloud CalDAV, local `.ics`, Postgres |
| `SourceAdapter` | Inspects and **reads** one bound source | Local files (CLI/desktop), indexed documents (cloud). No first-party impl writes — `write()` is unimplemented everywhere |
| `KnowledgeAdapter` | Retrieves cited source evidence | Interface only — no first-party implementation ships yet |
| `BrainAdapter` | Stores curated decisions and durable understanding | Klypix `.klypix` file reader (CLI/desktop) |
| `ReceiptAdapter` | Persists structured proof of each run | Postgres (cloud), on-disk (CLI), in-memory (desktop) |

The engine runs against any combination. What differs per host is which tool
executors and source adapters that host registers — not the engine itself.

## Tool registry

```typescript
import { InMemoryToolRegistry, gmailSendDefinition } from "@agentmug/runtime";

const tools = new InMemoryToolRegistry();
tools.register(gmailSendDefinition, new YourGmailExecutor());
```

Tools are normal classes implementing `ToolExecutor`. They receive a `ToolExecutionContext` with `runId`, `userId`, optional `signal` (for abort), and `currentToolUseId` (for streaming side channels).

## Sister packages

- [`@agentmug/cli`](https://npmjs.com/package/@agentmug/cli) — `agentmug run my.agent --input "..."`
- [`@agentmug/mcp-bridge`](https://npmjs.com/package/@agentmug/mcp-bridge) — expose any AgentMug agent as a Model Context Protocol tool

## Status

Pre-1.0 — published on npm and used by [agentmug.com](https://agentmug.com).
The API may still move before `v1.0` based on real-world adoption. Issues and
pull requests are welcome.

## License

Apache-2.0. Existing versions published under MIT remain MIT.
