// Tool registry interface plus a default in-memory implementation.
//
// The registry is the boundary between portable tool DEFINITIONS
// (which live in @agentmug/runtime) and concrete EXECUTORS (which
// can live anywhere — api-server, a desktop runner, etc.). The
// engine looks tools up by name and calls their executor with the
// args Claude returned in a tool_use block.

import type { ToolDefinition } from "./types";

/**
 * What a host hands back when an executor asks for a provider's
 * credential. Deliberately open: OAuth providers fill `accessToken`,
 * key-based providers (Twilio, Slack bot tokens) fill `fields`, and a
 * brand-new provider needs no interface change — it just populates the
 * fields its executor reads. The executor decides what it needs.
 */
export type ResolvedCredential = {
  /** OAuth / bearer token, when the provider authenticates with one. */
  accessToken?: string;
  /** Token type for the Authorization header. Defaults to "bearer". */
  tokenType?: string;
  /**
   * Unix-ms expiry when known. The host is responsible for returning a
   * token that is still valid (it refreshes server-side / on-device);
   * this is advisory so executors can surface "expires soon" if they care.
   */
  expiresAt?: number | null;
  /** Granted scopes, when the host knows them. */
  scopes?: string[];
  /** Human label for the account (email, workspace name) — logs + UX. */
  accountLabel?: string | null;
  /** The host credential id actually used, after default-account resolution. */
  credentialId?: string;
  /**
   * Provider-specific secret fields that aren't a single bearer token —
   * e.g. Twilio `{ accountSid, authToken, fromNumber }`, a Slack
   * `{ botToken }`. Kept as an open map so adding a provider never forces
   * an interface change.
   */
  fields?: Record<string, string>;
};

/**
 * The host's credential broker. Lets a portable executor obtain the
 * credential for a provider WITHOUT importing host-specific code, which
 * is what lets one credentialed tool definition run on cloud, desktop, and
 * CLI with each host supplying the credential. Each host supplies its own
 * implementation:
 *
 *  - cloud:   reads the encrypted `user_credentials` row + refreshes.
 *  - desktop: a priority chain — a local OAuth token (BYO, offline) →
 *             a short-lived token minted from the signed-in AgentMug
 *             account (cloud bridge) → null (executor says "Connect X").
 *  - CLI:     environment variables / OS keychain.
 *
 * Returning `null` means "this provider isn't connected for this run";
 * the executor turns that into an actionable "Connect <provider>" error.
 * Some providers (Nango-proxied long-tail) have no on-device token at
 * all — those are handled by a host proxy executor, not the resolver,
 * so a resolver MAY return null for them by design.
 */
export interface CredentialResolver {
  resolve(
    provider: string,
    opts?: {
      /** Bind to a specific connected account (multi-account). */
      credentialId?: string;
      /** Scopes the executor needs; the host may use these to pick/mint. */
      scopes?: string[];
      /** Abort the resolution (e.g. a token mint over the network). */
      signal?: AbortSignal;
    },
  ): Promise<ResolvedCredential | null>;
}

