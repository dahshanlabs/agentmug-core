// Build the mcp-bridge CLI as a single-file ESM bundle with a
// #!/usr/bin/env node shebang. esbuild bundles the MCP SDK in so
// the published package needs no install step beyond `npx`.

import { build } from "esbuild";
import { mkdir, chmod } from "node:fs/promises";
import { writeBundleNotices } from "../../scripts/write-bundle-notices.mjs";

await mkdir("dist", { recursive: true });

const result = await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  outfile: "dist/index.mjs",
  banner: { js: "#!/usr/bin/env node" },
  // MCP SDK is small and tree-shakes cleanly — bundle it in so
  // `npx -y @agentmug/mcp-bridge` doesn't need a second resolve pass.
  legalComments: "external",
  metafile: true,
});

// Make the output executable so the bin entry works after a global
// install (and on Linux/macOS where npx checks the +x bit).
await chmod("dist/index.mjs", 0o755);

await writeBundleNotices({
  metafile: result.metafile,
  output: "dist/THIRD_PARTY_LICENSES.txt",
});

console.log("built dist/index.mjs");
