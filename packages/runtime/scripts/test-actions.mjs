import { build } from "esbuild";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

for (const entry of [
  "src/actions/types.test.ts",
  "src/engine-actions.test.ts",
]) {
  const outfile = join(
    tmpdir(),
    `runtime-actions-${process.pid}-${entry.replace(/\W/g, "-")}.mjs`,
  );
  await build({
    entryPoints: [entry],
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
}
