# @agentmug/runtime

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