export type ToolExecutionContext = {
  runId: string;
  agentId: string;
  userId: string;
  /**
   * How deep we are in a sub-agent dispatch chain. 0 = top-level
   * user-triggered run; 1+ = invoked by another agent's `invoke_agent`
   * tool. Used by the sub-agent executor to refuse recursion past a
   * sane bound (3) so a bug in an agent prompt can't fork-bomb the
   * runtime.
   */
  recursionDepth: number;
  /**
   * True when this run has NO human watching it — a scheduled / headless
   * run fired by a timer or the OS scheduler. Approval-gated executors
   * (shell.execute) MUST fail closed in this mode: never pop an approval
   * dialog nobody can see, never auto-approve — only run what's already on
   * the saved allowlist, refuse the rest. Undefined / false = interactive.
   */
  unattended?: boolean;
  /**
   * Live taint signal: returns true once this run has successfully read
   * UNTRUSTED external content (a web page, an inbox, another agent's
   * reply). The engine wires it to the same run-scoped flag that powers
   * the side-effect gate; recipient/approval guards use it to tighten
   * policy mid-run. Undefined on hosts that don't track it — treat as
   * "not tainted". A getter (not a boolean) because the flag mutates as
   * the run progresses and the context object is built once.
   */
  untrustedContentIngested?: () => boolean;
  /**
   * Called by the `ask_user` tool to signal that the engine should
   * persist conversation state, mark the run paused, and return.
   * The engine wires this; tool executors should NOT touch it unless
   * they explicitly want to halt the loop and wait for user input.
   * No-op when undefined (e.g. sub-agent contexts where pausing
   * doesn't make sense).
   */
  pauseForUser?: (args: {
    question: string;
    hint?: string;
    options?: string[];
    allowOther?: boolean;
  }) => void;
  /**
   * The run's abort signal (Phase 22). Executors with external work
   * — a fetch, a spawned subprocess, a long timer — should listen
   * on this and tear that work down when the host aborts the run
   * (e.g. desktop's Cmd+. interrupt). Without it, an aborted run
   * leaves zombie processes / sockets behind.
   *
   * Undefined when the host doesn't pass one (most non-interactive
   * callers); executors must treat undefined as "no abort possible"
   * and behave normally.
   */
  signal?: AbortSignal;
  /**
   * The block.id of the tool_use this executor is currently
   * fulfilling. Set by the engine before each `executeToolCall`
   * dispatch. Lets executors with side-channels (streaming output
   * to a UI, posting to a websocket) tag their messages with the
   * same id the host saw on the `tool_start` engine event so the
   * UI can correlate them.
   */
  currentToolUseId?: string;
  /** Stable durable action id for the current effectful tool call. */
  currentActionId?: string;
  /**
   * Multi-account: which connected ACCOUNT this agent uses per provider —
   * a map of canonical provider slug ("google", "outlook", "twilio", …) to
   * the host's credential id for the chosen account. Populated by the host
   * from the agent's stored bindings; executors thread the id into their
   * credential resolver (e.g. getValidGoogleAccessToken(userId,
   * ctx.accountBindings?.google)). Undefined or missing a slug → the
   * resolver's default account, i.e. the single-account behavior.
   */
  accountBindings?: Record<string, string>;
  /**
   * Host credential broker (Phase: dual-mode connections). When present,
   * a portable executor calls `ctx.credentialResolver.resolve("outlook",
   * { credentialId: ctx.accountBindings?.outlook })` to get the token /
   * secret it needs, instead of importing a host-specific credential
   * function. This is what lets a credentialed tool run on desktop and
   * CLI, not just cloud. Undefined when the host wires creds the old way
   * (direct import) or runs no credentialed tools.
   */
  credentialResolver?: CredentialResolver;
};

export interface ToolExecutor {
  execute(input: unknown, context: ToolExecutionContext): Promise<unknown>;
}

export type RegisteredTool = {
  definition: ToolDefinition;
  executor: ToolExecutor;
};

export interface ToolRegistry {
  register(definition: ToolDefinition, executor: ToolExecutor): void;
  get(name: string): RegisteredTool | null;
  list(): ToolDefinition[];
  /**
   * Load every tool from a plugin in one call. Phase 30. Lets
   * external npm packages ship a coherent bundle of definitions +
   * executors that consumers wire with a single import.
   *
   * Default implementation (on InMemoryToolRegistry) just iterates
   * `plugin.tools` and calls `register()` per entry; alternative
   * registries can override for catalog-driven behavior (e.g. a
   * cloud-side registry that filters by available providers).
   */
  loadPlugin?(plugin: import("../plugins").AgentMugPlugin): void;
}

export class InMemoryToolRegistry implements ToolRegistry {
  private tools = new Map<string, RegisteredTool>();
  private loadedPlugins = new Map<string, string>();

  register(definition: ToolDefinition, executor: ToolExecutor): void {
    this.tools.set(definition.name, { definition, executor });
  }

  get(name: string): RegisteredTool | null {
    return this.tools.get(name) ?? null;
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  /**
   * Register every tool the plugin defines. Idempotent on
   * (plugin.name, plugin.version) — calling `loadPlugin` twice with
   * the same plugin is a no-op so consumers can defensively re-load.
   * A different version of the same plugin REPLACES the older
   * registrations (last-write-wins), which matches npm semantics.
   */
  loadPlugin(plugin: import("../plugins").AgentMugPlugin): void {
    const existing = this.loadedPlugins.get(plugin.name);
    if (existing === plugin.version) return;
    for (const t of plugin.tools ?? []) {
      this.register(t.definition, t.executor);
    }
    this.loadedPlugins.set(plugin.name, plugin.version);
  }

  /** Names + versions of plugins currently loaded. */
  listPlugins(): Array<{ name: string; version: string }> {
    return Array.from(this.loadedPlugins.entries()).map(([name, version]) => ({
      name,
      version,
    }));
  }
}
