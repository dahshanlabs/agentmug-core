import { build } from "esbuild";
import { execSync } from "node:child_process";
import { rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "neutral",
  format: "esm",
  target: "es2022",
  outfile: "dist/index.mjs",
  // Both are peer deps — never bundle them, let consumers de-dupe.
  external: ["@agentmug/runtime", "@opentelemetry/api"],
  treeShaking: true,
  sourcemap: "linked",
});

// Capture tsc's output and re-print it on failure: under `changeset publish`
// → npm lifecycle, an inherited stderr gets swallowed (CI run 27382808218
// failed here with zero diagnostic output). Piping + echoing guarantees the
// actual TS errors surface in the publish log.
try {
  execSync("tsc -p tsconfig.build.json", { stdio: "pipe" });
} catch (err) {
  if (err.stdout) console.error(String(err.stdout));
  if (err.stderr) console.error(String(err.stderr));
  throw err;
}

console.log("built dist/");
