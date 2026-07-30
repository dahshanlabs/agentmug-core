import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import {
  lstat,
  open,
  opendir,
  realpath,
} from "node:fs/promises";
import {
  basename,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import type {
  EvidenceChunk,
  SourceAdapter,
  SourceBinding,
  SourceBindingCandidate,
  SourceCapability,
  SourceKind,
  SourceListRequest,
  SourceListResult,
  SourceReadRequest,
  SourceRequirement,
  SourceRevision,
} from "@agentmug/runtime";
import {
  extractSourceFile,
  isSupportedSourcePath,
  sourceMediaType,
  type ExtractedSource,
} from "./source-extractors.js";
import {
  MAX_DIRECTORY_DEPTH,
  MAX_DIRECTORY_ENTRIES,
  MAX_DIRECTORY_FILES,
  MAX_DIRECTORY_PARSE_MS,
  MAX_DIRECTORY_TOTAL_BYTES,
  MAX_KLYPIX_RAW_BYTES,
  MAX_SOURCE_CHUNK_CHARS,
  MAX_SOURCE_CHUNKS,
  MAX_SOURCE_FILE_BYTES,
} from "./source-limits.js";

export const LOCAL_SOURCE_ADAPTER_ID = "agentmug.cli.local-readonly.v1";

const FILE_CAPABILITIES: SourceCapability[] = [
  "read",
  "search",
  "cite",
  "sync",
  "version",
];
const DIRECTORY_CAPABILITIES: SourceCapability[] = [
  "read",
  "list",
  "search",
  "cite",
  "sync",
  "version",
];
const IGNORED_DIRECTORIES = new Set([
  ".cache",
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

type LocalFileEntry = {
  absolutePath: string;
  relativePath: string;
  size: number;
  modifiedAt: string;
};

type LocalSnapshotFile = LocalFileEntry & {
  extracted: ExtractedSource;
  revision: SourceRevision;
};

type LocalSourceSnapshot = {
  sourceId: string;
  root: string;
  kind: SourceKind;
  files: LocalSnapshotFile[];
  revision: SourceRevision;
  structure: string[];
  extension?: string;
  mediaType?: string;
};

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedForComparison(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function pathIsWithin(root: string, candidate: string): boolean {
  const normalizedRoot = normalizedForComparison(root);
  const normalizedCandidate = normalizedForComparison(candidate);
  const result = relative(normalizedRoot, normalizedCandidate);
  return (
    result === "" ||
    (!result.startsWith(`..${sep}`) &&
      result !== ".." &&
      !isAbsolute(result))
  );
}

function portableRelative(root: string, target: string): string {
  return relative(root, target).split(sep).join("/");
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  if (left.dev !== 0 || right.dev !== 0 || left.ino !== 0 || right.ino !== 0) {
    return left.dev === right.dev && left.ino === right.ino;
  }
  return (
    left.size === right.size &&
    left.birthtimeMs === right.birthtimeMs &&
    left.mtimeMs === right.mtimeMs
  );
}

async function readStableFile(
  path: string,
  options: {
    containmentRoot?: string;
    expectedCanonical?: string;
  } = {},
): Promise<{ bytes: Buffer; info: Stats; canonical: string }> {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(path, flags);
  try {
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new Error("Source path is not a regular file.");
    }
    const extension = extname(path).toLowerCase();
    const maxBytes =
      extension === ".klypix" ? MAX_KLYPIX_RAW_BYTES : MAX_SOURCE_FILE_BYTES;
    if (before.size <= 0 || before.size > maxBytes) {
      throw new Error(
        `Source file is empty or exceeds the safe ${Math.round(maxBytes / 1024 / 1024)} MB limit.`,
      );
    }

    const pathInfo = await lstat(path);
    if (pathInfo.isSymbolicLink() || !pathInfo.isFile()) {
      throw new Error("Source path changed into a symbolic link or non-file.");
    }
    const canonical = await realpath(path);
    if (
      options.expectedCanonical &&
      normalizedForComparison(canonical) !==
        normalizedForComparison(options.expectedCanonical)
    ) {
      throw new Error("Source path no longer resolves to its inspected target.");
    }
    if (
      options.containmentRoot &&
      !pathIsWithin(options.containmentRoot, canonical)
    ) {
      throw new Error("Source path resolves outside the bound root.");
    }
    if (!sameFileIdentity(before, pathInfo)) {
      throw new Error("Source file changed identity while it was opened.");
    }

    // Never let a concurrently-growing file turn the pre-read stat into an
    // unbounded allocation. Read through the already-open handle into a hard
    // max+1 buffer; the extra byte is the explicit overflow probe.
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.byteLength - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) {
      throw new Error(
        `Source file exceeds the safe ${Math.round(maxBytes / 1024 / 1024)} MB limit.`,
      );
    }
    const bytes = buffer.subarray(0, offset);
    const after = await handle.stat();
    if (
      !sameFileIdentity(before, after) ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      bytes.byteLength !== after.size
    ) {
      throw new Error("Source file changed while it was being read.");
    }
    const finalInfo = await lstat(path);
    const finalCanonical = await realpath(path);
    if (
      finalInfo.isSymbolicLink() ||
      !sameFileIdentity(after, finalInfo) ||
      normalizedForComparison(finalCanonical) !==
        normalizedForComparison(canonical)
    ) {
      throw new Error("Source file changed identity after it was read.");
    }
    return { bytes, info: after, canonical };
  } finally {
    await handle.close();
  }
}

function sanitizeBindingError(
  error: unknown,
  binding: SourceBinding,
): Error {
  let message = error instanceof Error ? error.message : String(error);
  const privateRoot = binding.locator.path;
  if (typeof privateRoot === "string" && privateRoot) {
    message = message.split(privateRoot).join("[private source]");
  }
  return new Error(message.slice(0, 1_000));
}

function validateRelativeSelector(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Source selector relativePath must be a non-empty string.");
  }
  const clean = value.replace(/\\/g, "/");
  if (
    isAbsolute(value) ||
    clean.startsWith("/") ||
    clean.includes("\u0000") ||
    clean.split("/").some((segment) => segment === ".." || segment.startsWith("."))
  ) {
    throw new Error("Source selector escapes the bound root or targets a hidden path.");
  }
  return clean;
}

async function stableCanonicalRoot(binding: SourceBinding): Promise<{
  root: string;
  kind: SourceKind;
}> {
  if (binding.adapterId !== LOCAL_SOURCE_ADAPTER_ID) {
    throw new Error("Binding belongs to a different source adapter.");
  }
  const locatorPath = binding.locator.path;
  if (typeof locatorPath !== "string" || !isAbsolute(locatorPath)) {
    throw new Error("Local source binding has an invalid private locator.");
  }
  const info = await lstat(locatorPath);
  if (info.isSymbolicLink()) {
    throw new Error("Bound source was replaced by a symbolic link.");
  }
  const canonical = await realpath(locatorPath);
  if (
    normalizedForComparison(canonical) !==
    normalizedForComparison(locatorPath)
  ) {
    throw new Error("Bound source no longer resolves to its original canonical path.");
  }
  if (
    (binding.kind === "file" || binding.kind === "klypix") &&
    !info.isFile()
  ) {
    throw new Error(`Bound ${binding.kind} source is no longer a file.`);
  }
  if (
    (binding.kind === "folder" || binding.kind === "workspace") &&
    !info.isDirectory()
  ) {
    throw new Error(`Bound ${binding.kind} source is no longer a directory.`);
  }
  if (binding.kind === "provider") {
    throw new Error("The CLI local adapter cannot read provider sources.");
  }
  return { root: canonical, kind: binding.kind };
}

async function resolveContainedFile(
  root: string,
  relativePath: string,
): Promise<LocalFileEntry> {
  const candidate = resolve(root, relativePath);
  if (!pathIsWithin(root, candidate)) {
    throw new Error("Source selector escapes the bound root.");
  }
  const info = await lstat(candidate);
  if (info.isSymbolicLink()) {
    throw new Error("Source selector targets a symbolic link.");
  }
  if (!info.isFile()) {
    throw new Error("Source selector does not target a regular file.");
  }
  const canonical = await realpath(candidate);
  if (!pathIsWithin(root, canonical)) {
    throw new Error("Source selector resolves outside the bound root.");
  }
  if (!isSupportedSourcePath(canonical)) {
    throw new Error(
      `Unsupported local source type '${extname(canonical).toLowerCase() || "(no extension)"}'.`,
    );
  }
  const maxBytes =
    extname(canonical).toLowerCase() === ".klypix"
      ? MAX_KLYPIX_RAW_BYTES
      : MAX_SOURCE_FILE_BYTES;
  if (info.size <= 0 || info.size > maxBytes) {
    throw new Error(
      `Selected source file is empty or exceeds the safe ${Math.round(maxBytes / 1024 / 1024)} MB limit.`,
    );
  }
  return {
    absolutePath: canonical,
    relativePath: portableRelative(root, canonical),
    size: info.size,
    modifiedAt: info.mtime.toISOString(),
  };
}

async function scanDirectory(
  root: string,
  include: (path: string) => boolean = () => true,
): Promise<LocalFileEntry[]> {
  const files: LocalFileEntry[] = [];
  const queue: Array<{
    absolutePath: string;
    relativePath: string;
    depth: number;
  }> = [
    { absolutePath: root, relativePath: "", depth: 0 },
  ];
  let totalBytes = 0;
  let totalEntries = 0;

  while (queue.length > 0) {
    const current = queue.shift()!;
    const entries = [];
    const directory = await opendir(current.absolutePath);
    for await (const entry of directory) {
      totalEntries += 1;
      if (totalEntries > MAX_DIRECTORY_ENTRIES) {
        throw new Error(
          `Directory has more than ${MAX_DIRECTORY_ENTRIES.toLocaleString()} entries; bind a narrower folder.`,
        );
      }
      entries.push(entry);
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      // Hidden paths and common generated/vendor trees are excluded by
      // default so binding a workspace cannot accidentally ingest secrets.
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;

      const absolutePath = resolve(current.absolutePath, entry.name);
      const relativePath = current.relativePath
        ? `${current.relativePath}/${entry.name}`
        : entry.name;
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) continue;
      const canonical = await realpath(absolutePath);
      if (!pathIsWithin(root, canonical)) {
        throw new Error("Directory source contains an entry outside its bound root.");
      }
      if (info.isDirectory()) {
        const depth = current.depth + 1;
        if (depth > MAX_DIRECTORY_DEPTH) {
          throw new Error(
            `Directory nesting exceeds the safe depth of ${MAX_DIRECTORY_DEPTH}; bind a narrower folder.`,
          );
        }
        queue.push({ absolutePath: canonical, relativePath, depth });
        continue;
      }
      if (
        !info.isFile() ||
        !isSupportedSourcePath(entry.name) ||
        !include(entry.name)
      ) {
        continue;
      }

      const maxBytes =
        extname(entry.name).toLowerCase() === ".klypix"
          ? MAX_KLYPIX_RAW_BYTES
          : MAX_SOURCE_FILE_BYTES;
      if (info.size <= 0 || info.size > maxBytes) {
        throw new Error(
          `Source file '${relativePath}' is empty or exceeds the safe ${Math.round(maxBytes / 1024 / 1024)} MB limit.`,
        );
      }
      totalBytes += info.size;
      if (files.length + 1 > MAX_DIRECTORY_FILES) {
        throw new Error(
          `Directory has more than ${MAX_DIRECTORY_FILES} readable files; bind a narrower folder.`,
        );
      }
      if (totalBytes > MAX_DIRECTORY_TOTAL_BYTES) {
        throw new Error(
          `Directory source exceeds the safe ${Math.round(MAX_DIRECTORY_TOTAL_BYTES / 1024 / 1024)} MB total limit; bind a narrower folder.`,
        );
      }
      files.push({
        absolutePath: canonical,
        relativePath,
        size: info.size,
        modifiedAt: info.mtime.toISOString(),
      });
    }
  }
  if (files.length === 0) {
    throw new Error("Directory contains no supported readable source files.");
  }
  return files;
}

