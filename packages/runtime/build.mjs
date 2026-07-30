// Build the runtime for npm publishing.
//
// - esbuild bundles the JS into a single ESM file (dist/index.mjs)
//   with the heavy SDKs marked external so consumers de-dupe on
//   their own copies of @anthropic-ai/sdk, @google/genai, openai.
// - tsc emits .d.ts files alongside so consumers get full type
//   autocomplete.
//
// Single-file JS bundle + per-module .d.ts is the trade-off we
// pick: bundling loses module-level tree-shaking, but the runtime
// is small enough (~100KB pre-deps) that this doesn't matter, and
// it dodges the .js-extension-on-import headache that ESM
// publishing usually triggers.

import { build } from "esbuild";
import { execSync } from "node:child_process";
import { rm } from "node:fs/promises";

const externals = [
  "@anthropic-ai/sdk",
  "@google/genai",
  "openai",
  "@modelcontextprotocol/sdk",
];

await rm("dist", { recursive: true, force: true });

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "neutral",
  format: "esm",
  target: "es2022",
  outfile: "dist/index.mjs",
  external: externals,
  treeShaking: true,
  sourcemap: "linked",
  legalComments: "external",
});

// Emit .d.ts via tsc so consumers get full IntelliSense + type
// checking when they import { runAgent, ... } from "@agentmug/runtime".
execSync("tsc -p tsconfig.build.json", { stdio: "inherit" });

console.log("built dist/");
