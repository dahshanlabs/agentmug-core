import type { InlineToolDefinition } from "../types";

/**
 * Host-provided recovery lane for a capability the worker genuinely lacks.
 * The portable runtime exports the contract; hosts decide whether and how to
 * build it. A host may start an isolated draft only when the owner explicitly
 * enabled that policy. The tool never installs or publishes generated code.
 */
export const requestCapabilityDefinition: InlineToolDefinition = {
  type: "inline",
  name: "request_capability",
  description:
    "Ask AgentMug to independently route a suspected capability gap. Use this ONLY when the user's normal task cannot be completed after checking direct reasoning, current tools, verified skills, connection setup, and safe fallbacks; the user never needs to say 'build a capability'. The host re-checks the inventory and returns solve, connect, clarify, or build. If it returns clarify, call ask_user exactly once with the returned question, then reconsider. Only when the owner explicitly enabled automatic drafts may a high-confidence deterministic no-egress gap start an isolated draft automatically. This tool never adds or publishes code. Never claim the original task succeeded until it actually does.",
  inputSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description:
          "Short concrete capability name, such as 'Classify expense rows'.",
      },
      request: {
        type: "string",
        description:
          "The user's original task and the exact missing behavior, without secrets or credentials.",
      },
      reason: {
        type: "string",
        description:
          "Why no existing tool, verified skill, connection step, or generic fallback can complete it.",
      },
      success_criteria: {
        type: "array",
        items: { type: "string" },
        description:
          "Two to five observable checks the new capability must pass.",
      },
    },
    required: ["title", "request", "reason", "success_criteria"],
  },
};

export type RequestCapabilityInput = {
  title: string;
  request: string;
  reason: string;
  success_criteria: string[];
};

export type RequestCapabilityResult = {
  ok: boolean;
  decision?: "solve" | "connect" | "clarify" | "build";
  buildId?: string;
  status?:
    | "suggested"
    | "queued"
    | "planning"
    | "needs_input"
    | "building"
    | "verifying"
    | "ready"
    | "failed"
    | "cancelled";
  autoStarted?: boolean;
  title?: string;
  url?: string;
  recommendedTool?: string;
  recommendedSkill?: string;
  requiredConnection?: string;
  question?: {
    prompt: string;
    hint?: string;
    options?: string[];
    allowOther: boolean;
  };
  note: string;
};
