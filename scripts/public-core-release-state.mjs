import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

const releaseTypes = new Set(["patch", "minor", "major"]);
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

async function pathExists(target) {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

function parseReleaseLine(line, location) {
  const match = line.match(
    /^\s*(?:"([^"]+)"|'([^']+)'|([^'":\s][^:]*?))\s*:\s*(patch|minor|major)\s*$/,
  );
  if (!match) {
    throw new Error(
      `${location}: invalid Changesets release entry ${JSON.stringify(line)}`,
    );
  }

  return {
    name: (match[1] || match[2] || match[3]).trim(),
    type: match[4],
  };
}

export function parseChangeset(content, filename = "changeset.md") {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  if (lines[0] !== "---") {
    throw new Error(`${filename}: Changesets frontmatter must start with ---`);
  }

  const closingIndex = lines.indexOf("---", 1);
  if (closingIndex < 0) {
    throw new Error(`${filename}: Changesets frontmatter is not closed`);
  }

  const releases = new Map();
  for (let index = 1; index < closingIndex; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    const release = parseReleaseLine(line, `${filename}:${index + 1}`);
    if (!release.name || !releaseTypes.has(release.type)) {
      throw new Error(`${filename}:${index + 1}: invalid package release`);
    }
    if (releases.has(release.name)) {
      throw new Error(
        `${filename}: duplicate release entry for ${release.name}`,
      );
    }
    releases.set(release.name, release.type);
  }

  if (releases.size === 0) {
    throw new Error(
      `${filename}: Changesets frontmatter has no package releases`,
    );
  }

  return {
    filename,
    releases,
    summary: lines
      .slice(closingIndex + 1)
      .join("\n")
      .trim(),
  };
}

export function parseReleasePolicy(content, location = "release policy") {
  let policy;
  try {
    policy = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `${location}: invalid public-core release policy (${error.message})`,
    );
  }

  if (
    policy.schemaVersion !== 1 ||
    typeof policy.initialLicenseChangeset !== "string" ||
    path.basename(policy.initialLicenseChangeset) !==
      policy.initialLicenseChangeset ||
    !policy.initialLicenseChangeset.endsWith(".md") ||
    !policy.releasePackages ||
    typeof policy.releasePackages !== "object" ||
    Array.isArray(policy.releasePackages) ||
    Object.keys(policy.releasePackages).length === 0
  ) {
    throw new Error(`${location}: invalid public-core release policy`);
  }

  for (const [packageName, entry] of Object.entries(policy.releasePackages)) {
    if (
      !packageName ||
      typeof entry?.directory !== "string" ||
      path.isAbsolute(entry.directory) ||
      entry.directory.split(/[\\/]/).includes("..") ||
      typeof entry.firstApacheVersion !== "string" ||
      !releaseTypes.has(entry.initialLicenseReleaseType)
    ) {
      throw new Error(`${location}: invalid release policy for ${packageName}`);
    }
    parseSemver(entry.firstApacheVersion, `${packageName} firstApacheVersion`);
  }

  if (
    policy.separateReleasePackages &&
    (typeof policy.separateReleasePackages !== "object" ||
      Array.isArray(policy.separateReleasePackages))
  ) {
    throw new Error(`${location}: separateReleasePackages must be an object`);
  }
  for (const [packageName, entry] of Object.entries(
    policy.separateReleasePackages || {},
  )) {
    if (
      !packageName ||
      typeof entry?.directory !== "string" ||
      path.isAbsolute(entry.directory) ||
      entry.directory.split(/[\\/]/).includes("..") ||
      typeof entry.workflow !== "string" ||
      path.isAbsolute(entry.workflow) ||
      entry.workflow.split(/[\\/]/).includes("..")
    ) {
      throw new Error(
        `${location}: invalid separate release policy for ${packageName}`,
      );
    }
  }

  const packageNames = new Set(Object.keys(policy.releasePackages));
  const directories = [];
  for (const [packageName, entry] of [
    ...Object.entries(policy.releasePackages),
    ...Object.entries(policy.separateReleasePackages || {}),
  ]) {
    if (
      packageNames.has(packageName) &&
      policy.separateReleasePackages?.[packageName]
    ) {
      throw new Error(
        `${location}: ${packageName} appears in two release lanes`,
      );
    }
    const normalized = entry.directory
      .replaceAll("\\", "/")
      .replace(/\/+$/, "");
    for (const existing of directories) {
      if (
        normalized === existing.directory ||
        normalized.startsWith(`${existing.directory}/`) ||
        existing.directory.startsWith(`${normalized}/`)
      ) {
        throw new Error(
          `${location}: overlapping package directories for ${existing.packageName} and ${packageName}`,
        );
      }
    }
    directories.push({ directory: normalized, packageName });
  }

  return policy;
}

