// Runs the portable net-guard SSRF-classifier tests
// (src/tools/builtin-executors/net-guard.test.ts) by bundling with esbuild and
// importing the output. The test file exits non-zero on failure.
//
//   pnpm --filter @agentmug/runtime run test:net-guard

import { build } from "esbuild";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { rm } from "node:fs/promises";

const outfile = join(tmpdir(), `net-guard-test-${process.pid}.mjs`);

await build({
  entryPoints: ["src/tools/builtin-executors/net-guard.test.ts"],
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
