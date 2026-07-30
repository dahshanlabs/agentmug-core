// invoke_agent — sub-agent dispatch as a tool.
//
// One agent calls another the same way it calls any other tool. The
// engine recursively runs the target agent's blueprint, returns its
// final output as a tool_result, and continues the parent's loop.
//
// Why this is distinctive: every other "agent platform" treats
// agents as terminal entities — you run one at a time. With this
// tool, agents compose. A "Daily Planner" can dispatch a
// "Calendar Summarizer" sub-agent, then an "Inbox Triage"
// sub-agent, then a "Slack Standup" sub-agent, and orchestrate
// their outputs into a single morning brief.
//
// The DEFINITION is portable. The EXECUTOR lives in the cloud
// (api-server/src/tools/invoke-agent-executor.ts) where it has
// access to the agent table + blueprint loader. Other runtimes
// (desktop, CLI) ship their own executors that resolve to local
// .agent files.
//
// Recursion is guarded by ToolExecutionContext.recursionDepth — the
// executor refuses to recurse past 3 levels deep so a buggy prompt
// can't fork-bomb the runtime.

import type { InlineToolDefinition } from "../types";

export const invokeAgentDefinition: InlineToolDefinition = {
  type: "inline",
  name: "invoke_agent",
  description:
    "Run another agent as a sub-task. Use this to delegate a focused subtask to a specialized agent — e.g., 'use Spreadsheet Analyst to summarize this CSV', 'use Email Drafter to write a reply'. The target agent runs with the caller's credentials + parameter values and returns its final text output. Sub-agents can NOT recursively invoke more than 3 deep. Prefer composing simple specialized agents over building one monolith agent.",
  inputSchema: {
    type: "object",
    properties: {
      agent_name: {
        type: "string",
        description:
          "Name of the target agent to invoke. Must match an agent the caller owns OR a marketplace-listed agent. If multiple agents share a name, use agent_id instead for disambiguation.",
      },
      agent_id: {
        type: "string",
        description:
          "Unambiguous id of the target agent. Use when the same name might match more than one agent.",
      },
      input: {
        type: "string",
        description:
          "What you want the sub-agent to do. Phrase it like a user prompt — the sub-agent receives this as its userMessage.",
      },
      max_wait_seconds: {
        type: "number",
        description:
          "Hard cap on wall-clock time for the sub-agent. Default 120 (2 min). Capped at 600.",
      },
    },
    required: ["input"],
  },
};

export type InvokeAgentInput = {
  /** Either agent_id (preferred) or agent_name. */
  agent_id?: string;
  agent_name?: string;
  input: string;
  max_wait_seconds?: number;
};

export type InvokeAgentResult = {
  /** id of the sub-agent's run row (for tracing / linking). */
  run_id: string;
  /** Resolved agent name. */
  agent_name: string;
  /** "completed" / "failed". */
  status: "completed" | "failed";
  /** Sub-agent's final text output (truncated to ~30 KB). */
  output: string;
  /** Set when status="failed". */
  error?: string;
  /** Wall-clock ms the sub-agent took. */
  latency_ms: number;
  /** The worker's real SIDE-EFFECTING actions during the run (a WhatsApp it
   *  sent, a row it wrote) — so the conductor reports FACTUALLY what each worker
   *  did rather than guessing from its prose. Absent when no side effects. */
  actions?: { tool: string; ok: boolean; summary?: string }[];
};
