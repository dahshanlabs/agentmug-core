// memory.save and memory.recall — per-(agent, user) persistent
// memory that the agent reads on every run.
//
// The Letta / Cursor-Background-Agents pattern. Without this, every
// run is a fresh start — the user's Morning Brief agent never learns
// "I prefer 3-bullet summaries, no fluff" no matter how many times
// the user tells it. With this, the agent gradually personalizes.
//
// memory.save writes one row, keyed by `key`. If the key already
// exists, it's overwritten (intentional — facts update, preferences
// change). importance (0-100) determines who survives prompt-budget
// pressure when the recall list gets long. memory.delete drops a
// fact entirely.
//
// memory.recall is technically redundant — the engine already
// prepends all memories to the system prompt before each run — but
// we expose it as a tool so the LLM can explicitly check what it
// knows ("let me check my notes about this user before answering")
// for transparency in the trace.

import type { InlineToolDefinition } from "../types";

export const memorySaveDefinition: InlineToolDefinition = {
  type: "inline",
  name: "memory.save",
  description:
    "Save a fact, preference, or constraint to remember about this user across all future runs. Use this whenever the user states a preference ('I prefer concise summaries', 'always use $US'), gives a personal fact ('I work in AI infra'), or sets a constraint ('never email after 6pm'). Future runs will see this memory automatically — you don't need to recall it explicitly. If a key already exists, it's overwritten. Use short snake_case keys.",
  inputSchema: {
    type: "object",
    properties: {
      key: {
        type: "string",
        description:
          "Short identifier for the fact. snake_case, scoped to this (agent, user). Examples: 'preferred_summary_length', 'industry_focus', 'tone', 'timezone'. Reusing a key overwrites.",
      },
      value: {
        type: "string",
        description:
          "The fact itself. Free-form text. Keep under 300 chars — the engine renders the memory verbatim into future system prompts, so brevity matters.",
      },
      importance: {
        type: "number",
        description:
          "How critical is this fact? 0-100. Default 50. Use 80+ for hard constraints (never X, always Y), 50 for preferences, 20 for nice-to-knows. Higher importance memories survive prompt-budget pressure.",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional category tags. Examples: 'preference', 'fact', 'constraint', 'goal'.",
      },
    },
    required: ["key", "value"],
  },
};

export const memoryRecallDefinition: InlineToolDefinition = {
  type: "inline",
  name: "memory.recall",
  description:
    "List all facts you've previously saved about this user. Returns each as { key, value, importance }. Note: the engine already prepends these to your system prompt before every run — you only need to call this tool if you want to explicitly cite or confirm what you know in your response.",
  inputSchema: {
    type: "object",
    properties: {
      tag: {
        type: "string",
        description:
          "Optional: filter to memories with this tag. If omitted, returns all memories.",
      },
    },
  },
};

export const memoryForgetDefinition: InlineToolDefinition = {
  type: "inline",
  name: "memory.forget",
  description:
    "Delete a previously-saved memory by key. Use this when the user explicitly retracts a preference ('actually never mind, don't always use Slack') or when a fact becomes stale.",
  inputSchema: {
    type: "object",
    properties: {
      key: {
        type: "string",
        description: "The key of the memory to delete.",
      },
    },
    required: ["key"],
  },
};

// memory.reflect — the self-improving step. Without it, memory is
// write-only accumulation: facts pile up, duplicate, contradict, and
// go stale until the recall list is noise. reflect closes the loop:
// the agent reviews its accumulated memories (optionally focused on a
// theme), then an LLM consolidation pass DEDUPES near-duplicates,
// resolves contradictions (newer/explicit wins), drops stale facts,
// and rewrites the survivors as crisp durable lessons. The executor
// applies the result back to the memory store. This is what turns
// "an agent with notes" into "an agent that gets better over time."
export const memoryReflectDefinition: InlineToolDefinition = {
  type: "inline",
  name: "memory.reflect",
  description:
    "Review and consolidate your accumulated memories about this user, then rewrite them into a cleaner, sharper set. Use this when your memory has grown noisy — duplicate facts, contradictions, or stale preferences. It dedupes near-duplicates, resolves contradictions (the newer/more-explicit fact wins), drops things that are clearly stale, and rewrites survivors as crisp durable lessons. Call it occasionally (e.g. after a long session, or when you notice conflicting memories) — not every turn. Returns how many memories were consolidated and the resulting lessons.",
  inputSchema: {
    type: "object",
    properties: {
      focus: {
        type: "string",
        description:
          "Optional theme to focus the reflection on (e.g. 'tone preferences', 'project context'). If omitted, reflects across all memories.",
      },
    },
  },
};

export type MemorySaveInput = {
  key: string;
  value: string;
  importance?: number;
  tags?: string[];
};

export type MemoryReflectInput = {
  focus?: string;
};

export type MemoryReflectResult = {
  status: "reflected" | "nothing_to_reflect";
  /** How many memory rows existed before the consolidation pass. */
  before: number;
  /** How many remain after dedupe/merge/drop. */
  after: number;
  /** The rewritten durable lessons the agent now holds. */
  lessons: string[];
};

export type MemorySaveResult = {
  status: "saved";
  key: string;
};

export type MemoryRecallInput = {
  tag?: string;
};

export type MemoryRecallResult = {
  memories: Array<{
    key: string;
    value: string;
    importance: number;
    tags: string[];
  }>;
};

export type MemoryForgetInput = {
  key: string;
};

export type MemoryForgetResult = {
  status: "forgotten" | "not_found";
  key: string;
};
