import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  SOURCE_CAPABILITIES,
  SOURCE_KINDS,
  type AgentFileV1,
  type ReceiptAdapter,
  type RunReceipt,
  type SourceBinding,
  type SourceBindingStatus,
} from "@agentmug/runtime";
import { LOCAL_SOURCE_ADAPTER_ID } from "./local-source-adapter.js";
import {
  MAX_PRIVATE_RECEIPT_BYTES,
  MAX_PRIVATE_RECEIPTS,
  MAX_PRIVATE_RECORD_BYTES,
} from "./source-limits.js";

type SourceStateOptions = {
  stateRoot?: string;
};

type ReceiptStoreOptions = SourceStateOptions & {
  agent?: AgentFileV1;
  bindings?: readonly SourceBinding[];
};

const SOURCE_BINDING_STATUSES = new Set<SourceBindingStatus>([
  "pending",
  "ready",
  "stale",
  "revoked",
  "error",
]);

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedForComparison(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
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

function pathIsWithin(root: string, candidate: string): boolean {
  const result = relative(
    normalizedForComparison(root),
    normalizedForComparison(candidate),
  );
  return (
    result === "" ||
    (!result.startsWith(`..${sep}`) &&
      result !== ".." &&
      !isAbsolute(result))
  );
}

export function defaultAgentMugStateRoot(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (environment.AGENTMUG_STATE_DIR?.trim()) {
    return resolve(environment.AGENTMUG_STATE_DIR.trim());
  }
  if (process.platform === "win32") {
    return join(
      environment.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
      "AgentMug",
    );
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "AgentMug");
  }
  return join(
    environment.XDG_STATE_HOME || join(homedir(), ".local", "state"),
    "agentmug",
  );
}

async function canonicalPrivateRoot(rawRoot: string): Promise<string> {
  const requested = resolve(rawRoot);
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const info = await lstat(requested);
  if (!info.isDirectory()) {
    throw new Error("AgentMug private state root is not a directory.");
  }
  const canonical = await realpath(requested);
  await chmod(canonical, 0o700).catch(() => {
    // Windows does not implement POSIX mode bits; ACLs remain authoritative.
  });
  return canonical;
}

async function existingCanonicalPrivateRoot(
  rawRoot: string,
): Promise<string | null> {
  const requested = resolve(rawRoot);
  const info = await lstat(requested).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return null;
  if (!info.isDirectory()) {
    throw new Error("AgentMug private state root is not a directory.");
  }
  return realpath(requested);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function bindingAuthorityFingerprint(agent: AgentFileV1): string {
  return hash(
    stableJson({
      id: agent.id,
      // Every portable field that can affect the system prompt, model, tool
      // authority, or source selection is part of the grant. Replacing a
      // same-path/same-id agent must never inherit access merely because its
      // source declaration stayed byte-for-byte identical.
      name: agent.name,
      description: agent.description,
      blueprint: agent.blueprint,
      parameters: agent.parameters,
      inputs: agent.inputs,
      triggers: agent.triggers,
      connectivity: agent.connectivity,
      sources: agent.sources,
      // The CLI appends the embedded brain index to the system prompt.
      brain: agent.brain,
    }),
  );
}

async function agentScopeKey(
  agentPath: string,
  agentId: string,
): Promise<string> {
  const requestedAgentPath = resolve(agentPath);
  const requestedInfo = await lstat(requestedAgentPath);
  if (requestedInfo.isSymbolicLink()) {
    throw new Error("Agent scope cannot be a symbolic-link .agent file.");
  }
  const canonicalAgentPath = await realpath(requestedAgentPath);
  const info = await lstat(canonicalAgentPath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("Agent scope must point to a regular .agent file.");
  }
  // The path is used only as input to a one-way scope hash. It is never saved
  // in the binding registry, receipt, or portable .agent.
  return hash(
    `agentmug-cli-source-scope-v3\u0000${agentId}\u0000${canonicalAgentPath}`,
  );
}

async function ensureScopedDirectory(
  root: string,
  category: "sources" | "receipts",
  scope: string,
): Promise<string> {
  const categoryDirectory = join(root, category);
  if (!pathIsWithin(root, categoryDirectory)) {
    throw new Error("Private state category escaped its root.");
  }
  await mkdir(categoryDirectory, { recursive: false, mode: 0o700 }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    },
  );
  const categoryInfo = await lstat(categoryDirectory);
  const canonicalCategory = await realpath(categoryDirectory);
  if (
    !categoryInfo.isDirectory() ||
    categoryInfo.isSymbolicLink() ||
    !pathIsWithin(root, canonicalCategory) ||
    normalizedForComparison(canonicalCategory) !==
      normalizedForComparison(categoryDirectory)
  ) {
    throw new Error("Private state category is redirected or unsafe.");
  }

  const directory = join(canonicalCategory, scope);
  if (!pathIsWithin(root, directory)) {
    throw new Error("Private state scope escaped its root.");
  }
  await mkdir(directory, { recursive: false, mode: 0o700 }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    },
  );
  const info = await lstat(directory);
  const canonicalDirectory = await realpath(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    !pathIsWithin(root, canonicalDirectory) ||
    normalizedForComparison(canonicalDirectory) !==
      normalizedForComparison(directory)
  ) {
    throw new Error("Private state scope is redirected or unsafe.");
  }
  await chmod(canonicalDirectory, 0o700).catch(() => {});
  return canonicalDirectory;
}

