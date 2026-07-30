# Changesets

Add a changeset for every user-visible change to a published package:

```sh
pnpm changeset
```

Choose the affected package and semantic-version impact. Documentation-only,
test-only, and repository-maintenance changes do not require a changeset unless
they alter a published artifact.

Core changesets may target only `@agentmug/runtime`, `@agentmug/cli`,
`@agentmug/mcp-bridge`, and `@agentmug/otel`. The n8n integration uses
`.github/workflows/release-n8n.yml` and must not enter this Changesets lane.