function directoryRevision(files: readonly LocalSnapshotFile[]): SourceRevision {
  const manifest = files
    .map(
      (file) =>
        `${file.relativePath}\u0000${file.size}\u0000${file.modifiedAt}` +
        `\u0000${file.revision.contentHash ?? file.revision.id ?? ""}`,
    )
    .join("\n");
  const latest = files.reduce(
    (current, file) =>
      file.modifiedAt > current ? file.modifiedAt : current,
    files[0]!.modifiedAt,
  );
  return {
    id: hash(manifest),
    contentHash: hash(manifest),
    modifiedAt: latest,
  };
}

function chunkText(content: string): Array<{
  content: string;
  lineStart: number;
  lineEnd: number;
}> {
  const lines = content.split(/\r?\n/);
  const chunks: Array<{
    content: string;
    lineStart: number;
    lineEnd: number;
  }> = [];
  let buffer: string[] = [];
  let bufferChars = 0;
  let lineStart = 1;
  const flush = (lineEnd: number): void => {
    const text = buffer.join("\n").trim();
    if (text) chunks.push({ content: text, lineStart, lineEnd });
    buffer = [];
    bufferChars = 0;
    lineStart = lineEnd + 1;
  };
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index]!;
    while (line.length > MAX_SOURCE_CHUNK_CHARS) {
      if (buffer.length > 0) flush(index);
      chunks.push({
        content: line.slice(0, MAX_SOURCE_CHUNK_CHARS),
        lineStart: index + 1,
        lineEnd: index + 1,
      });
      line = line.slice(MAX_SOURCE_CHUNK_CHARS);
      lineStart = index + 1;
    }
    const separator = buffer.length > 0 ? 1 : 0;
    if (
      buffer.length > 0 &&
      bufferChars + separator + line.length > MAX_SOURCE_CHUNK_CHARS
    ) {
      flush(index);
    }
    if (buffer.length === 0) lineStart = index + 1;
    buffer.push(line);
    bufferChars += separator + line.length;
  }
  if (buffer.length > 0) flush(lines.length);
  return chunks;
}

