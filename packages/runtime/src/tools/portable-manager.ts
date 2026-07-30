// Portable Manager — the Conductor's hands, off-cloud.
//
// The cloud ships list_agents / create_agent / update_agent / invoke_agent
// executors that read the agents + blueprints tables. This module ships
// the SAME four tools operating over a FOLDER of `.agent` files, so a
// Conductor agent can discover, spawn, repair, and dispatch a fleet on the
// desktop or CLI with no server — the manager moat ("an agent of agents")
// running on the user's own machine.
//
// Browser-safe: NO node:fs. Persistence is a pluggable `AgentFolderStore`
// the host wires (node:fs directory on the CLI, Tauri fs on desktop,
// in-memory for tests) — same seam as AgentFileStore + CredentialResolver.
// invoke_agent takes an injected sub-runner so this module never imports
// the engine (keeps it acyclic + testable).

import {
  buildAgentFile,
  normalizeTools,
  acceptedInputsFor,
  type AgentFileV1,
} from "../format/agent-file";
import type { ToolExecutor, ToolExecutionContext, ToolRegistry } from "./registry";
import {
  listAgentsDefinition,
  type ListAgentsInput,
  type ListAgentsResult,
  type AgentSummary,
} from "./builtin/list-agents";
import {
  createAgentDefinition,
  type CreateAgentInput,
  type CreateAgentResult,
} from "./builtin/create-agent";
import {
  updateAgentDefinition,
  type UpdateAgentInput,
  type UpdateAgentResult,
} from "./builtin/update-agent";
import {
  invokeAgentDefinition,
  type InvokeAgentInput,
  type InvokeAgentResult,
} from "./builtin/invoke-agent";

const DEFAULT_MODEL = "claude-sonnet-4-6";
const MAX_OUTPUT_CHARS = 30_000;
/** Mirrors the cloud invoke executor — refuse to recurse past this. */
const MAX_RECURSION_DEPTH = 3;

// ── Folder persistence abstraction ───────────────────────────────────────────

/** One agent the folder store knows about (its parsed file + where it lives). */
export type StoredAgent = {
  id: string;
  name: string;
  description: string;
  /** Host-meaningful locator (a file path on CLI/desktop). */
  path: string;
  file: AgentFileV1;
};

/**
 * How the portable Manager reads + writes a fleet of `.agent` files. The host
 * supplies the IO: a directory on disk (CLI/desktop) or memory (tests). The
 * runtime stays filesystem-free.
 */
export interface AgentFolderStore {
  /** Every agent in the folder, parsed. */
  list(): Promise<StoredAgent[]>;
  /** Resolve one agent by id (preferred) or exact name; null if absent. */
  get(idOrName: string): Promise<StoredAgent | null>;
  /** Create or overwrite an agent file (keyed by file.id); returns where it landed. */
  write(file: AgentFileV1): Promise<StoredAgent>;
}

/** In-memory folder store — a Map of id → file. Tests + simple hosts. */
export class InMemoryAgentFolderStore implements AgentFolderStore {
  private files = new Map<string, AgentFileV1>();
  constructor(initial: AgentFileV1[] = []) {
    for (const f of initial) this.files.set(f.id, f);
  }
  async list(): Promise<StoredAgent[]> {
    return Array.from(this.files.values()).map((f) => toStored(f, `mem://${f.id}`));
  }
  async get(idOrName: string): Promise<StoredAgent | null> {
    const byId = this.files.get(idOrName);
    if (byId) return toStored(byId, `mem://${byId.id}`);
    const byName = Array.from(this.files.values()).find((f) => f.name === idOrName);
    return byName ? toStored(byName, `mem://${byName.id}`) : null;
  }
  async write(file: AgentFileV1): Promise<StoredAgent> {
    this.files.set(file.id, file);
    return toStored(file, `mem://${file.id}`);
  }
}

function toStored(file: AgentFileV1, path: string): StoredAgent {
  return { id: file.id, name: file.name, description: file.description, path, file };
}

function toolNames(file: AgentFileV1): string[] {
  return normalizeTools(file).map((t) => t.name);
}

// ── invoke sub-runner injection ──────────────────────────────────────────────

/**
 * How the host runs a sub-agent. The host wires this to `runAgent` with its
 * own adapters (LLM client, etc.), incrementing recursionDepth. Kept as a
 * callback so this module never imports the engine.
 */
export type SubAgentRunner = (args: {
  file: AgentFileV1;
  /**
   * Where the worker's `.agent` lives (the StoredAgent locator — a file path on
   * CLI/desktop, a `mem://` URI in-memory). Lets the host wire the worker's OWN
   * brain + skills (read, and write back to its file) for the dispatch, instead
   * of running it brain-blind. Hosts that can't act on the locator may ignore it.
   */
  path: string;
  input: string;
  parentContext: ToolExecutionContext;
}) => Promise<{ status: "completed" | "failed"; output: string; error?: string }>;

