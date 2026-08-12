# The `.agent` File Format — Specification v2

**Status:** Initial stable release
**Format version:** 2
**Media type:** `application/vnd.agentmug.agent+json`
**File extension:** `.agent`
**Canonical schema:** <https://agentmug.com/schemas/agent.v2.json>
**Change controller:** Dahshan Labs (AgentMug)

---

## 1. Scope

Version 2 is a deliberately narrow security-boundary release. It inherits every
field and meaning from [the v1 specification](https://agentmug.com/spec/agent-v1.md), and adds one required
top-level member: `capabilityCapsules`.

A capsule may contain executable source. That makes v2 incompatible with v1's
pure-data guarantee and is why it uses a new `$schema` marker instead of an
optional v1 field.

## 2. Version negotiation

A v2 file MUST contain exactly:

```json
{ "$schema": "https://agentmug.com/schemas/agent.v2.json" }
```

Consumers MUST inspect `$schema` before any other member.

- A consumer that supports v2 MAY parse the file.
- A v1-only consumer MUST reject it clearly as an unsupported format.
- A consumer MUST NOT reinterpret a v2 file as v1, remove the marker, or run it
  in a best-effort compatibility mode.
- A producer MUST emit v1 when no executable capsule is present. It MUST emit
  v2 when one or more executable capsules are present.

This rule prevents an old host from silently ignoring code while presenting the
worker as fully portable or verified.

## 3. `capabilityCapsules`

`capabilityCapsules` is a REQUIRED non-empty array with at most 60 items. Each
item has this closed shape:

| Member     | Type   | Required | Meaning                                                     |
| ---------- | ------ | :------: | ----------------------------------------------------------- |
| `version`  | `1`    |    ✅    | Capsule wire version.                                       |
| `name`     | string |    ✅    | Exact matching `blueprint.skills[].name`.                   |
| `proof`    | object |    ✅    | Redacted reusable-input proof bound to the artifact digest. |
| `artifact` | object |    ✅    | Digest-pinned deterministic Python transform.               |

The corresponding blueprint skill MUST exist, MUST be marked `verified: true`,
and remains the human-reviewable recipe. Source MUST NOT be embedded under
`blueprint.skills[]`.

### 3.1 Proof

The proof is version 2 of the v1 proof attestation. It MUST:

- report `status: "passed"` and `contractMatched: true`;
- report equal positive `criteriaPassed` and `criteriaTotal`;
- contain `reusableInputVerified: true`;
- contain `artifactDigest` in `sha256:<64 lowercase hex>` form; and
- contain only redacted provenance. Fixtures, example inputs, expected outputs,
  captured customer data, and secrets MUST NOT travel.

### 3.2 Artifact

The initial artifact kind is `portable_python_v1`:

```json
{
  "version": 1,
  "kind": "portable_python_v1",
  "language": "python",
  "entrypoint": "run",
  "policy": "deterministic-transform-v1",
  "source": "def run(payload):\n    return payload",
  "digest": "sha256:…",
  "contract": {
    "inputSchema": {},
    "outputSchema": {}
  },
  "permissions": {
    "network": false,
    "secrets": [],
    "filesystemWrites": false
  }
}
```

The digest covers the canonical version, kind, language, entrypoint, policy,
source, contract, and permissions. The proof's `artifactDigest` MUST equal the
artifact's `digest`.

The policy forbids network access, process execution, dynamic code evaluation,
secret/environment access, filesystem access, object-introspection escapes, and
imports outside the documented deterministic standard-library allowlist.

## 4. Evidence is not authority

A capsule can prove integrity and describe prior verification. It cannot grant
itself permission to execute.

Every receiving host MUST treat every capsule as **quarantined**, regardless of
its proof, export signature, marketplace origin, `verified` boolean, or file
location. No capsule field represents activation or trust.

Before execution, the receiving host MUST independently:

1. parse the closed capsule shape and policy;
2. recompute and compare the artifact digest;
3. establish trust from host-owned state, never from the file;
4. validate the current payload against `inputSchema`;
5. run in an isolated, no-network sandbox with no secrets or filesystem writes;
6. validate the result against `outputSchema`; and
7. record a local execution receipt.

If any step is unavailable or fails, the host MUST block execution and surface
the missing requirement. It MUST NOT fall back to host Python, a shell, an LLM
simulation, or the plain-text recipe while claiming the capability ran.

## 5. Import and sharing

Importing a v2 file MUST NOT mint local trust.

AgentMug's cloud import keeps the reviewable skill recipe as unverified, removes
the source runtime's trusted skill index, and does not persist or activate the
capsule source. The user may rebuild and verify that capability in the receiving
workspace.

A share/export producer MAY include a capsule only when:

- the recipe is verified in the source workspace;
- reusable-input proof is present;
- proof and artifact digests match; and
- privacy redaction would leave the source bytes unchanged.

If redaction would modify source, the producer MUST omit the capsule rather than
rewrite code under an old digest. The code-free recipe may still travel in v1.

## 6. Host behavior

| Host                        | v1                                     | v2                                                                                |
| --------------------------- | -------------------------------------- | --------------------------------------------------------------------------------- |
| Pre-v2 runtime              | Runs supported declarations            | Rejects by unknown `$schema`                                                      |
| Current CLI/Desktop         | Runs v1                                | Loads for review; capsule is blocked until local verification and sandbox support |
| Certified runner            | Runs v1                                | Readiness fails while capsule trust/sandbox is unavailable                        |
| AgentMug cloud import       | Imports recipes                        | Imports recipes as unverified; capsule code stays quarantined/discarded           |
| Trusted cloud control plane | Runs local verified blueprint evidence | May emit v2 deployment artifacts; trust still comes from durable host proof rows  |

## 7. Compatibility and release rules

- Existing v1 bytes, schema URLs, parsers, exports, and security meaning remain
  unchanged.
- `blueprint.skills[].executable` is invalid in both versions.
- An exporter should produce v2 only for workers that actually need a portable
  executable capsule; ordinary workers remain v1.
- Removing all capsules from a v2 worker permits a code-free v1 export.
- Future executable languages, permission profiles, or trust semantics require a
  new capsule version and may require a new `.agent` format version if an old
  v2 consumer could misinterpret them.
