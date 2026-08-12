# @agentmug/runtime

## 0.18.0

### Minor Changes

- a05a2ef: Expose durable provider-call cost receipts, usage-quality metadata, reasoning-effort controls, and compatible-endpoint helpers so hosts can route tenant-selected models, recover interrupted runs, and attribute billing without treating estimated usage as exact.
- ed5c141: The generated capability matrix (agent-capabilities.v1.json — every tool × surface × auth requirement, derived from the live cloud/runtime registries and guarded against drift in CI) now ships inside the npm package under `capabilities/` and is published at https://agentmug.com/schemas/agent-capabilities.v1.json. External authors and coding agents can check which tools actually run on which surface before generating a .agent file. Includes an honesty fix: shell.execute is now marked NOT cloud-available (its cloud registration is a refusal stub that points to desktop).
- 3035ece: The published .agent JSON Schema (agent.v1.json) now ships inside the npm package under `schemas/`, and a new schema↔parser drift test guards it against `parseAgentFile()` in CI. External authors — including coding agents — can validate files against the exact schema the runtime enforces, offline, at the version they installed. Fixes six published-schema drift bugs: `modelPolicy`, `execution`, `outcomeContract`/`capabilityPlan` were missing entirely; `connectivity.identities`/`delivers` over-required `role`/`to`; `select` parameters didn't require `options`; skill library pins didn't require both `librarySkillId` and `librarySkillVersion`.
- d02fbd5: Add digest-pinned verified capability execution with explicit host trust and sandbox gates, plus stable run identity support for durable, reconnect-safe background execution. Portable CLI workflows preserve capability artifacts and fail closed until the local host can verify and isolate the exact artifact digest.

### Patch Changes

- 103737f: The official worker-authoring skill (skills/agentmug-worker-author/SKILL.md) ships in the npm package and is published at https://agentmug.com/skills/agentmug-worker-author.md — a drop-in skill for Claude Code, Cursor, or any coding agent covering buildAgentFile() authoring, the capability-matrix check, the caveat honesty contract, the no-private-data rule, and the validate→push loop.
- 0f4886e: New CLI verbs for agents-as-code workflows: `agentmug validate <file>` checks a .agent file against the exact parser every runtime uses and warns on tools that don't exist on any surface (via the shipped capability matrix; `--strict` exits 2 on warnings for CI), and `agentmug push <file>` validates locally, previews the import (tools, connections, source rebinds, disabled schedules, private-knowledge consent), then imports to your account with an `am_user_` API key. The runtime package adds subpath exports for `schemas/agent.v1.json` and `capabilities/agent-capabilities.v1.json` so tooling can resolve both data files directly.
- 11a3b17: Treat capability requests as required pending proof obligations instead of completed side effects, and add the portable bounded `list_reminders` tool contract used by owner-scoped cloud reminder reads.

### Security contract

- Keep `agent.v1` permanently code-free. Executable reusable capabilities now
  travel only in explicit `agent.v2` `capabilityCapsules`; pre-v2 hosts reject
  the schema marker, and current hosts quarantine capsules until host-owned
  digest trust plus an isolated no-network sandbox are present. Imports never
  mint trust from file-controlled proof.

## 0.16.1

### Patch Changes

- b77f824: Harden public runtime and CLI helpers identified by CodeQL: generate reminder IDs with cryptographic randomness, replace regex-based slugging with a bounded linear implementation, parse HTML without filtering regexes or repeated entity decoding, and assert provider routing by exact URL origin.

## 0.16.0

### Minor Changes

- 466d450: Export the portable `request_capability` host contract so authenticated workers can suggest an owner-reviewed capability build without starting code generation or mutating the worker.
- 466d450: Execute portable declarative `.agent` checks in the runtime and preserve their evidence in the host's run receipt. Add secret-free hosted reliability status and explicit safe-simulation checks to the CLI and MCP bridge without exposing owner-private regression fixtures or claiming cloud checks cover locally modified files.
- 466d450: Add portable action receipts, proof requirements, and run-outcome aggregation so provider acceptance is not reported as verified success.
- 466d450: Add first-class Moonshot Kimi K3 routing, token metering, reasoning parameters, and preserved reasoning content across multi-turn tool calls.
- 466d450: Carry provider-neutral model policy, typed outcome contracts, and capability proof plans in portable `.agent` files so Cloud, Desktop, CLI, self-hosted, BYO, and local-model hosts preserve the worker's promised outcome and execution requirements.
- 466d450: Add a versioned portable capability-proof attestation contract with canonical validation and privacy-safe projection for `.agent` skills.
- 466d450: Add a portable multimodal input shape so one conversation turn can carry
  multiple bounded images alongside text or extracted document content.

### Patch Changes

- 466d450: Normalize type-less tool schema nodes before sending tools to Moonshot/Kimi models.
- 466d450: Normalize strict Gemini tool schemas and preserve function names when replaying native Gemini tool results.