async function existingScopedDirectory(
  root: string,
  category: "sources" | "receipts",
  scope: string,
): Promise<string | null> {
  const categoryDirectory = join(root, category);
  const categoryInfo = await lstat(categoryDirectory).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (!categoryInfo) return null;
  const canonicalCategory = await realpath(categoryDirectory);
  if (
    !categoryInfo.isDirectory() ||
    categoryInfo.isSymbolicLink() ||
    !pathIsWithin(root, canonicalCategory) ||
    normalizedForComparison(canonicalCategory) !==
      normalizedForComparison(categoryDirectory)
  ) {
    throw new Error("Private state category is redirected or unsafe.");
  }
  const directory = join(canonicalCategory, scope);
  if (!pathIsWithin(root, directory)) {
    throw new Error("Private state scope escaped its root.");
  }
  const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return null;
  const canonicalDirectory = await realpath(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    !pathIsWithin(root, canonicalDirectory) ||
    normalizedForComparison(canonicalDirectory) !==
      normalizedForComparison(directory)
  ) {
    throw new Error("Private state scope is redirected or unsafe.");
  }
  return canonicalDirectory;
}

async function readPrivateJson(path: string): Promise<unknown> {
  const handle = await open(
    path,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await handle.stat();
    const pathInfo = await lstat(path);
    if (
      !before.isFile() ||
      pathInfo.isSymbolicLink() ||
      !sameFileIdentity(before, pathInfo)
    ) {
      throw new Error("Private state record is not a stable regular file.");
    }
    if (before.size <= 0 || before.size > MAX_PRIVATE_RECORD_BYTES) {
      throw new Error("Private state record is empty or exceeds its safe limit.");
    }
    const buffer = Buffer.allocUnsafe(MAX_PRIVATE_RECORD_BYTES + 1);
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
    if (offset > MAX_PRIVATE_RECORD_BYTES) {
      throw new Error("Private state record exceeds its safe limit.");
    }
    let raw: string;
    try {
      raw = new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, offset),
      );
    } catch {
      throw new Error("Private state record is not valid UTF-8 JSON.");
    }
    const after = await handle.stat();
    if (
      !sameFileIdentity(before, after) ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw new Error("Private state record changed while it was read.");
    }
    return JSON.parse(raw) as unknown;
  } finally {
    await handle.close();
  }
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_PRIVATE_RECORD_BYTES) {
    throw new Error("Private state record exceeds its safe limit.");
  }
  await writeFile(temporary, serialized, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    await rename(temporary, path);
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code !== "EEXIST" && code !== "EPERM") {
      await unlink(temporary).catch(() => {});
      throw error;
    }
    const existing = await lstat(path).catch(() => null);
    if (existing?.isSymbolicLink()) {
      await unlink(temporary).catch(() => {});
      throw new Error("Refusing to replace a symbolic-link private record.");
    }
    await unlink(path);
    await rename(temporary, path);
  }
  await chmod(path, 0o600).catch(() => {});
}

function optionalString(
  value: unknown,
  name: string,
  maximum = 500,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maximum) {
    throw new Error(`Private source binding has invalid ${name}.`);
  }
  return value;
}