// ── Executors ─────────────────────────────────────────────────────────────────

/** list_agents — scan the folder. No run history off-cloud, so stats are 0. */
export class PortableListAgentsExecutor implements ToolExecutor {
  constructor(private readonly store: AgentFolderStore) {}
  async execute(input: unknown): Promise<ListAgentsResult> {
    const p = (input ?? {}) as Partial<ListAgentsInput>;
    const q = (p.query ?? "").trim().toLowerCase();
    const limit = Math.min(Math.max(Number(p.limit) || 25, 1), 50);
    let agents = await this.store.list();
    if (q) {
      agents = agents.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          a.description.toLowerCase().includes(q),
      );
    }
    const summaries: AgentSummary[] = agents.slice(0, limit).map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      status: "active",
      tools: toolNames(a.file),
      total_runs: 0,
      success_rate: 0,
      last_run_at: null,
    }));
    return { agents: summaries };
  }
}

/**
 * create_agent — write a new draft `.agent` into the folder. Off-cloud there's
 * no Claude auto-designer, so the new agent uses the given systemPrompt (or the
 * prompt itself as a starting system prompt) + the requested tools. The user /
 * a follow-up update_agent can refine it.
 */
export class PortableCreateAgentExecutor implements ToolExecutor {
  constructor(private readonly store: AgentFolderStore) {}
  async execute(input: unknown): Promise<CreateAgentResult> {
    const p = (input ?? {}) as Partial<CreateAgentInput>;
    const prompt = (p.prompt ?? "").trim();
    if (!prompt) {
      return {
        agent_id: "",
        agent_name: "",
        status: "error",
        blueprint_generated: false,
        error: "create_agent requires a 'prompt' describing what the agent should do.",
      };
    }
    const id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `agent_${Date.now()}`;
    const name = (p.name ?? "").trim() || deriveName(prompt);
    const systemPrompt = (p.systemPrompt ?? "").trim() || prompt;
    const file = buildAgentFile({
      id,
      name,
      description: firstLine(prompt),
      version: "1.0.0",
      blueprint: {
        primaryModel: (p.primaryModel ?? "").trim() || DEFAULT_MODEL,
        systemPrompt,
        tools: Array.isArray(p.tools) ? p.tools : [],
      },
      // Derive the accepted-input contract from the model (honest across every
      // surface) instead of hardcoding "text" — so an agent-created agent keeps
      // its audio/vision affordances.
      inputs: { accepts: acceptedInputsFor((p.primaryModel ?? "").trim() || DEFAULT_MODEL) },
    });
    const stored = await this.store.write(file);
    return {
      agent_id: stored.id,
      agent_name: stored.name,
      status: "created",
      // Heuristic build (no Claude auto-design off-cloud), so flag it false —
      // matches the cloud's meaning of the field.
      blueprint_generated: false,
    };
  }
}

/** update_agent — load by id/name, apply edits, bump version, write back. */
export class PortableUpdateAgentExecutor implements ToolExecutor {
  constructor(private readonly store: AgentFolderStore) {}
  async execute(input: unknown, ctx: ToolExecutionContext): Promise<UpdateAgentResult> {
    const p = (input ?? {}) as Partial<UpdateAgentInput>;
    const key = (p.agent_id ?? p.agent_name ?? "").trim();
    if (!key) {
      return errUpdate("update_agent requires agent_id or agent_name.");
    }
    const target = await this.store.get(key);
    if (!target) {
      return errUpdate(`No agent found matching "${key}".`);
    }
    // Refuse self-edit — that's what update_instructions is for.
    if (target.id === ctx.agentId) {
      return errUpdate(
        "update_agent can't edit the calling agent itself. Use update_instructions for self-improvement.",
        target,
      );
    }

    const current = toolNames(target.file);
    const remove = new Set((p.remove_tools ?? []).map(String));
    const add = (p.add_tools ?? []).map(String);
    const nextTools = Array.from(
      new Set([...current.filter((t) => !remove.has(t)), ...add]),
    );

    const nextVersion = bumpVersion(target.file.version);
    const file = buildAgentFile({
      ...target.file,
      version: nextVersion,
      blueprint: {
        ...target.file.blueprint,
        tools: nextTools,
        systemPrompt:
          (p.systemPrompt ?? "").trim() || target.file.blueprint.systemPrompt,
        primaryModel:
          (p.primaryModel ?? "").trim() || target.file.blueprint.primaryModel,
      },
    });
    const stored = await this.store.write(file);
    return {
      agent_id: stored.id,
      agent_name: stored.name,
      status: "updated",
      version: versionToNumber(nextVersion),
      tools: nextTools,
    };
  }
}

