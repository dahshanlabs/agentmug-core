# @agentmug/cli

## 0.10.1

### Minor Changes

- 0f4886e: New CLI verbs for agents-as-code workflows: `agentmug validate <file>` checks a .agent file against the exact parser every runtime uses and warns on tools that don't exist on any surface (via the shipped capability matrix; `--strict` exits 2 on warnings for CI), and `agentmug push <file>` validates locally, previews the import (tools, connections, source rebinds, disabled schedules, private-knowledge consent), then imports to your account with an `am_user_` API key. The runtime package adds subpath exports for `schemas/agent.v1.json` and `capabilities/agent-capabilities.v1.json` so tooling can resolve both data files directly.
- d02fbd5: Add digest-pinned verified capability execution with explicit host trust and sandbox gates, plus stable run identity support for durable, reconnect-safe background execution. Portable CLI workflows preserve capability artifacts and fail closed until the local host can verify and isolate the exact artifact digest.

### Patch Changes

- Updated dependencies [103737f]
- Updated dependencies [ed5c141]
- Updated dependencies [0f4886e]
- Updated dependencies [3035ece]
- Updated dependencies [11a3b17]
- Updated dependencies [d02fbd5]
- Updated dependencies [a05a2ef]
  - @agentmug/runtime@0.18.0

## 0.9.2

### Patch Changes

- b77f824: Harden public runtime and CLI helpers identified by CodeQL: generate reminder IDs with cryptographic randomness, replace regex-based slugging with a bounded linear implementation, parse HTML without filtering regexes or repeated entity decoding, and assert provider routing by exact URL origin.
- Updated dependencies [b77f824]
  - @agentmug/runtime@0.16.1

## 0.9.1

### Patch Changes

- e513a6b: Replace the workspace-only runtime dependency with its public semver range so clean npm installs work outside the AgentMug monorepo. The release gate now rejects local-only dependency protocols in published dependency fields.

## 0.9.0

### Minor Changes

- 466d450: Execute portable declarative `.agent` checks in the runtime and preserve their evidence in the host's run receipt. Add secret-free hosted reliability status and explicit safe-simulation checks to the CLI and MCP bridge without exposing owner-private regression fixtures or claiming cloud checks cover locally modified files.

### Patch Changes

- Updated dependencies [466d450]
- Updated dependencies [466d450]
- Updated dependencies [466d450]
- Updated dependencies [466d450]
- Updated dependencies [466d450]
- Updated dependencies [466d450]
- Updated dependencies [466d450]
- Updated dependencies [466d450]
- Updated dependencies [466d450]
  - @agentmug/runtime@0.16.0
