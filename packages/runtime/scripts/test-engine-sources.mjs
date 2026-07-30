import { build } from "esbuild";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const outfile = join(tmpdir(), `engine-sources-test-${process.pid}.mjs`);

await build({
  entryPoints: ["src/engine-sources.test.ts"],
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