function parseSourceBinding(value: unknown): SourceBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Private source binding is not an object.");
  }
  const candidate = value as Record<string, unknown>;
  const id = optionalString(candidate.id, "id", 200);
  const sourceId = optionalString(candidate.sourceId, "sourceId", 200);
  const adapterId = optionalString(candidate.adapterId, "adapterId", 200);
  if (!id || !sourceId || adapterId !== LOCAL_SOURCE_ADAPTER_ID) {
    throw new Error("Private source binding identity is invalid.");
  }
  if (
    typeof candidate.kind !== "string" ||
    !SOURCE_KINDS.includes(candidate.kind as never) ||
    candidate.kind === "provider"
  ) {
    throw new Error("Private source binding kind is invalid.");
  }
  if (
    typeof candidate.status !== "string" ||
    !SOURCE_BINDING_STATUSES.has(candidate.status as SourceBindingStatus)
  ) {
    throw new Error("Private source binding status is invalid.");
  }
  if (
    !candidate.locator ||
    typeof candidate.locator !== "object" ||
    Array.isArray(candidate.locator)
  ) {
    throw new Error("Private source binding locator is invalid.");
  }
  const locator = candidate.locator as Record<string, unknown>;
  if (typeof locator.path !== "string" || !isAbsolute(locator.path)) {
    throw new Error("Private source binding path is invalid.");
  }
  if (
    !Array.isArray(candidate.capabilities) ||
    candidate.capabilities.some(
      (item) =>
        typeof item !== "string" ||
        !SOURCE_CAPABILITIES.includes(item as never),
    )
  ) {
    throw new Error("Private source binding capabilities are invalid.");
  }
  const structure =
    candidate.structure === undefined
      ? undefined
      : Array.isArray(candidate.structure) &&
          candidate.structure.length <= 100 &&
          candidate.structure.every(
            (item) => typeof item === "string" && item.length <= 1_000,
          )
        ? candidate.structure as string[]
        : null;
  if (structure === null) {
    throw new Error("Private source binding structure is invalid.");
  }
  const revision =
    candidate.revision === undefined
      ? undefined
      : candidate.revision &&
          typeof candidate.revision === "object" &&
          !Array.isArray(candidate.revision)
        ? candidate.revision as SourceBinding["revision"]
        : null;
  if (revision === null) {
    throw new Error("Private source binding revision is invalid.");
  }
  const metadataRecord =
    candidate.metadata &&
    typeof candidate.metadata === "object" &&
    !Array.isArray(candidate.metadata)
      ? candidate.metadata as Record<string, unknown>
      : null;
  const safeMetadataArray = (value: unknown): string[] | null | undefined =>
    value === undefined
      ? undefined
      : Array.isArray(value) &&
          value.length <= 50 &&
          value.every(
            (item) => typeof item === "string" && item.length <= 200,
          )
        ? value as string[]
        : null;
  const acceptsExtensions = safeMetadataArray(
    metadataRecord?.acceptsExtensions,
  );
  const acceptsMediaTypes = safeMetadataArray(
    metadataRecord?.acceptsMediaTypes,
  );
  const metadata =
    candidate.metadata === undefined
      ? undefined
      : metadataRecord &&
          ["snapshot", "on-run", "watch", "unspecified"].includes(
            String(metadataRecord.freshnessMode),
          ) &&
          acceptsExtensions !== null &&
          acceptsMediaTypes !== null &&
          (metadataRecord.approvedAt === undefined ||
            (typeof metadataRecord.approvedAt === "string" &&
              metadataRecord.approvedAt.length <= 100))
        ? {
            freshnessMode: String(metadataRecord.freshnessMode),
            ...(acceptsExtensions
              ? { acceptsExtensions }
              : {}),
            ...(acceptsMediaTypes
              ? { acceptsMediaTypes }
              : {}),
            ...(typeof metadataRecord.approvedAt === "string"
              ? { approvedAt: metadataRecord.approvedAt }
              : {}),
          }
        : null;
  if (metadata === null) {
    throw new Error("Private source binding metadata is invalid.");
  }
  return {
    id,
    sourceId,
    adapterId,
    kind: candidate.kind as SourceBinding["kind"],
    status: candidate.status as SourceBindingStatus,
    locator: { path: locator.path },
    displayName: optionalString(candidate.displayName, "displayName"),
    providerType: optionalString(candidate.providerType, "providerType"),
    mediaType: optionalString(candidate.mediaType, "mediaType"),
    extension: optionalString(candidate.extension, "extension", 50),
    structure,
    capabilities: candidate.capabilities as SourceBinding["capabilities"],
    revision,
    lastSyncedAt: optionalString(candidate.lastSyncedAt, "lastSyncedAt", 100),
    metadata,
  };
}

function parseSourceBindingRecord(
  value: unknown,
  currentAuthorityFingerprint: string,
): SourceBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Private source record is not an object.");
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.authorityFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.authorityFingerprint)
  ) {
    throw new Error("Private source record authority is invalid.");
  }
  const binding = parseSourceBinding(record.binding);
  return record.authorityFingerprint === currentAuthorityFingerprint
    ? binding
    : { ...binding, status: "revoked" };
}

export class CliSourceBindingStore {
  readonly stateRoot: string;