function queryTerms(query: unknown): string[] {
  if (typeof query !== "string") return [];
  return [
    ...new Set(
      query
        .toLowerCase()
        .match(/[\p{L}\p{N}_-]{3,}/gu)
        ?.slice(0, 24) ?? [],
    ),
  ];
}

function relevance(
  content: string,
  relativePath: string,
  terms: readonly string[],
): number {
  if (terms.length === 0) return 0;
  const haystack = `${relativePath}\n${content}`.toLowerCase();
  let score = 0;
  for (const term of terms) {
    let cursor = 0;
    let hits = 0;
    while (hits < 20) {
      const next = haystack.indexOf(term, cursor);
      if (next < 0) break;
      hits += 1;
      cursor = next + term.length;
    }
    score += hits;
    if (relativePath.toLowerCase().includes(term)) score += 5;
  }
  return score;
}

function publicCapabilities(kind: SourceKind): SourceCapability[] {
  return kind === "folder" || kind === "workspace"
    ? [...DIRECTORY_CAPABILITIES]
    : [...FILE_CAPABILITIES];
}

function normalizedExtension(value: string): string {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith(".") ? normalized : `.${normalized}`;
}

function mediaTypeMatches(actual: string, expected: string): boolean {
  const normalizedActual = actual.trim().toLowerCase();
  const normalizedExpected = expected.trim().toLowerCase();
  return normalizedExpected.endsWith("/*")
    ? normalizedActual.startsWith(normalizedExpected.slice(0, -1))
    : normalizedActual === normalizedExpected;
}

