// code.execute — sandboxed code execution for agents that need to
// process data, do non-trivial math, build charts, parse files.
//
// The DEFINITION is portable and lives here. The EXECUTOR lives in
// the cloud (api-server/src/tools/code-execute-executor.ts) where it
// has the API key + network access to drive an external sandbox
// (E2B by default). The desktop runtime can later ship its own
// executor backed by a local docker container.
//
// Why a real sandbox and not Node's `vm` module: vm is a JS-only,
// not-truly-secure isolation primitive. Real agent workloads need
// Python + scientific libs (pandas, numpy, matplotlib) AND need
// guaranteed isolation from the host. External sandboxes (E2B,
// Modal, Daytona) solve both.
//
// User-facing presentation: friendlyToolLabel() in the dashboard
// renders this as "🔬 Analyzing your data" — non-devs shouldn't see
// the word "Python" unless they go looking. This matches the
// strategic positioning: powerful as a coding agent under the hood,
// simple to end users.

import type { InlineToolDefinition } from "../types";

export const codeExecuteDefinition: InlineToolDefinition = {
  type: "inline",
  name: "code.execute",
  description:
    "Run Python code in a sandboxed environment to analyze data, do math, parse files, or build charts. Pre-installed: pandas, numpy, matplotlib, scipy, scikit-learn, beautifulsoup4, requests, openpyxl. Use this whenever the task involves transforming structured data, computing aggregates, or producing files (CSV/JSON/PNG). Returns stdout, stderr, and any generated files. Each call runs in a fresh sandbox — state does not persist between calls unless you pass `keepAlive: true` and reuse the returned `sessionId`.",
  inputSchema: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description:
          "Python source code to execute. Top-level `print()` calls become the stdout return. Use matplotlib for charts — figures are auto-captured and returned as base64 PNG files.",
      },
      sessionId: {
        type: "string",
        description:
          "Optional. Reuse a sandbox from a previous call (when keepAlive was set). Lets the agent build up state across multiple code blocks like a notebook.",
      },
      keepAlive: {
        type: "boolean",
        description:
          "If true, the sandbox is kept warm for ~5 minutes after this call and `sessionId` is returned for the next call. Default false (sandbox is torn down after execution).",
      },
      timeoutMs: {
        type: "number",
        description:
          "Max wall-clock time for the execution in milliseconds. Default 30000 (30s). Hard cap 120000 (2 minutes).",
      },
    },
    required: ["code"],
  },
};

export type CodeExecuteInput = {
  code: string;
  sessionId?: string;
  keepAlive?: boolean;
  timeoutMs?: number;
};

export type CodeExecuteResult = {
  /** stdout text */
  stdout: string;
  /** stderr text (empty if no errors) */
  stderr: string;
  /** True if the code raised an exception */
  error: boolean;
  /**
   * Files produced by the code, keyed by filename. Each value is
   * the base64-encoded bytes. matplotlib figures appear here as
   * `figure_<n>.png`.
   */
  files?: Record<string, string>;
  /** Wall-clock ms the execution took. */
  durationMs: number;
  /** Set when keepAlive=true; pass on the next call to reuse state. */
  sessionId?: string;
};
