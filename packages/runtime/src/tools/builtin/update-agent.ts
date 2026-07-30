// update_agent — repair / retool an existing worker (manager capability).
//
// A Conductor uses this to FIX a worker — add a tool it's missing, rewrite a
// prompt, switch a model — e.g. "OUTLOOK is failing because it lacks the read
// tool, add nango:outlook:list_messages". Identify the target by id or name.
//
// DEFINITION is portable; the cloud EXECUTOR
// (api-server/src/tools/update-agent-executor.ts) calls the shared
// editAgentBlueprint core (same path as PATCH /agents/:id/blueprint): OWNER-ONLY
// and APPEND-ONLY (every edit is a new blueprint version, so it's reversible).
// Refuses to edit the calling agent — that's what update_instructions is for.

import type { InlineToolDefinition } from "../types";

export const updateAgentDefinition: InlineToolDefinition = {
  type: "inline",
  name: "update_agent",
  description:
    "REPAIR or retool an agent you OWN — add/remove tools, rewrite its system prompt, or switch its model. Identify it by agent_id (preferred) or agent_name. Writes a NEW blueprint version (history preserved, so any change is reversible). Owner-only and capped per run. CANNOT edit the calling agent itself (use update_instructions for self-improvement). Confirm with the user before changing an agent they actively rely on.",
  inputSchema: {
    type: "object",
    properties: {
      agent_id: { type: "string", description: "Id of the agent to edit (preferred)." },
      agent_name: {
        type: "string",
        description: "Name of the agent to edit (used only if agent_id is omitted; must be unambiguous).",
      },
      systemPrompt: { type: "string", description: "Optional replacement system prompt." },
      add_tools: {
        type: "array",
        items: { type: "string" },
        description: "Runtime tool names to add (e.g. 'nango:outlook:list_messages').",
      },
      remove_tools: {
        type: "array",
        items: { type: "string" },
        description: "Runtime tool names to remove.",
      },
      primaryModel: { type: "string", description: "Optional new model id." },
    },
  },
};

export type UpdateAgentInput = {
  agent_id?: string;
  agent_name?: string;
  systemPrompt?: string;
  add_tools?: string[];
  remove_tools?: string[];
  primaryModel?: string;
};

export type UpdateAgentResult = {
  agent_id: string;
  agent_name: string;
  status: "updated" | "error";
  /** New blueprint version number after the edit. */
  version: number;
  tools: string[];
  error?: string;
};