function bindingAcceptsPath(binding: SourceBinding, path: string): boolean {
  const extensions = Array.isArray(binding.metadata?.acceptsExtensions)
    ? binding.metadata.acceptsExtensions.filter(
        (item): item is string => typeof item === "string",
      )
    : [];
  const mediaTypes = Array.isArray(binding.metadata?.acceptsMediaTypes)
    ? binding.metadata.acceptsMediaTypes.filter(
        (item): item is string => typeof item === "string",
      )
    : [];
  if (extensions.length === 0 && mediaTypes.length === 0) return true;
  const extension = extname(path).toLowerCase();
  const mediaType = sourceMediaType(path);
  return (
    extensions.some(
      (expected) => normalizedExtension(expected) === extension,
    ) ||
    mediaTypes.some((expected) => mediaTypeMatches(mediaType, expected))
  );
}

export class LocalReadOnlySourceAdapter implements SourceAdapter {
  readonly id = LOCAL_SOURCE_ADAPTER_ID;
  readonly capabilities = {
    adapterId: LOCAL_SOURCE_ADAPTER_ID,
    kinds: ["file", "folder", "workspace", "klypix"] as SourceKind[],
    capabilities: [...DIRECTORY_CAPABILITIES],
  };
  private readonly snapshots = new Map<string, LocalSourceSnapshot>();
  private readonly excludedRoots: string[];

