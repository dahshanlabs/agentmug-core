---
"@agentmug/cli": patch
---

Replace the workspace-only runtime dependency with its public semver range so clean npm installs work outside the AgentMug monorepo. The release gate now rejects local-only dependency protocols in published dependency fields.
