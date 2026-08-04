// Quickstart helpers. Phase 28.
//
// Goal: the 10-line hello-agent in the README actually compiles +
// works. Without these helpers, `runAgent()` requires composing
// six adapters before you can call it, which is the wrong DX for
// a first-five-minutes experience.
//
// What's here:
//   - createInMemoryAdapters() — persistence + tracing that hold
//     state in JS Maps. No DB, no disk, no logging beyond an
//     optional console hook. Perfect for tests, scripts, and
//     evaluator harnesses.
//   - quickRun() — the convenience function the README sells. Pass
//     an AgentFileV1 + a string + an LLM client (or just an
//     Anthropic key) and get back the result.
//
// These compose on top of runAgent — they don't replace it. The
// adapters they create implement the same interfaces as the
// production Postgres adapters, so swapping in / out is one line.

import { runAgent, type EngineEvent, type RunAgentResult } from "./engine";
import type {
  AgentRecord,
  BlueprintRecord,
  NewRun,
  PersistenceAdapter,
  RunCompletion,
  RunFailure,
} from "./adapters/persistence";
import type {
  LlmCallTrace,
  TracingAdapter,
  TranscriptionTrace,
} from "./adapters/tracing";
import type { LlmClient } from "./adapters/llm";
import type { AgentInput } from "./inputs/types";
import type { AgentFileV1 } from "./format/agent-file";
import { AnthropicLlmClient } from "./adapters/llm";
import { InMemoryToolRegistry, type ToolRegistry } from "./tools/registry";
import { prepareSourceExecution } from "./sources/execution-plan";
import type { SourceBinding } from "./sources/types";
import type {
  KnowledgeAdapter,
  ReceiptAdapter,
  SourceAdapter,
} from "./sources/adapters";
import type { RunActionReceipt } from "./actions/types";

/**
 * In-memory persistence backed by a single AgentFileV1. Mirrors
 * what the desktop + CLI runtimes use to satisfy the
 * PersistenceAdapter interface without a database.
 *
 * Exported so consumers can construct it once + reuse across
 * many runs (handy for batch evaluation, prompt sweeps).
 */
export class InMemoryPersistenceAdapter implements PersistenceAdapter {
  private agentFile: AgentFileV1;
  private runs = new Map<
    string,
    NewRun & Partial<RunCompletion & RunFailure>
  >();
  private actions = new Map<string, RunActionReceipt>();

  constructor(agentFile: AgentFileV1) {
    this.agentFile = agentFile;
  }

  async getAgent(id: string): Promise<AgentRecord | null> {
    if (id !== this.agentFile.id) return null;
    return {
      id: this.agentFile.id,
      name: this.agentFile.name,
      description: this.agentFile.description,
    };
  }

  async getLatestBlueprint(agentId: string): Promise<BlueprintRecord | null> {
    if (agentId !== this.agentFile.id) return null;
    return {
      systemPrompt: this.agentFile.blueprint.systemPrompt,
      primaryModel: this.agentFile.blueprint.primaryModel,
      evaluation: this.agentFile.evaluation,
      ...(this.agentFile.blueprint.maxTokens !== undefined
        ? { maxTokens: this.agentFile.blueprint.maxTokens }
        : {}),
      ...(this.agentFile.blueprint.extendedThinkingBudget !== undefined
        ? {
            extendedThinkingBudget:
              this.agentFile.blueprint.extendedThinkingBudget,
          }
        : {}),
      ...(this.agentFile.blueprint.guardrails !== undefined
        ? { guardrails: this.agentFile.blueprint.guardrails }
        : {}),
    };
  }

  async createRun(run: NewRun): Promise<void> {
    this.runs.set(run.id, { ...run });
  }

  async completeRun(update: RunCompletion): Promise<void> {
    const existing = this.runs.get(update.id);
    if (existing) this.runs.set(update.id, { ...existing, ...update });
  }

  async failRun(update: RunFailure): Promise<void> {
    const existing = this.runs.get(update.id);
    if (existing) this.runs.set(update.id, { ...existing, ...update });
  }

  async saveRunAction(action: RunActionReceipt): Promise<void> {
    this.actions.set(action.id, { ...action });
  }

  async incrementAgentRunCount(_agentId: string): Promise<void> {
    /* no-op for in-memory */
  }