/** invoke_agent — load a sibling agent and run it via the host sub-runner. */
export class PortableInvokeAgentExecutor implements ToolExecutor {
  constructor(
    private readonly store: AgentFolderStore,
    private readonly runSubAgent: SubAgentRunner,
  ) {}
  async execute(input: unknown, ctx: ToolExecutionContext): Promise<InvokeAgentResult> {
    const p = (input ?? {}) as Partial<InvokeAgentInput>;
    const userInput = (p.input ?? "").trim();
    const key = (p.agent_id ?? p.agent_name ?? "").trim();
    const startedAt = Date.now();
    if (!userInput) {
      return errInvoke(key, "invoke_agent requires 'input' for the sub-agent.", startedAt);
    }
    if (!key) {
      return errInvoke(key, "invoke_agent requires agent_id or agent_name.", startedAt);
    }
    if ((ctx.recursionDepth ?? 0) >= MAX_RECURSION_DEPTH) {
      return errInvoke(
        key,
        `Sub-agent recursion limit (${MAX_RECURSION_DEPTH}) reached — refusing to go deeper.`,
        startedAt,
      );
    }
    const target = await this.store.get(key);
    if (!target) {
      return errInvoke(key, `No agent found matching "${key}".`, startedAt);
    }
    try {
      const res = await this.runSubAgent({
        file: target.file,
        path: target.path,
        input: userInput,
        parentContext: ctx,
      });
      return {
        run_id: `${target.id}:${startedAt}`,
        agent_name: target.name,
        status: res.status,
        output: (res.output ?? "").slice(0, MAX_OUTPUT_CHARS),
        error: res.error,
        latency_ms: Date.now() - startedAt,
      };
    } catch (err) {
      return errInvoke(
        target.name,
        err instanceof Error ? err.message : String(err),
        startedAt,
      );
    }
  }
}

// ── Registration helper ─────────────────────────────────────────────────────

/**
 * Wire whichever Manager tools the agent declares onto a registry. Pass the
 * agent's tool-id list as `tools`; only declared tools are registered (so a
 * non-Conductor agent gets none). invoke_agent is registered only when a
 * sub-runner is supplied.
 */
export function registerPortableManagerTools(
  registry: ToolRegistry,
  opts: {
    store: AgentFolderStore;
    tools: string[];
    runSubAgent?: SubAgentRunner;
  },
): void {
  const has = (n: string) => opts.tools.includes(n);
  if (has(listAgentsDefinition.name)) {
    registry.register(listAgentsDefinition, new PortableListAgentsExecutor(opts.store));
  }
  if (has(createAgentDefinition.name)) {
    registry.register(createAgentDefinition, new PortableCreateAgentExecutor(opts.store));
  }
  if (has(updateAgentDefinition.name)) {
    registry.register(updateAgentDefinition, new PortableUpdateAgentExecutor(opts.store));
  }
  if (has(invokeAgentDefinition.name) && opts.runSubAgent) {
    registry.register(
      invokeAgentDefinition,
      new PortableInvokeAgentExecutor(opts.store, opts.runSubAgent),
    );
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function deriveName(prompt: string): string {
  const words = prompt.trim().split(/\s+/).slice(0, 4).join(" ");
  return words.length > 40 ? words.slice(0, 40) : words || "New Agent";
}

function firstLine(text: string): string {
  const line = text.split("\n")[0].trim();
  return line.length > 140 ? `${line.slice(0, 137)}…` : line;
}

/** Bump the patch segment of a semver-ish string ("1.2.3" → "1.2.4"). */
function bumpVersion(v: string): string {
  const parts = (v || "1.0.0").split(".");
  while (parts.length < 3) parts.push("0");
  const patch = Number(parts[2]) || 0;
  return `${parts[0]}.${parts[1]}.${patch + 1}`;
}

/** A monotonic integer for the UpdateAgentResult.version field. */
function versionToNumber(v: string): number {
  const parts = v.split(".").map((n) => Number(n) || 0);
  return parts[0] * 10000 + parts[1] * 100 + parts[2];
}

function errUpdate(error: string, target?: StoredAgent): UpdateAgentResult {
  return {
    agent_id: target?.id ?? "",
    agent_name: target?.name ?? "",
    status: "error",
    version: 0,
    tools: target ? toolNames(target.file) : [],
    error,
  };
}

function errInvoke(name: string, error: string, startedAt: number): InvokeAgentResult {
  return {
    run_id: "",
    agent_name: name,
    status: "failed",
    output: "",
    error,
    latency_ms: Date.now() - startedAt,
  };
}
