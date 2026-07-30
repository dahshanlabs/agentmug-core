# AgentMug open-core boundary

AgentMug is moving to an open-core distribution model.

## Public package licenses

The planned Apache-2.0 core contains:

- the versioned portable `.agent` specification, JSON Schema, parser,
  validator, conformance fixtures, and compatibility policy;
- `@agentmug/runtime`
- `@agentmug/cli`
- `@agentmug/mcp-bridge`
- `@agentmug/otel`
- reference examples and supported public SDKs.

The same public repository includes `n8n-nodes-agentmug` under the MIT License
to satisfy n8n's verified community-node contract. Its package-level `LICENSE`
controls that subpackage; it is not relicensed to Apache-2.0.

Local scheduling and trigger planning belong in the public runtime. The hosted
always-on scheduler and its operations remain part of the private service.
Marketplace and Agent Card protocols may be public; hosted ranking, curation,
transactions, and moderation remain private.

A neutral-branded, functional community Desktop client is planned after its
source boundary, network behavior, assets, and security posture are reviewed.
The current branded Desktop application is not included in the first export.
The official AgentMug distribution may add protected branding, signed binaries,
official update channels, support, and hosted-service integrations.

The public repository is created from an explicit, security-reviewed private
export allowlist. It must be a fresh repository with no private history. The
public repository becomes the canonical source for the exported packages;
private AgentMug products consume released core packages rather than
maintaining a second public implementation.

## Existing MIT releases

Earlier `@agentmug/*` versions published under MIT remain available under MIT.
Those rights cannot and should not be withdrawn. Their package changelogs and
release notes must identify the first Apache-2.0 version.
`n8n-nodes-agentmug` remains MIT in current and future releases.

## Private cloud product

The hosted frontend, API implementation, blueprint intelligence, private
prompts and evaluation logic, billing, managed OAuth and connectivity,
verified-delivery operations, hosted marketplace, enterprise administration,
infrastructure, and user data are not part of the public core.

Before any private monorepo source is shared externally, counsel should replace
the historical root license with terms that reflect this boundary and confirm
that Dahshan Labs owns all relevant intellectual property.

## Trademarks

Apache-2.0 licenses the core code and MIT licenses the n8n subpackage. Neither
licenses the AgentMug name, Mughead character, logos, domains, or other Dahshan
Labs brand assets.

See [TRADEMARKS.md](TRADEMARKS.md) for the public usage policy.

## Release status

Earlier `@agentmug/*` npm versions remain MIT. Their Apache conversion is
prepared but is not public until the fresh-repository audit and
[PUBLIC_RELEASE.md](PUBLIC_RELEASE.md) pre-launch gate are complete. The n8n
subpackage remains MIT throughout.
