import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkPublicPackageLicenses } from "./check-public-package-licenses.mjs";

const policies = [
  ["@agentmug/runtime", "Apache-2.0"],
  ["@agentmug/cli", "Apache-2.0"],
  ["@agentmug/mcp-bridge", "Apache-2.0"],
  ["@agentmug/otel", "Apache-2.0"],
  ["n8n-nodes-agentmug", "MIT"],
];

async function writePackage(root, index, name, license) {
  const directory = path.join(root, `package-${index}`);
  await mkdir(directory, { recursive: true });
  const isN8n = name === "n8n-nodes-agentmug";
  await writeFile(
    path.join(directory, "package.json"),
    `${JSON.stringify(
      {
        name,
        version: "1.0.0",
        license,
        files: [isN8n ? "LICENSE" : "NOTICE"],
        scripts: isN8n
          ? {}
          : {
              prepack: "prepare-license",
              postpack: "clean-license",
            },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return directory;
}

test("license gate enforces Apache core and MIT n8n as separate policies", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentmug-license-gate-"));
  context.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const directories = [];
  for (let index = 0; index < policies.length; index += 1) {
    const [name, license] = policies[index];
    directories.push(await writePackage(root, index, name, license));
  }

  const result = await checkPublicPackageLicenses(root);
  assert.equal(result.summary, "4 Apache-2.0, 1 MIT");

  const n8nDirectory = directories.at(-1);
  await writeFile(
    path.join(n8nDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "n8n-nodes-agentmug",
        version: "1.0.0",
        license: "Apache-2.0",
        files: ["LICENSE"],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await assert.rejects(
    checkPublicPackageLicenses(root),
    /n8n-nodes-agentmug: expected MIT/,
  );
});
