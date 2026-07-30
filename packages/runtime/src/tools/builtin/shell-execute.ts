// shell.execute — run a shell command on the user's machine.
//
// THE wedge. Cloud agents (ChatGPT, Lindy, Stack AI) physically
// can't do this — they live in someone else's container, with no
// access to the user's filesystem, dev tools, processes, or local
// network. AgentMug Desktop can, because it runs IN the user's
// Tauri shell, with the user's permission, against the user's
// own LLM key.
//
// Security model: this tool is INTENTIONALLY portable across
// runtimes but only ACTUALLY runs on Desktop. The cloud-side
// executor refuses every call with an "install AgentMug Desktop"
// explanation, so a .agent file declaring shell.execute still
// loads cleanly in the cloud — the user just can't run it there.
// On Desktop, each call shows a native approval dialog ("Allow
// `<command>`? Reason: …") before the shell ever sees the string.
// Approved calls are appended to a local audit log so the user
// can review what was done.
//
// The `reason` field is required precisely because it's what the
// user sees in the approval dialog. An agent that supplies a
// vague reason will train its user to deny it.

import type { InlineToolDefinition } from "../types";

export const shellExecuteDefinition: InlineToolDefinition = {
  type: "inline",
  name: "shell.execute",
  description:
    "Run a shell command on the user's local machine and return its stdout, stderr, and exit code. ONLY available when the agent is running on AgentMug Desktop — the cloud refuses every call and returns an install link. Every command requires explicit user approval via a native dialog showing the `command` and your `reason`. Use this for: inspecting the filesystem (`ls`, `pwd`, `git status`), reading files (`cat`, `type`), running tests / lints / builds, running git commands, anything diagnostic. AVOID destructive commands without first explaining what you'll do and getting confirmation in chat. Prefer small, scoped commands you can explain over one giant pipeline.",
  inputSchema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description:
          "The exact command string to run. Examples: `git status`, `ls -la src/`, `npm test`. On Windows the command runs under PowerShell; on macOS/Linux it runs under /bin/sh. Quote arguments that contain spaces.",
      },
      reason: {
        type: "string",
        description:
          "One short sentence the user will see in the approval dialog explaining WHY you need to run this. A vague reason will get denied. Good: 'List the files in src/ so I can find the auth module.' Bad: 'I need to check something.'",
      },
      cwd: {
        type: "string",
        description:
          "Optional. Working directory the command runs in. Defaults to the user's home directory if omitted. Pass an absolute path.",
      },
    },
    required: ["command", "reason"],
  },
};

export type ShellExecuteInput = {
  command: string;
  reason: string;
  cwd?: string;
};

/**
 * Result shape both desktop and cloud executors return. The LLM
 * is told to inspect `status` first; `denied_by_user` and
 * `refused` are normal flow control, not errors, so the agent can
 * recover gracefully (apologize, try a smaller command, or ask
 * the user why they denied it).
 */
export type ShellExecuteResult =
  | {
      status: "ok" | "error";
      exit_code: number;
      stdout: string;
      stderr: string;
      cwd?: string;
    }
  | {
      // The user interrupted THIS command (not the whole run) to apply queued
      // steering — interrupt-to-steer. Partial output is returned plus `note`,
      // which tells the agent to abandon the command and follow the new guidance
      // folded into the next user turn. Distinct from denied_by_user (a hard
      // approval "no") and from a run abort (which fails the whole run).
      status: "interrupted";
      exit_code: number;
      stdout: string;
      stderr: string;
      note: string;
    }
  | {
      status: "denied_by_user";
      reason: string;
    }
  | {
      status: "refused";
      reason: string;
      install_url: string;
    };