  constructor(options: SourceStateOptions = {}) {
    this.stateRoot = resolve(
      options.stateRoot ?? defaultAgentMugStateRoot(),
    );
  }

  private async scopeDirectory(
    agentPath: string,
    agentId: string,
    create: boolean,
  ): Promise<string | null> {
    const scope = await agentScopeKey(agentPath, agentId);
    if (create) {
      const root = await canonicalPrivateRoot(this.stateRoot);
      return ensureScopedDirectory(root, "sources", scope);
    }
    const root = await existingCanonicalPrivateRoot(this.stateRoot);
    return root ? existingScopedDirectory(root, "sources", scope) : null;
  }

  private recordPath(directory: string, sourceId: string): string {
    return join(directory, `${hash(sourceId)}.json`);
  }

  async list(
    agentPath: string,
    agent: AgentFileV1,
  ): Promise<SourceBinding[]> {
    const directory = await this.scopeDirectory(
      agentPath,
      agent.id,
      false,
    );
    if (!directory) return [];
    const names = (await readdir(directory))
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .sort();
    if (names.length > 200) {
      throw new Error("Private source registry contains too many bindings.");
    }
    const bindings: SourceBinding[] = [];
    for (const name of names) {
      const path = join(directory, name);
      if (!pathIsWithin(directory, path)) {
        throw new Error("Private source record escaped its scope.");
      }
      const binding = parseSourceBindingRecord(
        await readPrivateJson(path),
        bindingAuthorityFingerprint(agent),
      );
      if (`${hash(binding.sourceId)}.json` !== name) {
        throw new Error("Private source record name does not match its source.");
      }
      bindings.push(binding);
    }
    return bindings;
  }

  async put(
    agentPath: string,
    agent: AgentFileV1,
    binding: SourceBinding,
  ): Promise<void> {
    const parsed = parseSourceBinding(binding);
    const directory = await this.scopeDirectory(
      agentPath,
      agent.id,
      true,
    );
    if (!directory) throw new Error("Could not create private source scope.");
    await writePrivateJson(
      this.recordPath(directory, parsed.sourceId),
      {
        version: 1,
        authorityFingerprint: bindingAuthorityFingerprint(agent),
        binding: parsed,
      },
    );
  }

  async remove(
    agentPath: string,
    agent: AgentFileV1,
    sourceId: string,
  ): Promise<boolean> {
    const directory = await this.scopeDirectory(
      agentPath,
      agent.id,
      false,
    );
    if (!directory) return false;
    const path = this.recordPath(directory, sourceId);
    if (!pathIsWithin(directory, path)) {
      throw new Error("Private source record escaped its scope.");
    }
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) return false;
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error("Refusing to remove a non-regular private record.");
    }
    await unlink(path);
    return true;
  }
}

function parseReceipt(value: unknown): RunReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Private run receipt is not an object.");
  }
  const receipt = value as Partial<RunReceipt>;
  if (
    receipt.version !== 1 ||
    typeof receipt.id !== "string" ||
    typeof receipt.runId !== "string" ||
    typeof receipt.agentId !== "string" ||
    !Array.isArray(receipt.reads) ||
    !Array.isArray(receipt.writes) ||
    !Array.isArray(receipt.approvals) ||
    !Array.isArray(receipt.evaluations)
  ) {
    throw new Error("Private run receipt is malformed.");
  }
  return receipt as RunReceipt;
}

export class CliReceiptStore implements ReceiptAdapter {
  private readonly rawRoot: string;
  private readonly agent?: AgentFileV1;
  private readonly bindings: readonly SourceBinding[];

  constructor(
    private readonly agentPath: string,
    private readonly agentId: string,
    options: ReceiptStoreOptions = {},
  ) {
    if (options.agent && options.agent.id !== agentId) {
      throw new Error("Receipt agent definition does not match its scope.");
    }
    this.rawRoot = options.stateRoot ?? defaultAgentMugStateRoot();
    this.agent = options.agent;
    this.bindings = options.bindings ?? [];
  }

  private async scopeDirectory(create: boolean): Promise<string | null> {
    const scope = await agentScopeKey(this.agentPath, this.agentId);
    if (create) {
      const root = await canonicalPrivateRoot(this.rawRoot);
      return ensureScopedDirectory(root, "receipts", scope);
    }
    const root = await existingCanonicalPrivateRoot(this.rawRoot);
    return root ? existingScopedDirectory(root, "receipts", scope) : null;
  }

  private recordPath(directory: string, runId: string): string {
    return join(directory, `${hash(runId)}.json`);
  }