  constructor(options: { excludedRoots?: string[] } = {}) {
    this.excludedRoots = (options.excludedRoots ?? []).map((path) =>
      resolve(path),
    );
  }

  private async assertNoExcludedOverlap(sourceRoot: string): Promise<void> {
    for (const excluded of this.excludedRoots) {
      const candidates = [excluded];
      const canonical = await realpath(excluded).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        },
      );
      if (canonical) candidates.push(canonical);
      for (const candidate of candidates) {
        if (
          pathIsWithin(candidate, sourceRoot) ||
          pathIsWithin(sourceRoot, candidate)
        ) {
          throw new Error(
            "Refusing a source that overlaps AgentMug's private state directory.",
          );
        }
      }
    }
  }

  private async captureSnapshot(
    binding: SourceBinding,
  ): Promise<LocalSourceSnapshot> {
    const { root, kind } = await stableCanonicalRoot(binding);
    await this.assertNoExcludedOverlap(root);
    if (kind === "file" || kind === "klypix") {
      if (!isSupportedSourcePath(root)) {
        throw new Error(
          `Unsupported local source type '${extname(root).toLowerCase() || "(no extension)"}'.`,
        );
      }
      if (kind === "klypix" && extname(root).toLowerCase() !== ".klypix") {
        throw new Error("Klypix source no longer points to a .klypix file.");
      }
      const stable = await readStableFile(root, {
        expectedCanonical: root,
      });
      const extracted = await extractSourceFile(
        basename(root),
        stable.bytes,
      );
      if (extracted.truncated) {
        throw new Error(
          "Source exceeds complete extraction limits; use a smaller or narrower source.",
        );
      }
      const contentHash = hash(stable.bytes);
      const revision: SourceRevision = {
        id: contentHash,
        ...(kind === "klypix"
          ? { idAttestation: "host-computed" as const }
          : {}),
        contentHash,
        modifiedAt: stable.info.mtime.toISOString(),
      };
      const snapshot: LocalSourceSnapshot = {
        sourceId: binding.sourceId,
        root,
        kind,
        files: [{
          absolutePath: root,
          relativePath: basename(root),
          size: stable.bytes.byteLength,
          modifiedAt: stable.info.mtime.toISOString(),
          extracted,
          revision,
        }],
        revision,
        structure: [
          ...extracted.structure,
          `File bytes: ${stable.bytes.byteLength}`,
        ],
        extension: extname(root).toLowerCase(),
        mediaType: extracted.mediaType,
      };
      this.snapshots.set(binding.id, snapshot);
      return snapshot;
    }

    const scanned = await scanDirectory(
      root,
      (path) => bindingAcceptsPath(binding, path),
    );
    const startedAt = Date.now();
    const files: LocalSnapshotFile[] = [];
    let actualBytes = 0;
    for (const file of scanned) {
      if (Date.now() - startedAt > MAX_DIRECTORY_PARSE_MS) {
        throw new Error(
          `Directory inspection exceeded the safe ${MAX_DIRECTORY_PARSE_MS / 1_000}-second limit.`,
        );
      }
      const stable = await readStableFile(file.absolutePath, {
        containmentRoot: root,
        expectedCanonical: file.absolutePath,
      });
      actualBytes += stable.bytes.byteLength;
      if (actualBytes > MAX_DIRECTORY_TOTAL_BYTES) {
        throw new Error(
          `Directory source exceeds the safe ${Math.round(MAX_DIRECTORY_TOTAL_BYTES / 1024 / 1024)} MB total limit.`,
        );
      }
      const extracted = await extractSourceFile(
        basename(stable.canonical),
        stable.bytes,
      );
      if (extracted.truncated) {
        throw new Error(
          `Source file '${file.relativePath}' exceeds complete extraction limits; bind a narrower folder.`,
        );
      }
      const contentHash = hash(stable.bytes);
      files.push({
        absolutePath: stable.canonical,
        relativePath: file.relativePath,
        size: stable.bytes.byteLength,
        modifiedAt: stable.info.mtime.toISOString(),
        extracted,
        revision: {
          id: contentHash,
          contentHash,
          modifiedAt: stable.info.mtime.toISOString(),
        },
      });
    }
    if (Date.now() - startedAt > MAX_DIRECTORY_PARSE_MS) {
      throw new Error(
        `Directory inspection exceeded the safe ${MAX_DIRECTORY_PARSE_MS / 1_000}-second limit.`,
      );
    }
    const structure = [
      `${kind === "workspace" ? "Workspace" : "Folder"} source`,
      `Readable files: ${files.length}`,
      `Total bytes: ${actualBytes}`,
      ...files.flatMap((file) => file.extracted.structure),
    ].filter(
      (item, index, all) => all.indexOf(item) === index,
    ).slice(0, 100);
    const snapshot: LocalSourceSnapshot = {
      sourceId: binding.sourceId,
      root,
      kind,
      files,
      revision: directoryRevision(files),
      structure,
      extension: extname(files[0]!.relativePath).toLowerCase(),
      mediaType: files[0]!.extracted.mediaType,
    };
    this.snapshots.set(binding.id, snapshot);
    return snapshot;
  }

  private async cachedSnapshot(
    binding: SourceBinding,
  ): Promise<LocalSourceSnapshot> {
    const { root, kind } = await stableCanonicalRoot(binding);
    const cached = this.snapshots.get(binding.id);
    const freshnessMode = binding.metadata?.freshnessMode;
    const mustRefresh =
      freshnessMode === "snapshot" || freshnessMode === "on-run";
    if (
      !mustRefresh &&
      cached &&
      cached.sourceId === binding.sourceId &&
      cached.kind === kind &&
      normalizedForComparison(cached.root) === normalizedForComparison(root)
    ) {
      this.assertSnapshotRevision(binding, cached);
      return cached;
    }
    const captured = await this.captureSnapshot(binding);
    try {
      this.assertSnapshotRevision(binding, captured);
      return captured;
    } catch (error) {
      this.snapshots.delete(binding.id);
      throw error;
    }
  }

  private assertSnapshotRevision(
    binding: SourceBinding,
    snapshot: LocalSourceSnapshot,
  ): void {
    if (binding.metadata?.freshnessMode !== "snapshot") return;
    const approved =
      binding.revision?.contentHash ?? binding.revision?.id;
    const current =
      snapshot.revision.contentHash ?? snapshot.revision.id;
    if (!approved) {
      throw new Error(
        "Snapshot source is missing its approved revision pin; explicitly bind it again.",
      );
    }
    if (!current || current !== approved) {
      throw new Error(
        "Snapshot source changed after approval; explicitly bind it again before reading.",
      );
    }
  }

  async createBinding(
    requirement: SourceRequirement,
    targetPath: string,
  ): Promise<SourceBinding> {
    if (requirement.kind === "provider") {
      throw new Error(
        "Provider sources must be connected in a provider-capable host; the CLI local adapter cannot bind them.",
      );
    }
    const requested = resolve(targetPath);
    const requestedInfo = await lstat(requested);
    if (requestedInfo.isSymbolicLink()) {
      throw new Error("Refusing to bind a symbolic-link source root.");
    }
    const canonical = await realpath(requested);
    await this.assertNoExcludedOverlap(canonical);
    const fileKind =
      requirement.kind === "file" || requirement.kind === "klypix";
    if (fileKind && !requestedInfo.isFile()) {
      throw new Error(`Source '${requirement.label}' requires a file.`);
    }
    if (!fileKind && !requestedInfo.isDirectory()) {
      throw new Error(`Source '${requirement.label}' requires a directory.`);
    }
    if (
      requirement.kind === "klypix" &&
      extname(canonical).toLowerCase() !== ".klypix"
    ) {
      throw new Error(`Source '${requirement.label}' requires a .klypix file.`);
    }
    if (fileKind && !isSupportedSourcePath(canonical)) {
      throw new Error(
        `Unsupported local source type '${extname(canonical).toLowerCase() || "(no extension)"}'.`,
      );
    }

    const initial: SourceBinding = {
      id: randomUUID(),
      sourceId: requirement.id,
      adapterId: this.id,
      kind: requirement.kind,
      status: "pending",
      locator: { path: canonical },
      displayName: basename(canonical),
      extension: fileKind ? extname(canonical).toLowerCase() : undefined,
      mediaType: fileKind ? sourceMediaType(canonical) : undefined,
      capabilities: publicCapabilities(requirement.kind),
      metadata: {
        freshnessMode: requirement.freshness?.mode ?? "unspecified",
        ...(requirement.accepts?.extensions?.length
          ? { acceptsExtensions: requirement.accepts.extensions }
          : {}),
        ...(requirement.accepts?.mediaTypes?.length
          ? { acceptsMediaTypes: requirement.accepts.mediaTypes }
          : {}),
      },
    };
    const inspected = await this.inspect(initial);
    return {
      ...initial,
      ...inspected,
      id: initial.id,
      locator: initial.locator,
    };
  }

  async inspect(binding: SourceBinding): Promise<SourceBindingCandidate> {
    try {
      const snapshot = await this.captureSnapshot(binding);
      return {
        id: binding.id,
        sourceId: binding.sourceId,
        adapterId: this.id,
        kind: snapshot.kind,
        status: "ready",
        displayName: basename(snapshot.root),
        mediaType: snapshot.mediaType,
        extension: snapshot.extension,
        structure: snapshot.structure,
        capabilities: publicCapabilities(snapshot.kind),
        revision: snapshot.revision,
        lastSyncedAt:
          binding.metadata?.freshnessMode === "on-run"
            ? new Date().toISOString()
            : binding.lastSyncedAt,
      };
    } catch (error) {
      throw sanitizeBindingError(error, binding);
    }
  }

  async read(
    binding: SourceBinding,
    request: SourceReadRequest = {},
  ): Promise<EvidenceChunk[]> {
    try {
      const snapshot = await this.cachedSnapshot(binding);
      const relativeSelector = validateRelativeSelector(
        request.selector?.relativePath,
      );
      let files: LocalSnapshotFile[];
      if (snapshot.kind === "file" || snapshot.kind === "klypix") {
        if (relativeSelector) {
          throw new Error("A single-file source does not accept relativePath.");
        }
        files = snapshot.files;
      } else if (relativeSelector) {
        const selected = await resolveContainedFile(
          snapshot.root,
          relativeSelector,
        );
        const snapshotFile = snapshot.files.find(
          (file) => file.relativePath === selected.relativePath,
        );
        if (!snapshotFile) {
          throw new Error(
            "Selected source file was not part of the inspected immutable snapshot.",
          );
        }
        files = [snapshotFile];
      } else {
        files = snapshot.files;
      }

      const terms = queryTerms(request.selector?.query);
      const candidates: Array<EvidenceChunk & { order: number }> = [];
      let order = 0;
      const retrievedAt = new Date().toISOString();
      for (const file of files) {
        if (file.extracted.records?.length) {
          for (const record of file.extracted.records) {
            const content = `KLYPIX_CARD_ID: ${record.id}\n${record.content}`;
            const score = relevance(content, file.relativePath, terms);
            candidates.push({
              id: hash(
                `${binding.sourceId}\u0000${record.id}\u0000${file.revision.contentHash ?? file.revision.id ?? ""}`,
              ),
              content,
              evidence: {
                sourceId: binding.sourceId,
                artifact: {
                  id: record.id,
                  name: basename(file.relativePath),
                  relativePath: file.relativePath,
                },
                revision: file.revision,
                location: {
                  kind: "record",
                  collection: "klypix.cards",
                  key: record.id,
                },
                title: `KLYPIX card ${record.id}`,
                retrievedAt,
              },
              mediaType: file.extracted.mediaType,
              score,
              trust: "raw",
              metadata: {},
              order: order++,
            });
          }
          continue;
        }
        const chunks = chunkText(file.extracted.content);
        for (const [chunkIndex, chunk] of chunks.entries()) {
          const score = relevance(chunk.content, file.relativePath, terms);
          candidates.push({
            id: hash(
              `${binding.sourceId}\u0000${file.relativePath}\u0000${chunkIndex}\u0000${file.revision.contentHash ?? file.revision.id ?? ""}`,
            ),
            content: chunk.content,
            evidence: {
              sourceId: binding.sourceId,
              artifact: {
                id: hash(file.relativePath),
                name: basename(file.relativePath),
                relativePath: file.relativePath,
              },
              revision: file.revision,
              location: {
                kind: "path",
                path: file.relativePath,
                lineStart: chunk.lineStart,
                lineEnd: chunk.lineEnd,
              },
              title: basename(file.relativePath),
              retrievedAt,
            },
            mediaType: file.extracted.mediaType,
            score,
            trust: "raw",
            metadata: file.extracted.truncated
              ? { extractionTruncated: true }
              : {},
            order: order++,
          });
        }
      }

      const requestedMax = Math.floor(request.maxChunks ?? 12);
      const maxChunks = Math.max(
        1,
        Math.min(MAX_SOURCE_CHUNKS, requestedMax),
      );
      candidates.sort((left, right) => {
        if (terms.length > 0 && right.score !== left.score) {
          return (right.score ?? 0) - (left.score ?? 0);
        }
        return left.order - right.order;
      });
      return candidates
        .slice(0, maxChunks)
        .map(({ order: _order, ...chunk }) => chunk);
    } catch (error) {
      throw sanitizeBindingError(error, binding);
    }
  }

  async list(
    binding: SourceBinding,
    request: SourceListRequest = {},
  ): Promise<SourceListResult> {
    try {
      const snapshot = await this.cachedSnapshot(binding);
      const offset = Math.max(
        0,
        Number.parseInt(request.cursor ?? "0", 10) || 0,
      );
      const limit = Math.max(
        1,
        Math.min(100, Math.floor(request.limit ?? 50)),
      );
      const selected = snapshot.files.slice(offset, offset + limit);
      return {
        items: selected.map((file) => ({
          id: hash(file.relativePath),
          sourceId: binding.sourceId,
          adapterId: this.id,
          kind: "file",
          status: "ready",
          displayName: basename(file.relativePath),
          extension: extname(file.relativePath).toLowerCase(),
          mediaType: file.extracted.mediaType,
          capabilities: [...FILE_CAPABILITIES],
          revision: file.revision,
        })),
        nextCursor:
          offset + selected.length < snapshot.files.length
            ? String(offset + selected.length)
            : undefined,
      };
    } catch (error) {
      throw sanitizeBindingError(error, binding);
    }
  }
}
