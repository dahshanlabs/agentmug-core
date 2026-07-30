// list_agents — the manager's eyes.
//
// One agent looks at the caller's fleet: which agents exist, what each
// does, their status, and how reliably they've been running. A Conductor
// uses this to DISCOVER the right worker agents, then dispatches them with
// invoke_agent and merges the results. Composition needs sight: you can't
// orchestrate a fleet you can't see.
//
// The DEFINITION is portable. The cloud EXECUTOR
// (api-server/src/tools/list-agents-executor.ts) queries the agents +
// blueprints + runs tables, scoped to the caller. Other runtimes ship
// their own executor (e.g. listing local .agent files on desktop / CLI).
//
// Read-only and owner-scoped — it only ever returns the caller's own
// agents, never another user's inventory.

import type { InlineToolDefinition } from "../types";

export const listAgentsDefinition: InlineToolDefinition = {
  type: "inline",
  name: "list_agents",
  description:
    "List the agents the caller owns — name, id, one-line purpose, the tools each uses, the connected account(s) each is bound to, status, and recent run stats. Use this to DISCOVER worker agents to orchestrate (then dispatch them with invoke_agent), or to reason about the user's fleet. For example, an inbox Conductor lists agents, picks the ones whose tools read mail (gmail.list_messages / nango:outlook:list_messages), invokes each, and merges into one summary. The `accounts` field shows which mailbox/account each worker reads — two workers with similar descriptions but DIFFERENT accounts are complementary (run both), not duplicates. Read-only. Pass status to filter, or query to match by name/description.",
  inputSchema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        description: "Optional filter by lifecycle: 'active', 'draft', or 'archived'.",
      },
      query: {
        type: "string",
        description:
          "Optional case-insensitive substring matched against agent name + description (e.g. 'inbox', 'email', 'whatsapp').",
      },
      limit: {
        type: "number",
        description: "Max agents to return (1-50). Default 25.",
      },
    },
  },
};

export type ListAgentsInput = {
  status?: string;
  query?: string;
  limit?: number;
};

export type AgentSummary = {
  id: string;
  name: string;
  /** One-line description of what the agent does. */
  description: string;
  /** "draft" | "active" | "paused" | "archived". */
  status: string;
  /** Runtime tool names the agent uses (from its latest blueprint). */
  tools: string[];
  /**
   * Human labels of the connected account(s) this agent is bound to, e.g.
   * ["sales@example.com"] or ["support@example.com"]. Lets a Conductor
   * tell complementary workers (same job, DIFFERENT mailbox) apart from true
   * duplicates. Empty = the agent uses the user's default account(s) (unbound).
   * Optional so runtimes without per-agent bindings (desktop/CLI) can omit it.
   */
  accounts?: string[];
  /** Total runs recorded. */
  total_runs: number;
  /** Success rate 0-1. */
  success_rate: number;
  /** ISO timestamp of the most recent COMPLETED run, or null if never. */
  last_run_at: string | null;
};

export type ListAgentsResult = {
  agents: AgentSummary[];
};
