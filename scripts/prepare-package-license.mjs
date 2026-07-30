import { copyFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const clean = process.argv.includes("--clean");
const packageDirectory = process.cwd();
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const files = [
  ["LICENSES/Apache-2.0.txt", "LICENSE"],
  ["LICENSES/AgentMug-Core-NOTICE.txt", "NOTICE"],
];

for (const [source, destination] of files) {
  const target = path.join(packageDirectory, destination);
  if (clean) {
    await rm(target, { force: true });
  } else {
    await copyFile(path.join(repositoryRoot, source), target);
  }
}