  async save(receipt: RunReceipt): Promise<void> {
    if (receipt.agentId !== this.agentId) {
      throw new Error("Receipt agent does not match its private scope.");
    }
    const approvalReceipts = this.bindings.flatMap((binding) => {
      const approvedAt = binding.metadata?.approvedAt;
      if (
        typeof approvedAt !== "string" ||
        !receipt.reads.some((read) => read.sourceId === binding.sourceId)
      ) {
        return [];
      }
      return [{
        id: `source-bind-${hash(
          `${binding.sourceId}\u0000${approvedAt}`,
        ).slice(0, 32)}`,
        sourceId: binding.sourceId,
        action: "read:on-bind",
        decision: "approved" as const,
        decidedAt: approvedAt,
        decidedBy: "cli-local",
      }];
    });
    const approvalIds = new Set(receipt.approvals.map((item) => item.id));
    const enriched: RunReceipt = {
      ...receipt,
      ...(this.agent ? { agentVersion: this.agent.version } : {}),
      approvals: [
        ...receipt.approvals,
        ...approvalReceipts.filter((item) => !approvalIds.has(item.id)),
      ],
      metadata: {
        ...(receipt.metadata ?? {}),
        ...(this.agent
          ? {
              sourceAuthorityFingerprint:
                bindingAuthorityFingerprint(this.agent),
            }
          : {}),
      },
    };
    // ReceiptAdapter is called before the engine returns its receipt. Keep the
    // caller-visible proof identical to the privately persisted proof.
    Object.assign(receipt, enriched);

    const directory = await this.scopeDirectory(true);
    if (!directory) throw new Error("Could not create private receipt scope.");
    const target = this.recordPath(directory, receipt.runId);
    const names = (await readdir(directory)).filter((name) =>
      /^[a-f0-9]{64}\.json$/.test(name),
    );
    let existingBytes = 0;
    let targetBytes = 0;
    const targetName = basename(target);
    for (const name of names) {
      const path = join(directory, name);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error("Private receipt scope contains an unsafe record.");
      }
      existingBytes += info.size;
      if (name === targetName) targetBytes = info.size;
    }
    const targetExists = targetBytes > 0;
    const nextBytes = Buffer.byteLength(`${JSON.stringify(enriched, null, 2)}\n`);
    if (
      (!targetExists && names.length >= MAX_PRIVATE_RECEIPTS) ||
      existingBytes - targetBytes + nextBytes > MAX_PRIVATE_RECEIPT_BYTES
    ) {
      throw new Error(
        "Private receipt retention cap reached; use 'agentmug receipts list' and explicitly delete old receipts before running again.",
      );
    }
    await writePrivateJson(
      target,
      enriched,
    );
  }

  async get(runId: string): Promise<RunReceipt | null> {
    const directory = await this.scopeDirectory(false);
    if (!directory) return null;
    const path = this.recordPath(directory, runId);
    const exists = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!exists) return null;
    const receipt = parseReceipt(await readPrivateJson(path));
    if (receipt.runId !== runId || receipt.agentId !== this.agentId) {
      throw new Error("Private receipt identity does not match its record.");
    }
    return receipt;
  }

  async listSaved(): Promise<RunReceipt[]> {
    const directory = await this.scopeDirectory(false);
    if (!directory) return [];
    const names = (await readdir(directory))
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .sort();
    if (names.length > MAX_PRIVATE_RECEIPTS) {
      throw new Error("Private receipt scope exceeds its safe record limit.");
    }
    const receipts: RunReceipt[] = [];
    for (const name of names) {
      const path = join(directory, name);
      if (!pathIsWithin(directory, path)) {
        throw new Error("Private receipt record escaped its scope.");
      }
      const receipt = parseReceipt(await readPrivateJson(path));
      if (
        receipt.agentId !== this.agentId ||
        `${hash(receipt.runId)}.json` !== name
      ) {
        throw new Error("Private receipt identity does not match its record.");
      }
      receipts.push(receipt);
    }
    return receipts.sort((left, right) =>
      (right.completedAt ?? right.startedAt).localeCompare(
        left.completedAt ?? left.startedAt,
      ),
    );
  }

  async remove(runId: string): Promise<boolean> {
    const directory = await this.scopeDirectory(false);
    if (!directory) return false;
    const path = this.recordPath(directory, runId);
    if (!pathIsWithin(directory, path)) {
      throw new Error("Private receipt record escaped its scope.");
    }
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) return false;
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error("Refusing to remove a non-regular private receipt.");
    }
    const receipt = parseReceipt(await readPrivateJson(path));
    if (receipt.runId !== runId || receipt.agentId !== this.agentId) {
      throw new Error("Private receipt identity does not match its record.");
    }
    await unlink(path);
    return true;
  }
}
