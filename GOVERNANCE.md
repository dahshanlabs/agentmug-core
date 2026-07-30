# AgentMug Core governance

AgentMug Core is an open-source project stewarded by Dahshan Labs. Governance
is intentionally lightweight while the project is early, but public interfaces
must remain predictable and reviewable.

## Roles

- **Contributors** propose code, documentation, tests, issues, and design input.
- **Maintainers** review changes, enforce the security and compatibility gates,
  manage releases, and make final repository decisions.
- **Dahshan Labs** owns the AgentMug product and trademarks. That ownership does
  not change recipients' Apache-2.0 rights in the public core.

Current maintainers are listed through repository permissions and `CODEOWNERS`.
No person becomes a maintainer solely through employment, sponsorship, or the
size of a contribution.

## Decisions

Routine fixes and additive features use normal pull-request review. The
following require a public design issue before implementation:

- a new or breaking `.agent` schema version;
- removal or reinterpretation of a public runtime API;
- a new required network or hosted-service dependency;
- changes to the license, contribution terms, or governance model; and
- security-model changes with ecosystem-wide effects.

Maintainers document the decision, compatibility impact, rejected alternatives,
and migration path. Consensus is preferred; Dahshan Labs is the final
decision-maker while it remains the primary steward.

## Releases

Published packages follow semantic versioning within their pre-1.0 maturity.
Changesets record user-visible changes. Releases must pass CI, dependency and
license audits, public-tree inspection, tarball inspection, and provenance
attestation.

## Security and conduct

Security reports follow [SECURITY.md](SECURITY.md). Community behavior follows
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

This governance document does not create a foundation, membership interest,
partnership, employment relationship, or entitlement to the AgentMug
trademarks or hosted services.
