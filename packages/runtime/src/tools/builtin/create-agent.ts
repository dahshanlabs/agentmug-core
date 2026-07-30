// create_agent — spawn a new worker agent (manager capability).
//
// A Conductor uses this to build a worker it's missing — e.g. "I see a 2nd
// Hotmail with no reader, I'll create one" — then drives it with invoke_agent.
// The new agent is owned by the caller and starts as a draft.
//
// DEFINITION is portable; the cloud EXECUTOR
// (api-server/src/tools/create-agent-executor.ts) calls the shared
// createAgentForUser core (same path as POST /agents). Owner-scoped and capped
// per run so a bad prompt can't fork-bomb the fleet.

import type { InlineToolDefinition } from "../types";

export const createAgentDefinition: InlineToolDefinition = {
  type: "inline",
  name: "create_agent",
  description:
    "Create a NEW agent owned by the caller — the manager move for spawning a missing worker (one job per agent, e.g. one mailbox per inbox-reader). Give a 'prompt' describing what it should do; name/tools/systemPrompt/model are optional (omit and they're auto-designed by Claude). Returns the new agent's id + name; it starts as a draft you can then run with invoke_agent or refine with update_agent. Prefer several small specialized workers over one monolith. Owner-scoped; capped per run.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "Plain-English description of what the new agent should do.",
      },
      name: { type: "string", description: "Optional name (auto-generated if omitted)." },
      tools: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional runtime tool names the agent should have (e.g. 'nango:outlook:list_messages', 'gmail.send'). Omit to let the auto-design pick.",
      },
      systemPrompt: {
        type: "string",
        description: "Optional explicit system prompt — when set, skips the (slower) Claude auto-design.",
      },
      primaryModel: {
        type: "string",
        description: "Optional model id; defaults to claude-sonnet-4-6.",
      },
    },
    required: ["prompt"],
  },
};

export type CreateAgentInput = {
  prompt: string;
  name?: string;
  tools?: string[];
  systemPrompt?: string;
  primaryModel?: string;
};

export type CreateAgentResult = {
  agent_id: string;
  agent_name: string;
  status: "created" | "error";
  /** false when the heuristic fallback ran (Claude unavailable). */
  blueprint_generated: boolean;
  error?: string;
};
