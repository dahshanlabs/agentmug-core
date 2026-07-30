# Third-party software

AgentMug Core depends on third-party packages. Each dependency remains governed
by its own copyright notices and license terms.

The runtime keeps model-provider SDKs external so applications install and
deduplicate their declared dependencies normally. The CLI and MCP bridge use
single-file bundles for reliable command-line startup. Their builds generate
`dist/THIRD_PARTY_LICENSES.txt` from the exact esbuild input graph, and the npm
tarball gate refuses release if that inventory is missing.

The n8n community node treats `n8n-workflow` as a peer supplied by the user's
n8n installation; it is not bundled into AgentMug's distribution.

CI checks production dependency metadata and requires explicit review for
copyleft, source-available, non-commercial, or missing-license metadata before
release.
