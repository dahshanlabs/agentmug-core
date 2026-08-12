# The `.agent` File Format — Specification v1

**Status:** Stable
**Format version:** 1
**Media type:** `application/vnd.agentmug.agent+json` _(IANA registration pending)_
**File extension:** `.agent`
**Canonical schema:** <https://agentmug.com/schemas/agent.v1.json>
**Change controller:** Dahshan Labs (AgentMug)

---

## 1. Abstract

A `.agent` file is a portable, declarative definition of an AI agent. One JSON
document carries everything a runtime needs to execute the agent — its model,
its instructions, the tools it may use, the credentials it requires, the sources
it reads, how it delivers results, the checks that must pass before it deploys,
and the triggers that start it.

The file **is** the agent. The same file runs unmodified on a cloud platform, a
desktop application, a command-line runtime, or any third-party runtime
implementing this specification.

## 2. Design goals

| Goal                           | Consequence                                                                                           |
| ------------------------------ | ----------------------------------------------------------------------------------------------------- |
| **Portable**                   | No runtime-specific fields. A file authored anywhere runs anywhere.                                   |
| **Pure data**                  | Strictly JSON. No code, no executable content, no scripting hooks.                                    |
| **Secret-free**                | The file _declares_ what it needs; the runtime supplies it. Files are publishable as-is.              |
| **Requirements, not locators** | The file carries _what kind of thing_ the agent needs, never _which specific private thing_ — see §3. |
| **Self-contained**             | A runtime needs nothing but this file plus what it declares.                                          |
| **Forward-compatible**         | Unknown members are ignored and preserved, never rejected.                                            |
| **Fail loud, not silent**      | A runtime that cannot honour a declaration reports it rather than degrading quietly.                  |

## 3. The portability boundary

The single most important rule in this format:

> **A `.agent` file carries _requirements and role references_. It never carries
> _values, locators, or credentials_.**

This is what makes a file safe to publish and meaningful to fork. Concretely:

| Travels in the file                                                          | Stays in the host runtime                                     |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `SourceRequirement` — "I need a table with columns `invoice_id`, `due_date`" | `SourceBinding` — _which_ workbook, its path, its provider id |
| `connectivity.delivers: { to: "owner" }`                                     | The owner's actual phone number or address                    |
| `parameters[].artifact.structure` — sheet and column _names_                 | The rows, cell values, or document prose                      |
| `tools[].requiresUserAuth` + `scopes`                                        | The OAuth token                                               |
| `evaluation.checks` — declarative assertions                                 | Private test fixtures                                         |

A recipient can prove their workbook has the required _shape_ without ever
receiving the author's data. Identity references such as `to: "owner"` resolve
at run time against whoever is running the file.

Implementations MUST NOT serialize a `SourceBinding` into a `.agent` file.

