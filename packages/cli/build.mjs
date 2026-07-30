import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { writeBundleNotices } from "../../scripts/write-bundle-notices.mjs";

await mkdir("dist", { recursive: true });

const result = await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "dist/index.mjs",
  banner: { js: "#!/usr/bin/env node" },
  // Keep these external — they have native deps or dynamic requires
  // that don't play well with single-file bundles.
  external: ["@anthropic-ai/sdk", "exceljs", "mammoth"],
  legalComments: "external",
  metafile: true,
});

await writeBundleNotices({
  metafile: result.metafile,
  output: "dist/THIRD_PARTY_LICENSES.txt",
});

console.log("built dist/index.mjs");
