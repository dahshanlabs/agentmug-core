---
"@agentmug/runtime": patch
"@agentmug/cli": patch
---

Harden public runtime and CLI helpers identified by CodeQL: generate reminder IDs with cryptographic randomness, replace regex-based slugging with a bounded linear implementation, parse HTML without filtering regexes or repeated entity decoding, and assert provider routing by exact URL origin.