export async function readReleasePolicy(policyPath) {
  let content;
  try {
    content = await readFile(policyPath, "utf8");
  } catch (error) {
    throw new Error(
      `${policyPath}: invalid or missing public-core release policy (${error.message})`,
    );
  }
  return parseReleasePolicy(content, policyPath);
}

export async function listPendingChangesets(root) {
  const directory = path.join(root, ".changeset");
  if (!(await pathExists(directory))) {
    throw new Error(`${directory}: Changesets directory is missing`);
  }

  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (
      entry.name.endsWith(".md") &&
      entry.name.toLowerCase() !== "readme.md" &&
      !entry.isFile()
    ) {
      throw new Error(
        `${path.join(directory, entry.name)}: pending changeset must be a regular file`,
      );
    }
  }
  const filenames = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".md") &&
        entry.name.toLowerCase() !== "readme.md",
    )
    .map((entry) => entry.name)
    .sort();

  const changesets = [];
  for (const filename of filenames) {
    const absolute = path.join(directory, filename);
    changesets.push(parseChangeset(await readFile(absolute, "utf8"), filename));
  }
  return changesets;
}

export async function selectCoreChangesets({
  root,
  policy,
  allowNonCore = false,
}) {
  return selectCoreChangesetsFromList({
    changesets: await listPendingChangesets(root),
    policy,
    allowNonCore,
  });
}

export function selectCoreChangesetsFromList({
  changesets,
  policy,
  allowNonCore = false,
}) {
  const corePackages = new Set(Object.keys(policy.releasePackages));
  const separatePackages = new Map(
    Object.entries(policy.separateReleasePackages || {}),
  );
  const selected = [];

  for (const changeset of changesets) {
    const names = [...changeset.releases.keys()];
    const core = names.filter((name) => corePackages.has(name));
    const separate = names.filter((name) => separatePackages.has(name));

    if (separate.length > 0) {
      const lanes = separate
        .map((name) => `${name} via ${separatePackages.get(name).workflow}`)
        .join(", ");
      throw new Error(
        `${changeset.filename}: separate-lane package cannot enter the core release (${lanes})`,
      );
    }

    if (core.length > 0 && core.length !== names.length) {
      const nonCore = names.filter((name) => !corePackages.has(name));
      throw new Error(
        `${changeset.filename}: core and non-core packages cannot share a changeset (${nonCore.join(", ")})`,
      );
    }

    if (core.length === names.length) {
      selected.push(changeset);
    } else if (!allowNonCore) {
      throw new Error(
        `${changeset.filename}: non-core changeset is forbidden in the public repository (${names.join(", ")})`,
      );
    }
  }

  return selected;
}

