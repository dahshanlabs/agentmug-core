# AgentMug Core

**Portable AI workers that run on your models, your credentials, and your
infrastructure.**

A worker packages its job, tools, knowledge requirements, permissions,
schedules, and runtime behavior into a portable `.agent` file. Run the same
worker locally, through the CLI, from an MCP host, or on AgentMug Cloud. When a
worker is shared, each owner binds their own accounts and sources rather than
inheriting the creator's private credentials.

AgentMug Core contains the Apache-2.0 `.agent` format, runtime, command-line
tools, interoperability bridges, observability adapter, and reference
examples. The `n8n-nodes-agentmug` subpackage is MIT to satisfy n8n's verified
community-node contract. The local runtime is designed around explicit
adapters so model credentials and persistence can remain under the operator's
control.

> **Terminology.** _Worker_ is the product concept; **`.agent`** is the portable
> technical format. This repository's APIs, schemas, and package names keep
> `agent` where it is technically accurate. Both refer to the same thing.
>
> **Host parity is partial.** The engine, format, streaming, and pause/resume
> behave the same everywhere, but each host supplies its own tool executors, so
> tool catalogs differ. A tool that is not registered on a host returns an
> `Unknown tool` result for that call and the run continues.

> **Status:** pre-1.0. The public interfaces are usable but may evolve with
> adoption. This repository is open and auditable; it is not a claim that every
> component has completed an independent security audit.
>
> **License transition:** earlier `@agentmug/*` npm versions remain MIT. Check
> [OPEN_SOURCE.md](OPEN_SOURCE.md) and each package's release notes for the
> first Apache-2.0 version; this repository does not retroactively change older
> tarballs. `n8n-nodes-agentmug` remains MIT.

## Quick start

```sh
npm install @agentmug/runtime
```

```ts
import { parseAgentFile, quickRun } from "@agentmug/runtime";
import { readFile } from "node:fs/promises";

const agentFile = parseAgentFile(
  JSON.parse(await readFile("./hello.agent", "utf8")),
);

await quickRun({
  agentFile,
  userInput: "Say hello in three languages.",
  llm: { anthropicApiKey: process.env.ANTHROPIC_API_KEY! },
  onEvent: (event) =>
    event.type === "token" && process.stdout.write(event.content),
});
```

See [`examples/`](examples/) and the
[`@agentmug/runtime` documentation](packages/runtime/README.md) for complete
usage.

The versioned JSON Schema is [`spec/agent.v1.json`](spec/agent.v1.json).

## Repository map

- `packages/runtime` — portable execution engine and `.agent` parser
- `packages/cli` — local runner and supported hosted-service commands
- `packages/mcp-bridge` — expose an agent through Model Context Protocol
- `packages/otel` — OpenTelemetry tracing adapter
- `integrations/n8n-nodes-agentmug` — n8n community node
- `examples` — small runnable reference projects and `.agent` files

## Open-core boundary

This repository is the functional public core. AgentMug's hosted frontend, API
implementation, blueprint intelligence, managed connectivity and delivery,
always-on cloud workers, hosted marketplace operations, billing, enterprise
administration, infrastructure, and user data are separate proprietary
services. See [OPEN_SOURCE.md](OPEN_SOURCE.md).

Apache-2.0 for the core and MIT for `n8n-nodes-agentmug` grant broad rights to
use, modify, and distribute their covered code. Neither grants rights to the
AgentMug name, Mughead character, logos, official binaries, or service
identity. See [TRADEMARKS.md](TRADEMARKS.md).

## Trust and security

- Report vulnerabilities privately through [SECURITY.md](SECURITY.md).
- Every release is expected to pass typechecking, tests, dependency and license
  audits, public-tree inspection, and npm-tarball inspection.
- npm releases require explicit founder enablement plus GitHub OIDC trusted
  publishing. The workflow verifies the exact registry tarballs, generates a
  package-specific SPDX SBOM for each, and records GitHub attestations.
- Never place production credentials in `.agent` files or source control.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md),
[GOVERNANCE.md](GOVERNANCE.md), and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Contributions use the receiving
component's license—Apache-2.0 for the core, MIT for
`n8n-nodes-agentmug`—and a Developer Certificate of Origin sign-off.

## License

Copyright 2025–2026 Dahshan Labs.

The repository core is licensed under the [Apache License 2.0](LICENSE).
`integrations/n8n-nodes-agentmug` is licensed separately under its
[MIT License](integrations/n8n-nodes-agentmug/LICENSE).