## 4. Conformance

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHOULD**,
**SHOULD NOT**, and **MAY** are to be interpreted as described in
[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

A **producer** writes `.agent` files. A **consumer** (or **runtime**) reads and
may execute them.

## 5. Encoding

A single JSON document encoded in **UTF-8**, per
[RFC 8259](https://www.rfc-editor.org/rfc/rfc8259). The top-level value MUST be
a JSON object.

## 6. Top-level structure

| Member         | Type   | Req. | Description                                              |
| -------------- | ------ | :--: | -------------------------------------------------------- |
| `$schema`      | string |  ✅  | Canonical version marker. §7                             |
| `id`           | string |  ✅  | Stable identifier within the source instance.            |
| `name`         | string |  ✅  | Display name.                                            |
| `description`  | string |  ✅  | Short user-facing summary.                               |
| `version`      | string |  ✅  | Semver-style version of _this agent_, not of the format. |
| `exportedAt`   | string |  ✅  | ISO 8601 generation timestamp.                           |
| `blueprint`    | object |  ✅  | Model, prompt, tools, skills, caveats, guardrails. §8    |
| `inputs`       | object |  ✅  | Accepted input modalities. §11                           |
| `emoji`        | string |  —   | Single emoji avatar.                                     |
| `parameters`   | array  |  —   | User-supplied configuration. §10                         |
| `outputs`      | object |  —   | Declared output contract. §11                            |
| `triggers`     | array  |  —   | How the agent can be started. §12                        |
| `connectivity` | object |  —   | Connectivity contract. §13                               |
| `sources`      | array  |  —   | Portable source requirements. §14                        |
| `evaluation`   | object |  —   | Verify-before-deploy checks. §15                         |
| `metadata`     | object |  —   | Free-form provenance. §16                                |
| `brain`        | array  |  —   | **PRIVATE** structured knowledge. §17                    |
| `memory`       | array  |  —   | **PRIVATE** flat learned facts. §17                      |

Consumers MUST ignore members not defined here and SHOULD preserve them when
re-serialising.

## 7. Versioning (`$schema`)

`$schema` is the **canonical version marker** and is REQUIRED. Consumers MUST
validate it against the schema URLs they support **before** interpreting any
other member, and MUST reject an unrecognised value rather than attempting a
best-effort parse.

Two URLs are valid and denote the **identical** v1 format:

```
https://agentmug.com/schemas/agent.v1.json              ← current
https://agentlit.dahshanlabs.com/schemas/agent.v1.json  ← legacy alias
```

The legacy URL is retained because the project was renamed from _AgentLit_ to
_AgentMug_; files exported before the rename remain valid indefinitely.
Producers MUST emit the current URL; consumers SHOULD accept both.

A security-sensitive or otherwise incompatible format uses a **different**
`$schema` URL rather than redefining this one. In particular, executable
capability source is permitted only by
`https://agentmug.com/schemas/agent.v2.json`; a v1-only consumer rejects that
marker before reading any other field. See the
[agent v2 specification](https://agentmug.com/spec/agent-v2.md).

## 8. `blueprint`

| Member                   | Type     | Req. | Description                                                                                    |
| ------------------------ | -------- | :--: | ---------------------------------------------------------------------------------------------- |
| `primaryModel`           | string   |  ✅  | Model identifier, e.g. `claude-sonnet-4-6`.                                                    |
| `systemPrompt`           | string   |  ✅  | The full system prompt, verbatim.                                                              |
| `tools`                  | array    |  ✅  | Tools the agent may use. §9                                                                    |
| `maxTokens`              | number   |  —   | Per-agent output token cap. Omit for the runtime default. The runtime clamps to a sane range.  |
| `extendedThinkingBudget` | number   |  —   | Extended-thinking token budget. Omit = thinking off. Ignored on models without the capability. |
| `guardrails`             | object   |  —   | Per-agent guardrails; see §8.1.                                                                |
| `thinkingPatterns`       | string[] |  —   | Free-form hints, e.g. `react`, `chain_of_verification`.                                        |
| `architecture`           | string   |  —   | `solo`, `orchestrator_workers`, `pipeline`, `hierarchical`.                                    |
| `skills`                 | array    |  —   | Verified learned capabilities. §8.2                                                            |
| `caveats`                | array    |  —   | Public "Heads up" adaptations. §8.3                                                            |

A runtime that does not recognise `primaryModel` SHOULD refuse to run rather
than silently substituting a different model.

### 8.1 `blueprint.guardrails`

| Member           | Values                         | Meaning                                                      |
| ---------------- | ------------------------------ | ------------------------------------------------------------ |
| `sideEffectGate` | `off` \| `confirm` \| `refuse` | Opts the agent into the same-turn prompt-injection backstop. |

Guardrails travel with the file **by design**, so protection survives export,
fork, and off-cloud execution. A consumer that cannot enforce a declared
guardrail MUST report that rather than running unprotected. Additional
implementation-defined members are permitted and MUST be preserved.

### 8.2 `blueprint.skills`

A skill is a reusable procedure the agent learned and verified. Skills are
**procedures, not private data**, so they travel with shared and published files.

| Member     | Type    | Req. | Description                                                                             |
| ---------- | ------- | :--: | --------------------------------------------------------------------------------------- |
| `name`     | string  |  ✅  | Identifier the agent invokes.                                                           |
| `trigger`  | string  |  ✅  | When to use it, in plain language.                                                      |
| `recipe`   | string  |  ✅  | The replayable steps. **Plain text — never executable code.**                           |
| `verified` | boolean |  —   | Whether it passed verification before being kept.                                       |
| `proof`    | object  |  —   | Redacted provenance evidence. It is informational and never grants execution authority. |

Encoding executable content in `recipe`, `executable`, or any other v1 member
violates §2. A v1 parser MUST reject a recognized `executable` member rather
than silently preserving it. Producers that need to carry a digest-pinned
implementation MUST emit agent.v2 and place it in `capabilityCapsules`.

### 8.3 `blueprint.caveats`

A caveat is one adaptation the agent's designer made because the literal request
could not be honoured as written. Caveats are **display-only and never affect
execution**, and they are **public** — they travel in every export so the same
heads-up renders on every surface.

| Member      | Type   | Req. | Description                                                                       |
| ----------- | ------ | :--: | --------------------------------------------------------------------------------- |
| `requested` | string |  ✅  | What the user literally asked for, in their words.                                |
| `doing`     | string |  ✅  | What the agent does instead.                                                      |
| `why`       | string |  ✅  | One-line reason the literal ask was not possible.                                 |
| `options`   | array  |  —   | Alternative routes: `{ label, detail, recommended? }`. At most one `recommended`. |

Consumers SHOULD surface caveats **before** the user runs the agent. An absent
or empty array means the request was honoured exactly.

## 9. `blueprint.tools`

Two shapes are accepted:

- **Legacy** — a bare string, equivalent to `{ "kind": "builtin", "name": <string> }`
- **Current** — a structured tool-reference object

Consumers MUST accept both. Every reference has `kind` and a non-empty `name`.
`kind` MUST be `builtin`, `mcp`, `webhook`, or `nango`; a consumer encountering
an unknown `kind` MUST reject the file rather than skipping the tool, because
silently dropping a capability yields an agent that looks functional but cannot
do its job.

### 9.1 `builtin`

Executed natively by the runtime. No user credentials.

| Member        | Req. | Notes                               |
| ------------- | :--: | ----------------------------------- |
| `kind`        |  ✅  | `"builtin"`                         |
| `name`        |  ✅  | e.g. `create_reminder`, `fetch_url` |
| `description` |  —   |                                     |

### 9.2 `mcp`

Delegates to a Model Context Protocol server, so tokens stay with the user.

| Member             | Req. | Notes                                                   |
| ------------------ | :--: | ------------------------------------------------------- |
| `kind`             |  ✅  | `"mcp"`                                                 |
| `name`             |  ✅  | Name exposed to the model, e.g. `gmail.send`            |
| `server`           |  ✅  | npm package or URL of the MCP server                    |
| `requiresUserAuth` |  ✅  | If true, credentials MUST be resolved before invocation |
| `scopes`           |  —   | OAuth/permission scopes                                 |
| `provider`         |  —   | Credential provider key, e.g. `google`                  |
| `description`      |  —   |                                                         |

### 9.3 `webhook`

Calls an arbitrary HTTP endpoint.

| Member             | Req. | Notes                                |
| ------------------ | :--: | ------------------------------------ |
| `kind`             |  ✅  | `"webhook"`                          |
| `name`             |  ✅  |                                      |
| `url`              |  ✅  | Target URL                           |
| `method`           |  —   | `GET` \| `POST` \| `PUT` \| `DELETE` |
| `requiresUserAuth` |  —   |                                      |
| `description`      |  —   |                                      |

Consumers MUST apply SSRF protections to `url`. See §19.

### 9.4 `nango`

Proxied through a credential broker that injects the user's OAuth token at call
time, unlocking many APIs without per-provider runtime code. A provider works
only once the operator has configured that integration.

| Member             | Req. | Notes                                                          |
| ------------------ | :--: | -------------------------------------------------------------- |
| `kind`             |  ✅  | `"nango"`                                                      |
| `name`             |  ✅  | e.g. `outlook.list_messages`                                   |
| `provider`         |  ✅  | Integration key, e.g. `microsoft-outlook`                      |
| `endpoint`         |  ✅  | Path relative to the provider's API base                       |
| `requiresUserAuth` |  ✅  |                                                                |
| `method`           |  —   | `GET` \| `POST` \| `PUT` \| `PATCH` \| `DELETE`; default `GET` |
| `scopes`           |  —   |                                                                |
| `description`      |  —   |                                                                |

### 9.5 Derived credential requirements

A consumer SHOULD derive required credentials by walking `tools`, collecting
every `mcp` and `nango` tool with `requiresUserAuth: true`, and merging by
`provider` with the union of their `scopes`. This lets a runtime render a "this
agent needs access to X" screen without a central tool catalogue.

## 10. `parameters`

Parameters make an agent self-configuring **without code edits** — the reason a
non-developer can fork someone else's agent and use it. The agent declares the
configuration it needs; the runtime renders a form; values are substituted into
the system prompt before each run.

| Member        | Type                    | Req.  | Description                                                                                   |
| ------------- | ----------------------- | :---: | --------------------------------------------------------------------------------------------- |
| `name`        | string                  |  ✅   | Substitution id. MUST match `^[a-z][a-z0-9_]*$` (case-insensitive) and be unique in the file. |
| `label`       | string                  |  ✅   | Display label.                                                                                |
| `type`        | string                  |  ✅   | `string` \| `text` \| `number` \| `boolean` \| `email` \| `url` \| `select` \| `file`         |
| `required`    | boolean                 |  ✅   | If true, the runtime MUST NOT run until a non-empty value exists.                             |
| `options`     | array                   | cond. | REQUIRED and non-empty when `type` is `select`. Entries: `{ value, label }`.                  |
| `artifact`    | object                  | cond. | REQUIRED when `type` is `file`. §10.2                                                         |
| `description` | string                  |   —   |                                                                                               |
| `default`     | string\|number\|boolean |   —   | MUST NOT be present when `type` is `file`.                                                    |
| `placeholder` | string                  |   —   |                                                                                               |

### 10.1 Substitution

Before each run, the consumer replaces occurrences of

```
{{params.<name>}}
```

in `systemPrompt` with the corresponding value. Whitespace inside the braces is
permitted; matching on the name is case-insensitive.

**Unknown placeholders MUST be left in place, not removed.** Deleting them would
produce a prompt that reads as complete but is factually wrong; leaving them lets
the model observe and report the gap.

### 10.2 `parameters[].artifact` — portable file bindings

`type: "file"` declares that the agent needs a file of a particular _shape_. The
**schema travels; the owner's file and its stored value never do** (§3).

| Member      | Type     | Req. | Description                                                                        |
| ----------- | -------- | :--: | ---------------------------------------------------------------------------------- |
| `kind`      | string   |  ✅  | `document` \| `table` \| `image`                                                   |
| `accepts`   | string[] |  ✅  | Non-empty. Extensions (`.csv`) or MIME types (`text/csv`, `image/*`).              |
| `structure` | string[] |  —   | Workflow-relevant structural facts, e.g. `Sheet "Invoices": invoice_id, due_date`. |

`structure` MUST describe **shape only** — sheet names, column names, required
headings. It MUST NOT contain sample rows, cell values, document prose, or
filenames.

A consumer SHOULD offer a pre-run compatibility check that compares a candidate
file's `kind`, format, and structure against this contract and reports precisely
which structural items are missing — proving fitness without transmitting
content.

## 11. `inputs` and `outputs`

### 11.1 `inputs` (required)

| Member        | Type   | Req. | Description                                             |
| ------------- | ------ | :--: | ------------------------------------------------------- |
| `accepts`     | array  |  ✅  | Non-empty. Entries MUST be `text`, `audio`, or `image`. |
| `placeholder` | string |  —   | Placeholder text for the input UI.                      |
| `schema`      | object |  —   | JSON Schema for structured text input.                  |

A runtime SHOULD present controls matching the declared modalities. Producers
SHOULD derive `accepts` from the run model's real capability rather than
asserting a modality the model cannot honour — in particular, `image` SHOULD be
declared only when `primaryModel` is vision-capable.

### 11.2 `outputs` (optional)

| Member        | Type   | Req. | Description                                                           |
| ------------- | ------ | :--: | --------------------------------------------------------------------- |
| `shape`       | string |  ✅  | `text` \| `json` \| `void`. `void` = the agent acts and stays silent. |
| `schema`      | object |  —   | JSON Schema when `shape` is `json`.                                   |
| `description` | string |  —   | Plain-language description of what the user will see.                 |

Optional for backwards compatibility, but producers SHOULD always emit it so a
user knows what to expect before running an unfamiliar agent.

## 12. `triggers`

Declares how the agent may be started.

| `type`     | Members                                  | Meaning                             |
| ---------- | ---------------------------------------- | ----------------------------------- |
| `manual`   | —                                        | Started by a person.                |
| `schedule` | `cron` ✅, `prompt`, `timezone`, `label` | Started on a schedule.              |
| `webhook`  | `path` ✅                                | Started by an inbound HTTP request. |
| `api`      | `endpoint`                               | Started via an API call.            |

`schedule.prompt` declares **what** the agent should do when the schedule fires,
since a scheduled run has no typed user message; omitted, the runtime falls back
to a generic instruction. `timezone` is an IANA timezone the cron is evaluated
in; omitted, the host default applies.

**Parsing is deliberately lenient.** A trigger `type` a consumer does not
recognise MUST NOT cause a parse failure — an older runtime must still be able to
load a newer file. Instead, a runtime that cannot honour a declared trigger MUST
fail loudly at check or execution time.

**Security:** consumers MUST NOT activate non-`manual` triggers on import without
explicit user consent. See §19.

## 13. `connectivity`

The connectivity contract declares what the agent needs from the world in order
to actually work, beyond tool credentials: whose identity it messages, what it
reads, and how it delivers.

Entries are **requirements and role references only** — never secrets, never
literal phone numbers or addresses. `to: "owner"` means "whoever runs this file"
and resolves per-runtime against the importing user's own connected accounts.

| Member       | Type  | Entry shape                                     |
| ------------ | ----- | ----------------------------------------------- |
| `identities` | array | `{ role: "owner", channel: string }`            |
| `reads`      | array | `{ provider: string, resource: string }`        |
| `delivers`   | array | `{ channel: string, to: "owner", via: string }` |

`channel` is a transport (`whatsapp`, `sms`, `email`, …); `via` names the
delivery tool whose provider must be connected. Unknown channels and extra
members are preserved (forward-compatible).

A runtime that cannot satisfy an entry MUST fail loudly at check or run time,
never silently.

## 14. `sources`

Portable, secret-free declarations of the evidence and working surfaces the agent
needs, and what it may do with them. Optional, so every file authored before this
contract remains valid.

Each entry is a **`SourceRequirement`**:

| Member        | Type    | Req. | Description                                                                            |
| ------------- | ------- | :--: | -------------------------------------------------------------------------------------- |
| `id`          | string  |  ✅  | Portable role id referenced by prompts and evals, e.g. `invoice_workbook`.             |
| `label`       | string  |  ✅  | Display label.                                                                         |
| `role`        | string  |  ✅  | `knowledge` \| `brain` \| `working` \| `template` \| `inbox` \| `output`               |
| `kind`        | string  |  ✅  | `file` \| `folder` \| `workspace` \| `klypix` \| `provider`                            |
| `required`    | boolean |  ✅  | Whether the agent can run without it.                                                  |
| `access`      | object  |  ✅  | §14.1                                                                                  |
| `description` | string  |  —   |                                                                                        |
| `accepts`     | object  |  —   | `{ extensions?, mediaTypes?, providerTypes? }`                                         |
| `structure`   | object  |  —   | `{ required?: string[], optional?: string[], schema? }` — shape, never private values. |
| `freshness`   | object  |  —   | §14.2                                                                                  |
| `truth`       | object  |  —   | §14.3                                                                                  |
| `approval`    | object  |  —   | §14.4                                                                                  |
| `sharing`     | object  |  —   | §14.5                                                                                  |

A source requirement declares at most **30** entries per agent. `id` MUST match
`^[a-z][a-z0-9._-]{0,79}$` and be unique within the file.

The private counterpart — a `SourceBinding` naming the actual path, provider
item, or credential reference — lives **only** in the host runtime and MUST NOT
appear in a `.agent` file (§3).

**`SourceRequirement` is a CLOSED schema.** Unlike every other object in this
format, a consumer MUST **reject** any member not listed above rather than
ignoring it. This is a privacy mechanism, not pedantry: ignoring unknown keys
would let a misplaced `SourceBinding` field — `locator`, `credentialRef`,
`adapterId`, `path`, `url`, `revision`, `displayName`, and similar — survive
parsing and then travel onward when the file is shared. Consumers SHOULD report
such members with a distinct "runtime-private field" diagnostic so producers
learn what leaked. The same closed-schema rule applies to the nested `accepts`,
`structure`, `freshness`, `truth`, `access`, `approval`, and `sharing` objects.

### 14.1 `access` (required)

| Member         | Type     | Req. | Description                                                                                                               |
| -------------- | -------- | :--: | ------------------------------------------------------------------------------------------------------------------------- |
| `capabilities` | string[] |  ✅  | From: `read`, `list`, `search`, `cite`, `sync`, `watch`, `write`, `append`, `create`, `delete`, `version`.                |
| `boundaries`   | string[] |  —   | Portable write boundaries, e.g. `Sheet "Summary": B2:H40`, `folder: /Drafts`. Declarative policy, never private locators. |

Declare the operations the agent _needs_, not everything the account can do. A
host MUST prove all declared capabilities before reporting the source ready.

### 14.2 `freshness`

| Member          | Values                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| `mode` ✅       | `snapshot` (bound revision is sufficient) \| `on-run` (refresh each run) \| `watch` (stay synchronized) |
| `maxAgeSeconds` | Maximum acceptable age.                                                                                 |
| `onStale` ✅    | `fail` \| `warn`                                                                                        |

### 14.3 `truth`

| Member              | Values                                                        |
| ------------------- | ------------------------------------------------------------- |
| `authority` ✅      | `authoritative` \| `supporting` \| `reference` \| `example`   |
| `priority`          | 0–100; higher wins under authority-based conflict resolution. |
| `conflictPolicy` ✅ | `fail` \| `ask` \| `prefer-authority` \| `prefer-newer`       |
| `citations` ✅      | `required` \| `preferred` \| `none`                           |

### 14.4 `approval`

| Member           | Values                                                       |
| ---------------- | ------------------------------------------------------------ |
| `read` / `write` | `not-required` \| `on-bind` \| `every-run` \| `every-action` |
| `destructive`    | `forbidden` \| `every-action`                                |

Delete and overwrite MUST either be forbidden or individually approved.

### 14.5 `sharing`

| Member                 | Values                                                                                                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `strategy` ✅          | `rebind` (recipient selects their own equivalent — the safe default) \| `exclude` (private to the owner) \| `snapshot` (a separately approved, sanitized snapshot may be packaged) |
| `derivedKnowledge`     | `exclude` \| `approved-only` \| `include`                                                                                                                                          |
| `recipientMayOverride` | boolean                                                                                                                                                                            |

This member is **policy only**. Source bytes and identifiers never live here
regardless of its value.

### 14.6 Coherence rules

A source requirement must be internally consistent. A consumer MUST reject a
file violating any of these — each exists so a declared intent cannot outrun the
access actually requested:

| Rule                                                                                                        | Rationale                                                          |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `role: "output"` MUST include a write capability (`write`, `append`, `create`, or `delete`)                 | An output source that cannot write is a broken promise.            |
| `freshness.mode: "on-run"` MUST include the `sync` capability                                               | Refreshing before each run _is_ syncing.                           |
| `freshness.mode: "watch"` MUST include the `watch` capability                                               | Same, for continuous synchronization.                              |
| `truth.citations: "required"` MUST include the `cite` capability                                            | Citations cannot be required from a source the agent may not cite. |
| Any write capability MUST be accompanied by an explicit `approval.write`                                    | Write authority is never implicit.                                 |
| The `delete` capability MUST have `approval.destructive: "every-action"`                                    | Deletion is always individually approved.                          |
| `accepts`, when present, MUST declare at least one non-empty `extensions`, `mediaTypes`, or `providerTypes` | An empty accept contract accepts nothing.                          |
| `access.capabilities` MUST be non-empty, drawn from the enumerated set, with no duplicates                  |                                                                    |
| `freshness.maxAgeSeconds`, when present, MUST be a positive finite number                                   |                                                                    |
| `truth.priority`, when present, MUST be 0–100                                                               |                                                                    |

### 14.7 Structure matching

`structure.required` entries are human-readable but matched with field
boundaries. An entry of the form `<qualifier>: <item>, <item>` matches a
candidate only when the qualifier is equal and **every** required item is
present among the candidate's comma-separated items. Comparison is
case-insensitive and Unicode-normalised (NFKC), with whitespace collapsed.

A candidate MAY expose additional items beyond those required. A similarly named
item MUST NOT satisfy a requirement — `discount_amount` does not satisfy a
requirement for `amount`.

## 15. `evaluation`

A declarative verify-before-deploy contract. Private test fixtures stay in the
host; only safe, declarative checks travel.

| Member          | Type   | Req. | Description                             |
| --------------- | ------ | :--: | --------------------------------------- |
| `version`       | number |  ✅  | `1`                                     |
| `failurePolicy` | string |  ✅  | `block` \| `require-approval` \| `warn` |
| `checks`        | array  |  ✅  | §15.1                                   |
| `minimumScore`  | number |  —   | Aggregate threshold, 0–1.               |

### 15.1 `evaluation.checks[]`

| Member        | Type     | Req. | Description                                                                                                   |
| ------------- | -------- | :--: | ------------------------------------------------------------------------------------------------------------- |
| `id`          | string   |  ✅  |                                                                                                               |
| `name`        | string   |  ✅  |                                                                                                               |
| `type`        | string   |  ✅  | `source-ready` \| `freshness` \| `citation` \| `output-schema` \| `write-boundary` \| `invariant` \| `custom` |
| `phase`       | string   |  ✅  | `bind` \| `pre-run` \| `post-run`                                                                             |
| `severity`    | string   |  ✅  | `error` \| `warning`                                                                                          |
| `sourceIds`   | string[] |  —   | MUST reference declared `sources[].id` values.                                                                |
| `assertion`   | string   |  —   | Declarative assertion. **Never executable code.** REQUIRED when `type` is `custom` or `invariant`.            |
| `description` | string   |  —   |                                                                                                               |
| `config`      | object   |  —   |                                                                                                               |

Additionally: `checks` MUST be non-empty; `id` values MUST be unique within the
contract; and every entry of `sourceIds` MUST reference an `id` declared in
`sources` (§14). A check that names a source the agent never declared would
silently never run.

## 16. `metadata`

Free-form provenance. Not consumed during execution.

| Member         | Type     | Description                                                           |
| -------------- | -------- | --------------------------------------------------------------------- |
| `sourceUrl`    | string   | Where the agent came from.                                            |
| `sourceUserId` | string   | Authoring user in the source instance.                                |
| `tags`         | string[] | Marketplace/classification tags.                                      |
| `pricing`      | object   | `{ "kind": "free" }` or `{ "kind": "one-time", "amountUsd": number }` |

`sourceUserId` and `sourceUrl` may identify a person or organisation.

## 17. `brain` and `memory` — private members

Two members carry the agent's accumulated private knowledge.

**`brain`** — structured pages about the owner's world:

| Member             | Type     | Req. |
| ------------------ | -------- | :--: |
| `title`            | string   |  ✅  |
| `content`          | string   |  ✅  |
| `slug`, `summary`  | string   |  —   |
| `links`, `sources` | string[] |  —   |

**`memory`** — flat learned facts:

| Member       | Type   | Req. |
| ------------ | ------ | :--: |
| `key`        | string |  ✅  |
| `value`      | string |  ✅  |
| `importance` | number |  —   |

**Both members are PRIVATE.** They MUST be present only in an owner-initiated
personal export and MUST NOT appear in a shared, published, or marketplace file.
Producers implementing export MUST make inclusion an explicit, opt-in choice by
the owner, so that publishing cannot leak private knowledge by construction.

Files containing either member are sensitive personal data and SHOULD be
transmitted and stored only over confidential channels.

Contrast with `blueprint.skills` (§8.2) and `blueprint.caveats` (§8.3), which are
public and always travel.

## 18. Validation rules

A conforming consumer MUST reject a document if any of the following hold.

**Document and identity**

1. The top-level value is not a JSON object.
2. `$schema` is absent, not a string, or not a recognised schema URL.
3. Any of `id`, `name`, `description`, `version`, `exportedAt` is absent, not a
   string, or empty.
4. `emoji` is present and is not a string.

**Blueprint and tools** 5. `blueprint` is absent or not an object. 6. `blueprint.primaryModel` or `blueprint.systemPrompt` is not a string, or
`blueprint.tools` is not an array. 7. Any entry of `blueprint.tools` is an empty string, or is neither a string nor
an object. 8. Any tool object has a `kind` outside `builtin`/`mcp`/`webhook`/`nango`, or
lacks a non-empty `name`. 9. A `nango` tool lacks a non-empty `provider` or `endpoint`. 10. `blueprint.skills` is present and not an array, or any skill lacks a non-empty
`name`, or lacks a string `trigger` or `recipe`. 11. `blueprint.caveats` is present and not an array, or any caveat lacks a string
`requested`, `doing`, or `why`.

**Inputs and outputs** 12. `inputs.accepts` is absent, not an array, or empty. 13. Any entry of `inputs.accepts` is outside `text`/`audio`/`image`. 14. `outputs` is present and not an object, or `outputs.shape` is outside
`text`/`json`/`void`.

**Parameters** 15. `parameters` is present and not an array, or any parameter is not an object. 16. A parameter lacks a non-empty `name`, has a `name` failing
`^[a-z][a-z0-9_]*$`, duplicates another parameter's `name`, lacks a non-empty
`label`, has a `type` outside the permitted set, or lacks a boolean
`required`. 17. `type: "select"` without a non-empty `options` array. 18. `type: "file"` without an `artifact` object; or with an `artifact.kind`
outside `document`/`table`/`image`; or without a non-empty `artifact.accepts`
array of non-blank strings; or with `artifact.structure` present that is not
an array of strings; or carrying a `default`.

**Triggers, connectivity, contracts** 19. `triggers` is present and not an array, or any trigger lacks a non-empty
string `type`; a `schedule` trigger lacks a string `cron`; a `webhook`
trigger lacks a string `path`. _(An unrecognised trigger `type` is NOT a
parse error — see §12.)_ 20. `connectivity` is present and is not a non-array object; or a `delivers`
entry lacks string `channel` or `via`; or a `reads` entry lacks string
`provider` or `resource`; or an `identities` entry lacks a string `channel`. 21. `sources` is present and fails source-requirement validation — including a
malformed or duplicate `id`, more than 30 entries, an **undeclared member**
on a requirement or any of its nested contract objects (§14, closed schema),
an invalid enum value, or any coherence rule in §14.6. 22. `evaluation` is present and fails evaluation-contract validation — including
`version` other than `1`, an invalid `failurePolicy`, a `minimumScore`
outside 0–1, an empty `checks` array, a duplicate check `id`, an invalid
`type`/`phase`/`severity`, a `custom` or `invariant` check without an
`assertion`, or a `sourceId` not declared in `sources`.

**Private members** 23. `memory` is present and not an array, or any fact lacks a non-empty string
`key` or a string `value`. 24. `brain` is present and not an array, or any page lacks a non-empty `title` or
a string `content`.

The reference implementation is `parseAgentFile()` in
[`packages/runtime/src/format/agent-file.ts`](packages/runtime/src/format/agent-file.ts).

## 19. Security considerations

A v1 `.agent` file contains no executable code, so parsing it is inherently
safe. This statement does not apply to agent.v2 capability capsules; those are
untrusted executable content and follow the quarantine rules in
[the agent v2 specification](https://agentmug.com/spec/agent-v2.md).
The risk lies entirely in what a runtime **does** with the declaration.

**Consumers MUST treat any `.agent` file from an untrusted source as untrusted
input, and MUST NOT execute it without explicit, informed user consent.**

1. **Instruction injection.** `blueprint.systemPrompt` is natural-language text
   handed to a model as its governing instructions. A hostile file can direct the
   agent to exfiltrate data reachable through its tools, misrepresent its
   identity, or take destructive actions. This cannot be mitigated by validation
   alone; it requires human review and runtime policy. `blueprint.guardrails`
   (§8.1) exists for this reason and SHOULD be honoured.

2. **Capability declaration and remote code.** `tools` may name an arbitrary npm
   package or URL as an MCP `server`, an arbitrary `url` for a webhook, or an
   arbitrary provider `endpoint`. Runtimes MUST present all declared tools,
   servers, endpoints, and URLs for approval before first execution; MUST apply
   SSRF protections to outbound targets — rejecting loopback, link-local, and
   private ranges, validating **after** DNS resolution; and SHOULD run tool
   servers with least privilege.

3. **Credential solicitation.** `requiresUserAuth` with `provider` and `scopes`
   causes a runtime to prompt for real third-party credentials. A hostile file
   can request excessive or misleading scopes as a phishing vector. Runtimes MUST
   display the provider and exact scopes, and SHOULD warn on scopes not justified
   by the declared tools.

4. **Write and delete authority.** `sources[].access.capabilities` may request
   `write`, `append`, `create`, or `delete` over the user's own documents.
   Runtimes MUST NOT grant these implicitly on import; destructive operations
   MUST be either forbidden or individually approved (§14.4), and declared
   `boundaries` MUST be enforced rather than merely displayed.

5. **Unattended execution.** `triggers` of type `schedule`, `webhook`, or `api`
   can run the agent with no human present. Runtimes MUST NOT activate
   non-`manual` triggers on import without explicit consent, and MUST NOT
   auto-execute a file merely because it was opened or double-clicked.

6. **Private data.** `brain` and `memory` (§17) carry sensitive personal
   knowledge and ride only owner-initiated personal exports. Producers MUST make
   their inclusion opt-in. Consumers SHOULD warn before onward sharing of a file
   containing them.

7. **Structural disclosure.** `parameters[].artifact.structure`,
   `sources[].structure`, and `sources[].access.boundaries` describe shape rather
   than content, but sheet, column, and folder names can themselves be sensitive.
   Producers SHOULD review them before publishing a file.

8. **Secrets.** The format is designed never to carry credentials, but nothing
   prevents a user hand-editing a secret into `systemPrompt` or a parameter
   default. Consumers SHOULD NOT assume a file is secret-free and SHOULD avoid
   logging its contents verbatim.

9. **Resource exhaustion.** `maxTokens` and `extendedThinkingBudget` are
   author-supplied and carry cost implications. Runtimes MUST clamp them to
   locally acceptable ranges rather than honouring arbitrary values.

10. **Parser hardening.** Consumers SHOULD enforce limits on document size and
    nesting depth, and MUST validate `$schema` before interpreting any other
    member.

The format employs no signatures or encryption; integrity and authenticity must
be provided by the transport or distribution channel.

## 20. Forward compatibility

- Consumers MUST ignore unrecognised members rather than failing.
- Consumers SHOULD preserve unrecognised members when re-serialising, so a file
  round-tripped through an older runtime does not lose data written by a newer
  producer.
- Unrecognised trigger types are tolerated at parse time and fail at execution
  (§12).
- New OPTIONAL members MAY be added to format v1. New REQUIRED members, removed
  members, or changed member semantics require a new `$schema` URL.
- Executable content is not an ordinary optional member. It changes the trust
  boundary and therefore requires agent.v2 even when a consumer could ignore it.

## 21. Example

```json
{
  "$schema": "https://agentmug.com/schemas/agent.v1.json",
  "id": "agent_invoice_chaser_01",
  "name": "Invoice Chaser",
  "description": "Reads the overdue-invoice workbook each morning and messages the owner a chase list.",
  "emoji": "📄",
  "version": "1.2.0",
  "exportedAt": "2026-07-30T06:00:00Z",
  "blueprint": {
    "primaryModel": "claude-sonnet-4-6",
    "maxTokens": 8192,
    "guardrails": { "sideEffectGate": "confirm" },
    "systemPrompt": "You chase overdue invoices for {{params.company_name}}. Read the workbook, list what is overdue, and message the owner.",
    "tools": [
      "create_reminder",
      {
        "kind": "nango",
        "name": "outlook.list_messages",
        "provider": "microsoft-outlook",
        "endpoint": "/me/messages",
        "method": "GET",
        "scopes": ["Mail.Read"],
        "requiresUserAuth": true
      }
    ],
    "skills": [
      {
        "name": "chase_overdue",
        "trigger": "when the user asks to chase overdue items",
        "recipe": "1. List invoices past due_date. 2. Group by customer. 3. Draft one summary per customer.",
        "verified": true
      }
    ],
    "caveats": [
      {
        "requested": "Send the chase emails automatically",
        "doing": "Drafting them and messaging you for approval first",
        "why": "Sending on your behalf needs a verified sender you have not connected yet.",
        "options": [
          {
            "label": "Connect a verified sender",
            "detail": "Enables true auto-send.",
            "recommended": true
          },
          {
            "label": "Keep approval step",
            "detail": "Safer; one tap per batch."
          }
        ]
      }
    ]
  },
  "parameters": [
    {
      "name": "company_name",
      "label": "Company name",
      "type": "string",
      "required": true
    },
    {
      "name": "invoice_workbook",
      "label": "Invoice workbook",
      "type": "file",
      "required": true,
      "artifact": {
        "kind": "table",
        "accepts": [".xlsx", ".csv"],
        "structure": [
          "Sheet \"Invoices\": invoice_id, customer, due_date, amount"
        ]
      }
    }
  ],
  "inputs": { "accepts": ["text", "audio"] },
  "outputs": {
    "shape": "text",
    "description": "A chase list grouped by customer."
  },
  "triggers": [
    { "type": "manual" },
    {
      "type": "schedule",
      "cron": "0 7 * * 1-5",
      "timezone": "Asia/Riyadh",
      "label": "Weekday morning chase",
      "prompt": "Chase everything overdue as of today."
    }
  ],
  "connectivity": {
    "identities": [{ "role": "owner", "channel": "whatsapp" }],
    "reads": [{ "provider": "microsoft-outlook", "resource": "inbox" }],
    "delivers": [
      { "channel": "whatsapp", "to": "owner", "via": "whatsapp.send" }
    ]
  },
  "sources": [
    {
      "id": "invoice_workbook",
      "label": "Invoice workbook",
      "role": "working",
      "kind": "file",
      "required": true,
      "accepts": { "extensions": [".xlsx", ".csv"] },
      "structure": { "required": ["Sheet \"Invoices\": invoice_id, due_date"] },
      "freshness": { "mode": "on-run", "onStale": "fail" },
      "truth": {
        "authority": "authoritative",
        "conflictPolicy": "prefer-authority",
        "citations": "required"
      },
      "access": { "capabilities": ["read", "cite", "sync"] },
      "approval": { "read": "on-bind", "destructive": "forbidden" },
      "sharing": { "strategy": "rebind", "derivedKnowledge": "exclude" }
    }
  ],
  "evaluation": {
    "version": 1,
    "failurePolicy": "block",
    "checks": [
      {
        "id": "wb_ready",
        "name": "Workbook bound and readable",
        "type": "source-ready",
        "phase": "pre-run",
        "severity": "error",
        "sourceIds": ["invoice_workbook"]
      },
      {
        "id": "cited",
        "name": "Every claim cites the workbook",
        "type": "citation",
        "phase": "post-run",
        "severity": "error",
        "sourceIds": ["invoice_workbook"]
      }
    ]
  },
  "metadata": { "tags": ["finance", "invoices"], "pricing": { "kind": "free" } }
}
```

## 22. Filenames

Producers SHOULD name downloaded files using a slug of the agent's `name`
followed by a short prefix of its `id`, with the `.agent` extension — for example
`invoice-chaser-a1b2c3d4.agent`. This keeps filenames readable while avoiding
collisions between forks of the same agent.

## 23. Reference implementation

| Component                      | Path                                                                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Types, parser, writer, helpers | [`packages/runtime/src/format/agent-file.ts`](packages/runtime/src/format/agent-file.ts)                                   |
| Source & evaluation contracts  | [`packages/runtime/src/sources/types.ts`](packages/runtime/src/sources/types.ts)                                           |
| Trigger definitions            | [`packages/runtime/src/triggers/types.ts`](packages/runtime/src/triggers/types.ts)                                         |
| v1 JSON Schema                 | [canonical v1 JSON Schema](https://agentmug.com/schemas/agent.v1.json)                     |
| v2 JSON Schema                 | [canonical v2 JSON Schema](https://agentmug.com/schemas/agent.v2.json)                     |
| Execution engine               | [`packages/runtime/src/engine.ts`](packages/runtime/src/engine.ts)                                                         |
| Export endpoint                | `GET /api/agents/:agentId/export` — [hosted API documentation](https://agentmug.com/docs) |
| Import                         | [hosted API documentation](https://agentmug.com/docs)                       |

Producers SHOULD write files through `buildAgentFile()`, which stamps `$schema`
and `exportedAt`, drops `undefined` optionals, and validates by round-tripping
through `parseAgentFile()` — so it can only emit a file the runtime can read back.

## 24. License and change control

This specification is published by **Dahshan Labs** under the terms in
[LICENSE](LICENSE). The format is open: any party MAY implement a producer or
consumer without permission or fee.
