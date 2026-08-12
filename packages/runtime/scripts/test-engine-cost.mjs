import { build } from "esbuild";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Bundle the TypeScript test exactly like the runtime action tests. Plain
// Node's type stripping does not resolve the runtime's extensionless ESM
// source imports, while the production build does.
const outfile = join(tmpdir(), `runtime-engine-cost-${process.pid}.mjs`);
await build({
  entryPoints: ["src/engine-cost.test.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile,
  logLevel: "warning",
});
try {
  await import(pathToFileURL(outfile).href);
} finally {
  await rm(outfile, { force: true }).catch(() => {});
}
