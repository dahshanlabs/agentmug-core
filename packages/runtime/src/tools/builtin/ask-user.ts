// ask_user — agent pauses mid-run, surfaces a question to the
// user, resumes when the user answers.
//
// The Anthropic-Workbench / Cursor-clarify pattern. Without it,
// agents have to guess when the user's input is ambiguous; with it,
// they pause and ask instead of producing wrong output confidently.
//
// Mechanism: the executor signals the engine via
// ToolExecutionContext.pauseForUser. The engine catches the signal,
// persists conversation state to agent_runs.paused_state, sets the
// run status to "paused", and returns control to the SSE caller.
// POST /api/runs/:runId/answer revives the run with the answer
// patched in as the tool_result for this call's tool_use_id.
//
// The executor itself returns a placeholder result that the engine
// REPLACES on resume — we just need to satisfy the LLM's expectation
// that every tool_use has a tool_result so the loop stays coherent
// if the resume path doesn't fire (e.g. user abandons).

import type { InlineToolDefinition } from "../types";

export const askUserDefinition: InlineToolDefinition = {
  type: "inline",
  name: "ask_user",
  description:
    "Pause and ask the user a clarifying question. Use this when the request is ambiguous or you're missing a key piece of information you can't infer. The run pauses, the question appears in the dashboard, the user answers, and you resume with their answer as the tool result. PREFER ask_user OVER making confident guesses about important details (which person? which date? which file? which email?). DON'T ask trivial confirmations the user already implied. After resuming, use a sufficient answer immediately. If the answer is incomplete or doesn't resolve the question, ask again with a sharper question or better choices instead of guessing or pretending the task is finished.",
  inputSchema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description:
          "The question to ask. Make it specific and answerable in one sentence. Bad: 'What do you want?'. Good: 'Which Sarah do you mean — Sarah Chen (engineering) or Sarah Patel (marketing)?'.",
      },
      hint: {
        type: "string",
        description:
          "Optional. A short hint shown next to the question in the dashboard — e.g. 'paste a URL', 'YYYY-MM-DD', or 'their full email'.",
      },
      options: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional. 2–5 suggested answers shown as one-tap quick-pick buttons (the user can still type their own). Provide these whenever the answer is a choice from a known set — e.g. ['Sarah Chen (engineering)', 'Sarah Patel (marketing)'] or ['Yes, send it', 'No, draft only'].",
      },
      allowOther: {
        type: "boolean",
        description:
          "Optional, defaults to true. Set false only when options are exhaustive and any other answer would be invalid (for example an explicit approval choice). The run stays paused when the user submits an unlisted answer.",
      },
    },
    required: ["question"],
  },
};

export type AskUserInput = {
  question: string;
  hint?: string;
  options?: string[];
  allowOther?: boolean;
};

/**
 * The placeholder the executor returns when the run isn't resumed.
 * On a normal pause→resume, the engine replaces this with the
 * actual user answer before the LLM ever sees it.
 */
export type AskUserResult = {
  status: "paused" | "answered";
  question: string;
  answer?: string;
};
