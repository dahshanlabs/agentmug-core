// Verified Self-Skilling — the portable tool DEFINITIONS.
//
// A "skill" is a reusable capability the agent figured out and PROVED: captured
// with save_skill (only after a verification judge passes), persisted into the
// agent's blueprint (skills travel in the .agent file), and replayed on demand
// with use_skill. A tiny name+trigger INDEX lives in the system prompt; the
// full recipe loads lazily when invoked.
//
// These DEFINITIONS live in @agentmug/runtime so any host can offer the tools;
// the portable EXECUTORS (see ../self-skilling.ts) run them off-cloud,
// persisting into the .agent file via the serializer. The cloud has its own
// DB-backed executors against the same definitions.

import type { InlineToolDefinition } from "../types";

export const saveSkillDefinition: InlineToolDefinition = {
  type: "inline",
  name: "save_skill",
  description:
    "Permanently SAVE a reusable skill you just figured out, so you can replay it on future requests instead of re-deriving it. Only worth saving when the approach generalizes — a repeatable procedure, not a one-off. It is VERIFIED before it's kept (a strict reviewer checks it's reusable, clearly triggered, followable, and safe); if it doesn't pass it is NOT saved and you're told why. Give the steps concretely (named tools, order, inputs).",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description:
          "A short, memorable name for the skill, e.g. 'chase_overdue_invoices'. Lowercase words; this is how you'll call use_skill later.",
      },
      trigger: {
        type: "string",
        description:
          "When to use this skill, in plain language — e.g. 'when the user asks to follow up on unpaid invoices'. Drives the cheap in-prompt index.",
      },
      recipe: {
        type: "string",
        description:
          "The exact, replayable steps: which tools to call, in what order, with what inputs. Self-contained enough to follow again. No secrets/credentials.",
      },
      reason: {
        type: "string",
        description: "One short sentence on what made this worth keeping.",
      },
    },
    required: ["name", "trigger", "recipe"],
  },
};

export const useSkillDefinition: InlineToolDefinition = {
  type: "inline",
  name: "use_skill",
  description:
    "Load a skill you previously learned and saved, to replay its exact steps instead of re-deriving them. Call this when the current request matches a skill listed in your 'Skills you've learned' index. Returns the recipe; then follow it, adapting the specifics to the current request.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "The skill name, exactly as listed in your skills index.",
      },
    },
    required: ["name"],
  },
};

export type SaveSkillInput = {
  name: string;
  trigger: string;
  recipe: string;
  reason?: string;
};

export type SaveSkillResult = {
  ok: boolean;
  name?: string;
  score?: number;
  note: string;
};

export type UseSkillInput = { name: string };

export type UseSkillResult = {
  found: boolean;
  name?: string;
  trigger?: string;
  recipe?: string;
  verified?: boolean;
  available?: string[];
  note: string;
};
