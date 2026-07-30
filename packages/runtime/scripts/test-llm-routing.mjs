// Runs the multi-provider routing + fetch-injection tests
// (src/adapters/llm-multi.test.ts) by bundling with esbuild and importing the
// output. The test file exits non-zero on failure.
//
//   pnpm --filter @agentmug/runtime run test:llm-routing

import { build } from "esbuild";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { rm } from "node:fs/promises";

const outfile = join(tmpdir(), `llm-routing-test-${process.pid}.mjs`);

await build({
  entryPoints: ["src/adapters/llm-multi.test.ts"],
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