export function parseSemver(value, label = "version") {
  const match = String(value).match(semverPattern);
  if (!match) throw new Error(`${label}: invalid semantic version ${value}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || null,
  };
}

export function compareSemver(left, right) {
  const parsedLeft = parseSemver(left, "left version");
  const parsedRight = parseSemver(right, "right version");
  for (const key of ["major", "minor", "patch"]) {
    if (parsedLeft[key] !== parsedRight[key]) {
      return parsedLeft[key] < parsedRight[key] ? -1 : 1;
    }
  }
  if (parsedLeft.prerelease === parsedRight.prerelease) return 0;
  if (parsedLeft.prerelease === null) return 1;
  if (parsedRight.prerelease === null) return -1;
  return parsedLeft.prerelease.localeCompare(parsedRight.prerelease, "en", {
    numeric: true,
  });
}

function globMatchesDirectory(glob, directory) {
  const escaped = glob
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", "\0")
    .replaceAll("*", "[^/]*")
    .replaceAll("\0", ".*");
  return new RegExp(`^${escaped}(?:/.*)?$`).test(
    directory.replaceAll("\\", "/"),
  );
}

async function validateWorkspaceLanes(root, policy) {
  const workspacePath = path.join(root, "pnpm-workspace.yaml");
  const content = await readFile(workspacePath, "utf8");
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const packagesIndex = lines.findIndex((line) => line.trim() === "packages:");
  if (packagesIndex < 0) {
    throw new Error(`${workspacePath}: packages list is missing`);
  }

  const globs = [];
  for (let index = packagesIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line && !/^\s/.test(line)) break;
    const match = line.match(/^\s*-\s*['"]?([^'"]+)['"]?\s*$/);
    if (match) globs.push(match[1].trim());
  }
  if (globs.length === 0) {
    throw new Error(`${workspacePath}: packages list is empty`);
  }

  for (const [packageName, entry] of Object.entries(policy.releasePackages)) {
    if (!globs.some((glob) => globMatchesDirectory(glob, entry.directory))) {
      throw new Error(
        `${workspacePath}: core package ${packageName} is outside the Changesets workspace`,
      );
    }
  }
  for (const [packageName, entry] of Object.entries(
    policy.separateReleasePackages || {},
  )) {
    if (globs.some((glob) => globMatchesDirectory(glob, entry.directory))) {
      throw new Error(
        `${workspacePath}: separate-lane package ${packageName} would enter core Changesets; release it via ${entry.workflow}`,
      );
    }
  }
}

export async function validatePublicReleaseState({ root, policy }) {
  await validateWorkspaceLanes(root, policy);
  const changesets = await selectCoreChangesets({ root, policy });
  const initial = changesets.find(
    (changeset) => changeset.filename === policy.initialLicenseChangeset,
  );
  const belowFirstApacheVersion = [];

  for (const [packageName, entry] of Object.entries(policy.releasePackages)) {
    const manifestPath = path.join(root, entry.directory, "package.json");
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch (error) {
      throw new Error(
        `${manifestPath}: invalid or missing package manifest (${error.message})`,
      );
    }

    if (manifest.name !== packageName) {
      throw new Error(
        `${manifestPath}: expected ${packageName}, found ${manifest.name || "none"}`,
      );
    }
    if (compareSemver(manifest.version, entry.firstApacheVersion) < 0) {
      belowFirstApacheVersion.push(packageName);
    }
  }

  if (belowFirstApacheVersion.length > 0 && !initial) {
    throw new Error(
      `${policy.initialLicenseChangeset}: required until every core package reaches its first Apache version (${belowFirstApacheVersion.join(", ")})`,
    );
  }

  if (
    belowFirstApacheVersion.length > 0 &&
    belowFirstApacheVersion.length !==
      Object.keys(policy.releasePackages).length
  ) {
    throw new Error(
      `partial first-Apache state is forbidden; below threshold: ${belowFirstApacheVersion.join(", ")}`,
    );
  }

  if (belowFirstApacheVersion.length === 0 && initial) {
    throw new Error(
      `${policy.initialLicenseChangeset}: stale initial-license changeset remains after first Apache versions`,
    );
  }

  if (initial) {
    for (const [packageName, entry] of Object.entries(policy.releasePackages)) {
      if (
        initial.releases.get(packageName) !== entry.initialLicenseReleaseType
      ) {
        throw new Error(
          `${policy.initialLicenseChangeset}: expected a ${entry.initialLicenseReleaseType} release for ${packageName}`,
        );
      }
    }
  }

  return {
    changesets,
    belowFirstApacheVersion,
    state:
      belowFirstApacheVersion.length > 0
        ? "pending-first-apache-release"
        : "versioned",
  };
}