  /** Peek at the run history this adapter is holding. Handy in tests. */
  listRuns(): ReadonlyArray<NewRun & Partial<RunCompletion & RunFailure>> {
    return Array.from(this.runs.values());
  }

  /** Durable-for-process action receipts for quickstarts and tests. */
  listActions(): ReadonlyArray<RunActionReceipt> {
    return Array.from(this.actions.values());
  }
}

/**
 * Tracing adapter that swallows events. Pass `onLlmCall` to
 * receive them for debugging (e.g. log to console, push to
 * OpenTelemetry, etc.).
 */
export class InMemoryTracingAdapter implements TracingAdapter {
  constructor(
    private hooks: {
      onLlmCall?: (event: LlmCallTrace) => void;
      onTranscription?: (event: TranscriptionTrace) => void;
    } = {},
  ) {}

  async recordLlmCall(event: LlmCallTrace): Promise<void> {
    this.hooks.onLlmCall?.(event);
  }

  async recordTranscription(event: TranscriptionTrace): Promise<void> {
    this.hooks.onTranscription?.(event);
  }
}

/**
 * Sensible-default adapter bundle for tests, scripts, and the
 * hello-agent README sample. Returns persistence + tracing tied to
 * one AgentFileV1.
 */
export function createInMemoryAdapters(
  agentFile: AgentFileV1,
  options: {
    onLlmCall?: (event: LlmCallTrace) => void;
  } = {},
): {
  persistence: InMemoryPersistenceAdapter;
  tracing: InMemoryTracingAdapter;
} {
  return {
    persistence: new InMemoryPersistenceAdapter(agentFile),
    tracing: new InMemoryTracingAdapter({ onLlmCall: options.onLlmCall }),
  };
}

/**
 * Quickstart `runAgent()` wrapper. Pass an AgentFileV1 + user input
 * + either an LlmClient or an Anthropic API key, get back a
 * RunAgentResult. Adapters are created in-memory.
 *
 * Use this for: hello-agent README sample, tests, batch evals, any
 * scenario where you don't need persistence across runs.
 *
 * For production, compose the adapters yourself + call runAgent
 * directly.
 */
export type QuickRunOptions = {
  agentFile: AgentFileV1;
  userInput: string | AgentInput;
  /** Either an LlmClient instance or an Anthropic API key shorthand. */
  llm: LlmClient | { anthropicApiKey: string };
  /** Optional tool registry. Defaults to an empty in-memory registry. */
  tools?: ToolRegistry;
  /**
   * Private bindings for `agentFile.sources`. Locators and credential
   * references remain in this host and never get serialized into `.agent`.
   */
  sourceBindings?: SourceBinding[];
  /** Raw local/provider adapters capable of resolving the private bindings. */
  sourceAdapters?: SourceAdapter[];
  /** Optional semantic index over bound source evidence. */
  knowledge?: KnowledgeAdapter;
  /** Optional persistence for the structured RunReceipt returned by the run. */
  receipts?: ReceiptAdapter;
  /** Optional event callback — useful for streaming tokens. */
  onEvent?: (event: EngineEvent) => void;
};

export async function quickRun(
  options: QuickRunOptions,
): Promise<RunAgentResult> {
  const {
    agentFile,
    userInput,
    llm,
    tools,
    sourceBindings = [],
    sourceAdapters = [],
    knowledge,
    receipts,
    onEvent,
  } = options;

  const llmClient: LlmClient =
    "anthropicApiKey" in llm
      ? new AnthropicLlmClient({ apiKey: llm.anthropicApiKey })
      : llm;

  const { persistence, tracing } = createInMemoryAdapters(agentFile);

  return runAgent({
    agentId: agentFile.id,
    userId: "quickstart",
    userInput,
    adapters: {
      persistence,
      tracing,
      llm: llmClient,
      ...(knowledge ? { knowledge } : {}),
      ...(receipts ? { receipts } : {}),
    },
    // Plan construction runs the required-source admissibility preflight —
    // a missing/stale/unauthorized required source refuses the run here,
    // before the model is ever called.
    sources: prepareSourceExecution({
      requirements: agentFile.sources ?? [],
      bindings: sourceBindings,
      adapters: sourceAdapters,
    }),
    evaluation: agentFile.evaluation,
    tools: tools ?? new InMemoryToolRegistry(),
    onEvent: onEvent ?? (() => {}),
  });
}
