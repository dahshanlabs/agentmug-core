# Contributing to AgentMug Core

Thank you for helping make portable agents safer and easier to run.

## Scope

The public core accepts changes to the `.agent` specification, runtime, CLI,
MCP bridge, OpenTelemetry adapter, n8n node, examples, and conformance tooling.
The hosted AgentMug control plane is developed separately.

Before starting a large change, open an issue describing the user problem,
proposed public API, compatibility impact, and alternatives considered. Security
reports must follow [SECURITY.md](SECURITY.md), not a public issue.

## Development

Requirements:

- Node.js 22
- pnpm 10, using the version pinned in `package.json`

Run the release gates before opening a pull request:

```sh
pnpm install --frozen-lockfile
pnpm run verify
```

The n8n community node uses its own npm lockfile:

```sh
cd integrations/n8n-nodes-agentmug
npm ci --ignore-scripts
npm run build
npm pack --dry-run
```

Never commit credentials, customer information, production exports, private
keys, `.env` files, or proprietary AgentMug cloud source.

## Compatibility

- Additive changes are preferred.
- Breaking runtime or CLI changes require a changeset and migration notes.
- Breaking `.agent` format changes require a versioned schema, conformance
  fixtures, and an upgrade path. Do not silently reinterpret an existing field.
- Unknown future format fields should remain forward-compatible where safe.

## Licensing and sign-off

Contributions are licensed to recipients under Apache-2.0, the same license as
the project. By contributing, you confirm that you have the right to submit the
work and agree to the [Developer Certificate of Origin 1.1](https://developercertificate.org/).

Sign every commit:

```sh
git commit --signoff
```

The sign-off certifies the origin of the contribution; it is not a copyright
assignment. If an employer may own your work, obtain permission before
contributing.

AI-assisted contributions are welcome, but the contributor remains responsible
for correctness, security, provenance, licensing, and review. Do not submit
generated material copied from an unknown or incompatible source.

## Pull-request checklist

- Tests cover the behavior and failure path.
- Documentation and examples match the implementation.
- A changeset is included when a published package changes.
- No secret, personal-data, dependency-license, or private-boundary violations
  are introduced.
- Commits include `Signed-off-by`.
