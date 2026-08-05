# @agentmug/cli

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
