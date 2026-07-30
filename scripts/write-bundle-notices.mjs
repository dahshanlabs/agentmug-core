import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function exists(target) {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function findDependencyPackage(input, workingDirectory) {
  const absoluteInput = path.resolve(workingDirectory, input);
  if (
    !absoluteInput
      .toLowerCase()
      .includes(`${path.sep}node_modules${path.sep}`.toLowerCase())
  ) {
    return undefined;
  }

  let directory = path.dirname(absoluteInput);
  const filesystemRoot = path.parse(directory).root;

  while (directory !== filesystemRoot) {
    const manifestPath = path.join(directory, "package.json");
    if (await exists(manifestPath)) {
      try {
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        if (manifest.name && manifest.version) {
          return { directory, manifest };
        }
      } catch {
        // A nested non-package package.json is not the dependency root.
      }
    }
    directory = path.dirname(directory);
  }

  return undefined;
}

async function readLicenseFiles(packageDirectory) {
  const entries = await readdir(packageDirectory, { withFileTypes: true });
  const candidates = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        /^(?:licen[cs]e|copying|notice)(?:\.[^.]+)?$/i.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort();

  const files = [];
  for (const candidate of candidates) {
    files.push({
      name: candidate,
      content: (await readFile(path.join(packageDirectory, candidate), "utf8"))
        .replace(/\s+$/u, ""),
    });
  }
  return files;
}

async function readReviewedOverride(key, declaredLicense) {
  const configPath = path.join(
    repositoryRoot,
    "config",
    "bundle-license-overrides.json",
  );
  if (!(await exists(configPath))) return undefined;

  const config = JSON.parse(await readFile(configPath, "utf8"));
  if (config.schemaVersion !== 1 || typeof config.overrides !== "object") {
    throw new Error(`Invalid bundle license override config: ${configPath}`);
  }

  const override = config.overrides[key];
  if (!override) return undefined;
  if (
    typeof override.license !== "string" ||
    typeof override.file !== "string" ||
    typeof override.source !== "string" ||
    !/^[a-f0-9]{64}$/u.test(override.sha256 || "")
  ) {
    throw new Error(`Invalid reviewed license override for ${key}.`);
  }
  if (declaredLicense !== override.license) {
    throw new Error(
      `Reviewed override for ${key} expects ${override.license}, but the package declares ${declaredLicense}.`,
    );
  }

  const absoluteFile = path.resolve(repositoryRoot, override.file);
  const relativeFile = path.relative(repositoryRoot, absoluteFile);
  if (
    relativeFile.startsWith("..") ||
    path.isAbsolute(relativeFile) ||
    !relativeFile.startsWith(`LICENSES${path.sep}third-party${path.sep}`)
  ) {
    throw new Error(
      `Reviewed override for ${key} must stay under LICENSES/third-party.`,
    );
  }

  const content = (await readFile(absoluteFile, "utf8"))
    .replace(/\r\n?/gu, "\n")
    .replace(/\s+$/u, "");
  const digest = createHash("sha256")
    .update(content + "\n", "utf8")
    .digest("hex");
  if (digest !== override.sha256) {
    throw new Error(
      `Reviewed override checksum mismatch for ${key}: expected ${override.sha256}, got ${digest}.`,
    );
  }

  return {
    name: `reviewed override: ${override.file}`,
    content,
    source: override.source,
  };
}

export async function writeBundleNotices({
  metafile,
  output,
  workingDirectory = process.cwd(),
}) {
  const packages = new Map();

  for (const input of Object.keys(metafile.inputs || {})) {
    const dependency = await findDependencyPackage(input, workingDirectory);
    if (!dependency) continue;

    const key = `${dependency.manifest.name}@${dependency.manifest.version}`;
    if (!packages.has(key)) packages.set(key, dependency);
  }

  const sections = [];
  const missingLicenses = [];
  for (const key of [...packages.keys()].sort()) {
    const dependency = packages.get(key);
    const declaredLicense =
      typeof dependency.manifest.license === "string"
        ? dependency.manifest.license
        : "see included files";
    let licenseFiles = await readLicenseFiles(dependency.directory);
    if (licenseFiles.length === 0) {
      const reviewedOverride = await readReviewedOverride(key, declaredLicense);
      if (!reviewedOverride) {
        missingLicenses.push(key);
        continue;
      }
      licenseFiles = [reviewedOverride];
    }

    const body = licenseFiles
      .map(
        (file) =>
          `--- ${file.name} ---\n${file.source ? `Reviewed upstream: ${file.source}\n\n` : ""}${file.content}`,
      )
      .join("\n\n");

    sections.push(`${key} (${declaredLicense})\n\n${body}`);
  }

  if (missingLicenses.length > 0) {
    throw new Error(
      `Bundled dependencies without discoverable LICENSE/COPYING/NOTICE files or reviewed overrides:\n- ${missingLicenses.join("\n- ")}`,
    );
  }

  const content = [
    "AgentMug bundled third-party licenses",
    "",
    "This file is generated from the exact dependency inputs included by esbuild.",
    "Each dependency remains governed by its own terms.",
    "",
    ...sections.flatMap((section, index) => [
      index === 0 ? "=".repeat(72) : `\n${"=".repeat(72)}`,
      section,
    ]),
    "",
  ].join("\n");

  await writeFile(output, content, "utf8");
  console.log(
    `wrote ${output} (${packages.size} bundled third-party packages)`,
  );
}
