# Security Policy

## Supported versions

AgentMug is under active pre-1.0 development. Security fixes are applied to the
latest cloud deployment, the latest desktop release, and the latest published
versions of the `@agentmug/*` packages. Older releases may not receive patches.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability.

Report it privately to `abdullah@dahshanlabs.com` with:

- the affected component and version;
- reproduction steps or a proof of concept;
- the expected and observed behavior;
- the practical impact; and
- any suggested mitigation.

Do not include real user data, credentials, or secrets. Use synthetic test data
and stop testing if you gain access to data that is not yours.

We will acknowledge a report within two business days, provide a triage update
within five business days, and coordinate disclosure after a fix is available.

## Security expectations

Every pull request is expected to pass:

- production dependency auditing at moderate severity or above;
- production dependency license review;
- release-critical typechecking and regression tests; and
- production builds.

Credentials must never be committed. Production secrets belong in the
deployment platform or operating-system credential store, not source files.
