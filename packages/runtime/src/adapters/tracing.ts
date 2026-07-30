// Abstract tracing interface used by the engine.
//
// Concrete implementations write trace events wherever the deployment
// target stores them (Postgres trace_events table for cloud, local file
// for desktop, etc.). The runtime stays storage-agnostic.

export type LlmCallTrace = {
  id: string;
  runId: string;
  agentId: string;
  name: string;
  input: string;
  output: string;
  model: string;
  tokens: number;
  costCents: number;
  latencyMs: number;
};

export type TranscriptionTrace = {
  id: string;
  runId: string;
  agentId: string;
  provider: string;
  // Audio tokens (provider-reported) and cost are optional — not every
  // adapter has them. nullability flows into the trace_events row.
  audioTokens: number | null;
  costCents: number | null;
  latencyMs: number;
  transcriptText: string;
};

/**
 * A single tool call within a run — the data behind the Conductor "fan-out
 * timeline". `invoke_agent` calls land here too (name="invoke_agent",
 * output = the sub-agent's summarized result), so a manager agent's run shows
 * which workers it dispatched. depth carries the sub-agent recursion level.
 */
export type ToolCallTrace = {
  id: string;
  runId: string;
  agentId: string;
  /** Tool name as the LLM called it (e.g. "invoke_agent", "web.research"). */
  name: string;
  input: string;
  output: string;
  status: "success" | "error";
  /** 0 = top-level; 1+ = inside a sub-agent dispatch chain. */
  depth: number;
  latencyMs: number;
};

export interface TracingAdapter {
  recordLlmCall(event: LlmCallTrace): Promise<void>;
  recordTranscription(event: TranscriptionTrace): Promise<void>;
  /**
   * Optional. Record a single tool call as a trace event. Hosts that want a
   * tool-level timeline (cloud) implement it; others (CLI/desktop consoles)
   * omit it. Additive — never breaks an existing adapter.
   */
  recordToolCall?(event: ToolCallTrace): Promise<void>;
}
