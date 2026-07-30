# @agentmug/cli

Run AgentMug agents from any shell. Same `.agent` file as the cloud and desktop runtimes — runs locally with your own keys.

```bash
npm install -g @agentmug/cli
# or just
npx @agentmug/cli run my.agent --input "Hello"
```

## Why a CLI

Three audiences:

1. **You, in a terminal** — run a `.agent` file as a cron job, GitHub Action, or part of a shell pipeline.
2. **Other AgentMug agents** — Local Doer (the desktop agent with shell access) can use this CLI to create, fork, or invoke agents on agentmug.com. **An agent that builds agents.**
3. **Any LLM tool with shell access** — Claude Code, Cursor with shell, Cline, your own scripts. Any of them can call `agentmug` to reach AgentMug-hosted agents.

## Quickstart

```bash
# Local run — uses your Anthropic key
export ANTHROPIC_API_KEY=sk-ant-...
agentmug run path/to/my.agent --input "Summarize today's news"

# Pipe stdin
echo "Translate: Hello world" | agentmug run translate.agent --stdin

# JSON output for scripting
agentmug run brief.agent --input "tech" --json | jq .response

# Setup check — what this agent needs vs what THIS machine has.
# Read-only, never runs the agent, exit 1 if anything is missing (CI-friendly).
agentmug check path/to/my.agent
```

## Grounded local sources

A `.agent` may declare the files, folders, workspaces, or KLYPIX file snapshot
it needs.
The declaration is portable; the selected local path is not. Bindings live in
the CLI's private state, keyed to this exact installed `.agent` file:

```bash
agentmug sources list finance.agent
agentmug sources bind finance.agent invoice_workbook ./private/Invoices.xlsx
agentmug sources check finance.agent
agentmug run finance.agent --input "Which invoices are overdue?"
agentmug sources unbind finance.agent invoice_workbook

# Inspect or explicitly remove private grounding receipts
agentmug receipts list finance.agent
agentmug receipts get finance.agent <run-id>
agentmug receipts delete finance.agent <run-id>
```

Sharing or copying `finance.agent` shares only its source requirements. The
recipient must bind their own equivalent source; no local path, credential,
binding, or receipt is embedded in the file. A run fails before the model is
called when a required source is missing, incompatible, stale, unreadable, or
requires a capability the CLI cannot safely provide. Changing the agent's
prompt-affecting identity, blueprint, tools, embedded brain, or source contract
revokes existing local bindings and requires an explicit rebind.

The local adapter is read-only:

- Text, CSV/TSV, JSON/JSONL, Markdown, common source code, DOCX, XLSX, and
  bounded KLYPIX v4 brain ZIPs are supported. KLYPIX imports only text cards,
  section context, and relationships; commands, skills, verification fields,
  and embedded assets never become evidence.
- **Grounding only — not coordination.** A local KLYPIX binding reads the
  selected saved file only. It does not call or join `brain_sync`, peer presence, messages, or
  file-overlap detection. Its static projection is current-truth only:
  superseded/closed and Archive-area cards are excluded, correction-cue
  successors are prioritized, and ambiguous or cyclic lifecycle graphs fail
  closed. Historical/as-of retrieval remains a native KLYPIX `brain_ask`
  capability, not a snapshot-source feature.
- Folders and workspaces recurse through at most 100 supported files / 50 MB.
  Traversal is capped at 2,000 directory entries and depth 20. Hidden paths,
  symlinks, dependency folders, VCS data, build output, and AgentMug's private
  state are excluded.
- Per-file input is 10 MB; KLYPIX is 5 MB. Text extraction must complete within
  90,000 characters per file. KLYPIX has separate bounded limits: 1,000 items,
  5,000 relationships, 16 KiB (16,384 characters) per card, and 500,000 extracted
  characters.
- Office ZIPs are limited to 2,000 entries / 32 MB expanded / 16 MB per entry /
  80:1 compression, 500,000 XML elements, 50 sheets, 250,000 populated rows,
  and 30,000 extracted cells. An asynchronous 15-second deadline is also used,
  but synchronous third-party parser work is not forcibly preempted.
- `snapshot` freshness pins the approved file revision; a change requires
  rebind. `on-run` re-inspects the local source before each run. That source
  refresh is not KLYPIX `brain_sync` coordination. Continuous `watch`
  freshness fails closed.
- For a KLYPIX file, `stale` means its file revision no longer matches the
  verified pin, or that verification expired, before the model is called. It
  does not mean that a card is old, and it is not derived from `brain_doctor`.
- `read:on-bind` requires the explicit `--approve` flag. `every-run` and
  `every-action` read approvals cannot be collected by this unattended host and
  fail closed.
- Provider resources, writes/appends/creates/deletes, and source JSON Schema
  requirements are not implemented by this CLI host and fail closed.

Portable source requirements are capability requests, not a promise that every
host supports every format. AgentMug web/cloud may support PDF and image
attachments; this CLI currently does not extract PDF or image evidence. A
portable `.agent` requiring one of those formats remains shareable, but
`sources check` reports it as unsupported until a capable adapter is installed.

Grounded content is sent to the inference provider configured for the agent's
model. Evidence is marked as untrusted data, cited by source/revision and
relative path, and recorded in a private structured run receipt. For sourced
runs, `--json` includes that receipt; interactive output prints a one-line
receipt summary. Neither form contains the private bound root path.
Receipts also record the agent version, the prompt/tool/source authority
fingerprint, and any `read:on-bind` approval used by the run. Private retention
is capped at 1,000 receipts / 100 MB; persistence failure is surfaced in JSON
and warned on stderr (including `--quiet`). Use `receipts list|get|delete` for
explicit lifecycle management; the CLI never silently deletes audit records.

## Coming in v0.2 — the agent-controllable surface

These commands hit `agentmug.com` over HTTPS with a user API key:

```bash
export AGENTMUG_API_KEY=am_user_...

agentmug create --prompt "Triage my Gmail and draft replies"
agentmug list
agentmug get email-triage
agentmug fork email-triage --as personal-email
agentmug invoke email-triage --input "Summarize unread from this week"
agentmug key new --agent email-triage
```

Together with `shell.execute` on AgentMug Desktop, this makes the **agent-builds-agent** flow real: an agent can describe what it wants and ship a working `.agent` file into your AgentMug account.

## Configuration

| Env var | Used for | Default |
|---|---|---|
| `ANTHROPIC_API_KEY` | Local `run` command | (required for local runs) |
| `AGENTMUG_HOST` | Cloud subcommands | `https://agentmug.com` |
| `AGENTMUG_API_KEY` | Cloud subcommands (v0.2+) | (required for cloud calls) |
| `AGENTMUG_STATE_DIR` | Private local bindings and receipts | Platform app-state directory |

## Sister packages

- [`@agentmug/runtime`](https://npmjs.com/package/@agentmug/runtime) — the engine the CLI embeds
- [`@agentmug/mcp-bridge`](https://npmjs.com/package/@agentmug/mcp-bridge) — expose any AgentMug agent as a Model Context Protocol tool

## License

Apache-2.0. Existing versions published under MIT remain MIT.
