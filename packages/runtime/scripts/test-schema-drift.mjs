import { build } from "esbuild";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outfile = join(tmpdir(), `schema-drift-test-${process.pid}.mjs`);

// The bundle runs from tmpdir, so hand it an absolute path to the schema.
process.env.AGENT_SCHEMA_PATH = resolve(here, "../schemas/agent.v1.json");
process.env.AGENT_SCHEMA_V2_PATH = resolve(here, "../schemas/agent.v2.json");

await build({
  entryPoints: [resolve(here, "../src/format/schema-drift.test.ts")],
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
