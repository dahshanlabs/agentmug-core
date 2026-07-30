# Public release gates

This is the operational gate for the first public AgentMug Core release. The
four `@agentmug/*` core packages are Apache-2.0;
`n8n-nodes-agentmug` is MIT for n8n community-node compatibility.

Gate A is the pre-launch gate: every item must be checked before npm
publication. Gate B is a post-publish closeout gate whose evidence cannot exist
until immutable registry artifacts exist. Do not misreport Gate B as a
precondition.

## Gate A — Pre-launch

### A1. Ownership and disclosure

- [ ] Founder employment/IP obligations reviewed.
- [ ] Founder, employee, and contractor assignments confirmed.
- [ ] Third-party source, fonts, icons, fixtures, and notices reviewed.
- [ ] Potentially patentable technical disclosures reviewed before publication.
- [ ] AgentMug trademark search completed and filing decision recorded.

### A2. Boundary

- [ ] The explicit private export allowlist and every destination mapping are
      reviewed against the approved public-source boundary.
- [ ] Hosted frontend, API implementation, blueprint intelligence, billing,
      managed connectivity, verified delivery operations, infrastructure, and
      user data are absent.
- [ ] Community Desktop scope is described as a future neutral-branded client;
      the current branded application is not exported.
- [ ] Public SDK contains only supported customer-facing API contracts.
- [ ] The four core package manifests declare Apache-2.0, while the n8n package
      and its package-level `LICENSE` declare MIT.

### A3. Deterministic engineering evidence

- [ ] Export runs from a clean private commit; uncommitted and untracked changes
      are rejected before the staging directory is touched.
- [ ] `pnpm run public-core:stage` succeeds from that clean checkout.
- [ ] The exported `pnpm-lock.yaml` is copied byte-for-byte from the reviewed
      private source commit; export performs no registry resolution.
- [ ] `.agentmug-public-export` records only the exact private source commit and
      SHA-256 of `PUBLIC_CORE_MANIFEST.json`; it contains no branch, remote,
      private path, timestamp, or Git history.
- [ ] The receipt source commit and manifest SHA-256 match the exact source and
      staged tree reviewed by the founder.
- [ ] The staged repository contains no `.git` directory or private history.
- [ ] Public-tree secret, personal-data, symlink, path-containment, and package
      checks pass.
- [ ] Typechecks, tests, builds, production dependency audits, and the license
      audit pass in the staged repository; locked build-only dependencies are
      reviewed separately and never run with publication credentials.
- [ ] `npm pack --dry-run` passes for every package; each tarball contains the
      correct package license, required notices, README, and only intended
      build output.
- [ ] Public workflows are configured to generate SBOMs, artifact attestations,
      exact registry-integrity evidence, and package-specific SPDX attestations.

### A4. GitHub and npm controls

- [ ] Fresh public repository created from the staged directory, never by
      changing the private monorepo's visibility.
- [ ] The staged `CODEOWNERS` bootstrap owner is augmented with at least one
      independent, eligible maintainer on every rule before launch.
- [ ] The protected `main` ruleset requires pull requests, passing release and
      security checks, and an independent CODEOWNER approval; stale approvals
      are dismissed, the last pusher cannot approve, and administrator or
      repository-role bypass is disabled.
- [ ] Tag rulesets protect `@agentmug/*@*` and `n8n-v*`: release tags may be
      created only by the approved release automation or release role, must
      resolve to the reviewed protected-`main` commit, and cannot be updated,
      force-updated, or deleted.
- [ ] GitHub immutable releases are enabled before the first release is
      published; release assets and tags cannot be replaced after publication.
- [ ] The `npm-production` environment requires independent approval, prevents
      self-review, permits only protected release refs, and exposes no reusable
      npm credential. The separately protected `npm-bootstrap` environment is
      enabled only for the one-time n8n first publish.
- [ ] Default workflow permissions are read-only; only the reviewed release
      jobs receive narrowly scoped write or OIDC permissions, and every
      third-party action is pinned to a full commit SHA.
- [ ] Secret scanning, private vulnerability reporting, dependency review, and
      push protection are enabled.
- [ ] npm Trusted Publisher updated for the four existing `@agentmug/*`
      packages to `dahshanlabs/agentmug-core` and
      `.github/workflows/release.yml`.
- [ ] Founder controls npm 2FA and approves the exact protected-`main` commit
      and one-time bootstrap procedure for `n8n-nodes-agentmug`; npm requires
      the package to exist before Trusted Publisher configuration is possible.
      After the exact registry bytes and evidence verify, the workflow creates
      the protected `n8n-v0.1.0` tag and immutable GitHub release.
- [ ] No long-lived npm write token is stored in GitHub.
- [ ] Repository variable `AGENTMUG_RELEASE_ENABLED` remains unset/false until
      the exact launch is approved, then is enabled deliberately.
- [ ] Public package manifests use `publishConfig.provenance: true`.
- [ ] First public versions and release notes approved; historical registry
      versions and their license metadata remain untouched.

### A5. Human launch approval

- [ ] Founder approves the exact source commit, staged manifest SHA-256, and
      private-to-public diff.
- [ ] Counsel approves ownership, third-party notices, trademark policy, and
      private-cloud terms.
- [ ] One functional demo and one clear request for design partners are ready.
- [ ] Founder authorizes the one-time launch after A1–A5 are complete.

## Launch boundary

Only after Gate A passes: publish the four core packages through the protected
OIDC workflow, and bootstrap `n8n-nodes-agentmug` once from the exact approved
protected-`main` commit with founder npm 2FA. The workflow verifies the registry
artifact before creating its protected tag and immutable release. Then complete
Gate B immediately.

## Gate B — Post-publish closeout

- [ ] Exact npm registry tarballs match registry integrity and recorded
      checksums for every published version.
- [ ] Registry metadata reports Apache-2.0 for the four core packages and MIT
      for `n8n-nodes-agentmug`.
- [ ] GitHub artifact provenance and package-specific SPDX SBOM attestations
      verify against the exact published artifacts.
- [ ] GitHub release evidence records versions, checksums, SBOMs, attestations,
      source commit, and reviewed manifest SHA-256.
- [ ] Functional install/run smoke tests pass from the registry packages.
- [ ] Trusted Publisher is enabled for n8n immediately after its bootstrap
      publish; no reusable publication credential remains.
- [ ] `AGENTMUG_RELEASE_ENABLED` is disabled again if publication should pause.
- [ ] Any failed closeout item is recorded and remediated with a new version;
      an immutable npm version is never overwritten.
