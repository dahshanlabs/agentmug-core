// @agentmug/mcp-bridge — exposes one AgentMug agent as a Model
// Context Protocol (MCP) tool over stdio.
//
// Usage from Claude Desktop / Claude Code (.claude/settings.json):
//
//   {
//     "mcpServers": {
//       "my-email-assistant": {
//         "command": "npx",
//         "args": [
//           "-y",
//           "@agentmug/mcp-bridge",
//           "https://agentmug.com/api/external/agents/<AGENT_ID>"
//         ],
//         "env": { "AGENTMUG_API_KEY": "am_agent_..." }
//       }
//     }
//   }
//
// The bridge speaks JSON-RPC 2.0 MCP over stdin/stdout. When the
// host (Claude Desktop / Cursor / Continue / Cline) lists tools, we
// return ONE tool — the AgentMug agent — derived from the agent's
// manifest endpoint. When the host calls it, we forward the call to
// the AgentMug invoke endpoint with the user's API key and return
// the agent's output as a text block.
//
// All AgentMug-side complexity (OAuth tokens, tool execution,
// persistence, billing, memory, etc.) lives behind the HTTP API.
// This bridge is a 200-line glue layer — the AgentMug runtime
// stays the source of truth and external tools never need to know
// about it.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "0.3.0";
const MAX_MANIFEST_BYTES = 1_000_000;
const MAX_STREAM_TEXT_CHARS = 2_000_000;
const MAX_RECORDED_TOOL_CALLS = 2_000;
const REQUEST_TIMEOUT_MS = 30_000;

type SourceRequirementSummary = {
  id: string;
  role: string;
  kind: string;
  label: string;
  required: boolean;
  access?: string;
  freshness?: string;
};

type SourceSetupSummary = {
  ready: boolean;
  requirements: SourceRequirementSummary[];
  missing: string[];
  stale: string[];
};

type RunReceiptSummary = {
  version?: 1;
  id?: string;
  runId: string;
  agentId?: string;
  status?: "succeeded" | "failed" | "cancelled" | "paused";
  startedAt?: string;
  completedAt?: string;
  reads?: Array<{
    sourceId: string;
    revision?: {
      id?: string;
      etag?: string;
      modifiedAt?: string;
      contentHash?: string;
    };
    evidence?: Array<Record<string, unknown>>;
    chunkCount: number;
  }>;
  writes?: Array<{
    sourceId: string;
    operation?: "write" | "append" | "create" | "delete";
    status?: "applied" | "rejected" | "failed";
    diffSummary?: string;
  }>;
  approvals?: Array<{
    action?: string;
    decision?: "approved" | "rejected";
    decidedAt?: string;
  }>;
  evaluations?: Array<{
    checkId?: string;
    status?: "passed" | "failed" | "skipped";
    score?: number;
  }>;
  output?: { mediaType?: string; contentHash?: string };
  error?: { code?: string; message?: string };
};

export type ReliabilityRunSummary = {
  id: string;
  agentId: string;
  trigger: "manual" | "release_gate" | "external";
  status: "running" | "completed" | "failed";
  blueprintVersion?: number;
  aggregateScore?: number;
  passRate?: number;
  casesRun: number;
  error?: string;
  durationMs?: number;
  startedAt: string;
  completedAt?: string;
  createdAt: string;
};

export type ReliabilitySummary = {
  safeSimulation: true;
  caseCount: number;
  canRun: boolean;
  latestRun: ReliabilityRunSummary | null;
  history: ReliabilityRunSummary[];
  privacy: string;
};

/**
 * What the AgentMug manifest endpoint returns. Mirrors the shape
 * of the public hosted-agent manifest endpoint.
 */
export type AgentManifest = {
  id: string;
  name: string;
  description: string;
  architecture: string;
  model: string;
  tool: {
    name: string;
    description: string;
    input_schema: Tool["inputSchema"];
  };
  endpoint: string;
  /**
   * Secret-free source contract + readiness only. Actual provider ids, paths,
   * filenames, cursors, account ids, and content are private bindings and MUST
   * never be returned by this endpoint.
   */
  sources?: SourceSetupSummary;
  /**
   * Summary scores only. Private regression inputs, expected outputs,
   * assertions, and detailed trajectories never cross the MCP boundary.
   */
  reliability?: ReliabilitySummary;
};

export type AgentInvocationResult = {
  runId: string;
  status: "completed" | "failed" | "paused";
  output: string;
  text: string;
  toolCalls: Array<{ name: string; ok: boolean }>;
  totalTokens: number;
  costCents: number;
  latencyMs: number;
  receipt?: RunReceiptSummary;
};

function die(message: string): never {
  process.stderr.write(`agentmug-mcp-bridge: ${message}\n`);
  process.exit(1);
}

/**
 * Resolve the agent URL from argv + env. We accept either:
 *   - A full manifest URL: https://host/api/external/agents/<id>
 *   - Just the agent id (with AGENTMUG_HOST env)
 *
 * The API key MUST come from env (AGENTMUG_API_KEY) — never argv,
 * because argv ends up in process listings and shell history.
 */
function resolveConfig(): {
  manifestUrl: string;
  invokeUrl: string;
  streamUrl: string;
  reliabilityCheckUrl: string;
  apiKey: string;
} {
  const argv = process.argv.slice(2);
  const arg = argv.find((a) => !a.startsWith("--")) ?? "";
  if (!arg) {
    die(
      "Usage: agentmug-mcp-bridge <agent-url-or-id>\n" +
        "Set AGENTMUG_API_KEY in the env. Set AGENTMUG_HOST if you pass\n" +
        "only an agent id rather than a full URL.",
    );
  }

  const apiKey = process.env.AGENTMUG_API_KEY?.trim();
  if (!apiKey) {
    die("AGENTMUG_API_KEY env var is required.");
  }

  let manifestUrl: string;
  if (/^https?:\/\//.test(arg)) {
    manifestUrl = validateManifestUrl(arg);
  } else {
    const host = process.env.AGENTMUG_HOST ?? "https://agentmug.com";
    manifestUrl = validateManifestUrl(
      `${host.replace(/\/$/, "")}/api/external/agents/${encodeURIComponent(arg)}`,
    );
  }

  return {
    manifestUrl,
    invokeUrl: `${manifestUrl}/invoke`,
    // Streaming endpoint — the bridge consumes SSE so long agent
    // runs (60-90s) don't hit the MCP host's request timeout.
    streamUrl: `${manifestUrl}/invoke/stream`,
    reliabilityCheckUrl: `${manifestUrl}/reliability/check`,
    apiKey,
  };
}

function validateManifestUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    die("Agent URL is not a valid URL.");
  }
  if (parsed.username || parsed.password) {
    die("Agent URL must not contain credentials. Use AGENTMUG_API_KEY.");
  }
  if (parsed.search || parsed.hash) {
    die("Agent URL must not contain a query string or fragment.");
  }
  const local =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "::1";
  if (
    parsed.protocol !== "https:" &&
    !(
      parsed.protocol === "http:" &&
      local &&
      process.env.AGENTMUG_ALLOW_INSECURE_LOCALHOST === "1"
    )
  ) {
    die(
      "Agent URL must use HTTPS. For local development only, set " +
        "AGENTMUG_ALLOW_INSECURE_LOCALHOST=1 and use localhost.",
    );
  }
  if (
    !/\/api\/external\/agents\/[^/]+$/.test(parsed.pathname.replace(/\/$/, ""))
  ) {
    die("Agent URL must point to /api/external/agents/<agent-id>.");
  }
  return parsed.toString().replace(/\/$/, "");
}

async function readBoundedResponse(
  res: Response,
  limit: number,
  label: string,
): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > limit) {
    throw new Error(
      `${label} exceeded the ${limit.toLocaleString()} byte limit.`,
    );
  }
  const text = await res.text();
  if (Buffer.byteLength(text, "utf8") > limit) {
    throw new Error(
      `${label} exceeded the ${limit.toLocaleString()} byte limit.`,
    );
  }
  return text;
}

async function fetchManifest(
  url: string,
  apiKey: string,
): Promise<AgentManifest> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await readBoundedResponse(
      res,
      MAX_MANIFEST_BYTES,
      "Manifest error response",
    ).catch(() => "");
    throw new Error(
      `Failed to load agent manifest from ${url} (HTTP ${res.status}): ${body.slice(0, 200)}`,
    );
  }
  let json: AgentManifest;
  try {
    json = JSON.parse(
      await readBoundedResponse(res, MAX_MANIFEST_BYTES, "Agent manifest"),
    ) as AgentManifest;
  } catch (error) {
    throw new Error(
      `Manifest at ${url} was not valid bounded JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!json?.tool?.name || !json?.tool?.input_schema) {
    throw new Error(`Manifest at ${url} is missing tool definition.`);
  }
  if (json.sources) {
    if (
      typeof json.sources.ready !== "boolean" ||
      !Array.isArray(json.sources.requirements) ||
      !Array.isArray(json.sources.missing) ||
      !Array.isArray(json.sources.stale)
    ) {
      throw new Error(
        `Manifest at ${url} has an invalid source setup summary.`,
      );
    }
  }
  if (json.reliability) {
    if (
      json.reliability.safeSimulation !== true ||
      !Number.isInteger(json.reliability.caseCount) ||
      typeof json.reliability.canRun !== "boolean" ||
      !Array.isArray(json.reliability.history) ||
      typeof json.reliability.privacy !== "string"
    ) {
      throw new Error(`Manifest at ${url} has an invalid reliability summary.`);
    }
  }
  return json;
}

export async function runReliabilityCheck(
  url: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ReliabilityRunSummary> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
    redirect: "error",
    signal: AbortSignal.timeout(5 * 60_000),
  });
  const body = await readBoundedResponse(
    res,
    MAX_MANIFEST_BYTES,
    res.ok ? "Reliability result" : "Reliability error response",
  ).catch(() => "");
  if (!res.ok) {
    throw new Error(
      `AgentMug reliability check failed (HTTP ${res.status}): ${body.slice(0, 400)}`,
    );
  }
  try {
    const parsed = JSON.parse(body) as ReliabilityRunSummary;
    const expectedAgentId = decodeURIComponent(
      new URL(url).pathname.split("/").filter(Boolean).at(-3) ?? "",
    );
    const validScore = (value: unknown, maximum: number): boolean =>
      value === undefined ||
      (typeof value === "number" &&
        Number.isFinite(value) &&
        value >= 0 &&
        value <= maximum);
    if (
      typeof parsed?.id !== "string" ||
      typeof parsed.agentId !== "string" ||
      parsed.agentId !== expectedAgentId ||
      !["manual", "release_gate", "external"].includes(parsed.trigger) ||
      !["running", "completed", "failed"].includes(parsed.status) ||
      !Number.isInteger(parsed.casesRun) ||
      parsed.casesRun < 0 ||
      parsed.casesRun > 20 ||
      !validScore(parsed.aggregateScore, 100) ||
      !validScore(parsed.passRate, 1) ||
      (parsed.durationMs !== undefined &&
        (!Number.isFinite(parsed.durationMs) || parsed.durationMs < 0)) ||
      typeof parsed.startedAt !== "string" ||
      typeof parsed.createdAt !== "string"
    ) {
      throw new Error("Reliability result has an invalid summary shape.");
    }
    return {
      id: parsed.id,
      agentId: parsed.agentId,
      trigger: parsed.trigger,
      status: parsed.status,
      blueprintVersion: parsed.blueprintVersion,
      aggregateScore: parsed.aggregateScore,
      passRate: parsed.passRate,
      casesRun: parsed.casesRun,
      error:
        parsed.status === "failed"
          ? "Reliability check failed safely."
          : undefined,
      durationMs: parsed.durationMs,
      startedAt: parsed.startedAt,
      completedAt: parsed.completedAt,
      createdAt: parsed.createdAt,
    };
  } catch (error) {
    throw new Error(
      `Reliability result was not valid bounded JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function invokeAgent(
  config: { invokeUrl: string; streamUrl: string; apiKey: string },
  args: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<AgentInvocationResult> {
  // The MCP tool's only required field is `message`. Pass it through
  // verbatim; AgentMug treats it as the user input for this turn.
  const message =
    typeof args.message === "string" ? args.message : JSON.stringify(args);

  // Prefer the streaming endpoint: data flows continuously so the MCP
  // host's request timer keeps resetting and long agent runs don't
  // time out (the synchronous /invoke could hang for the full 60-90s
  // with no bytes). We accumulate the SSE EngineEvents and resolve
  // from the terminal `done` frame.
  const res = await fetchImpl(config.streamUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
      Accept: "text/event-stream",
    },
    body: JSON.stringify({ message }),
    redirect: "error",
  });

  // If the streaming endpoint isn't available (older deploy), fall
  // back to the synchronous one.
  if (res.status === 404) {
    return invokeSync(config.invokeUrl, config.apiKey, message, fetchImpl);
  }
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `AgentMug invoke failed (HTTP ${res.status}): ${body.slice(0, 400)}`,
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const toolCalls: AgentInvocationResult["toolCalls"] = [];
  let text = "";
  const inFlight = new Map<string, string>();
  let done: AgentInvocationResult | null = null;
  const consumeLine = (line: string): void => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload) return;
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(payload);
    } catch {
      return;
    }
    if (evt.type === "token" && typeof evt.content === "string") {
      if (text.length < MAX_STREAM_TEXT_CHARS) {
        text += evt.content.slice(0, MAX_STREAM_TEXT_CHARS - text.length);
      }
      return;
    }
    if (evt.type === "tool_start" && typeof evt.id === "string") {
      inFlight.set(evt.id, String(evt.name ?? "tool"));
      return;
    }
    if (evt.type === "tool_complete" && typeof evt.id === "string") {
      if (toolCalls.length < MAX_RECORDED_TOOL_CALLS) {
        toolCalls.push({
          name: String(evt.name ?? inFlight.get(evt.id) ?? "tool"),
          ok: Boolean(evt.ok),
        });
      }
      inFlight.delete(evt.id);
      return;
    }
    if (evt.type === "done") {
      done = {
        runId: String(evt.runId ?? ""),
        status:
          evt.status === "failed" || evt.status === "paused"
            ? evt.status
            : "completed",
        output: String(evt.output ?? text),
        text,
        toolCalls,
        totalTokens: Number(evt.totalTokens ?? 0),
        costCents: Number(evt.costCents ?? 0),
        latencyMs: Number(evt.latencyMs ?? 0),
        ...(evt.receipt && typeof evt.receipt === "object"
          ? { receipt: evt.receipt as RunReceiptSummary }
          : {}),
      };
      return;
    }
    if (evt.type === "error") {
      throw new Error(
        `AgentMug run error: ${String(evt.message ?? "unknown")}`,
      );
    }
  };

  while (true) {
    const { value, chunkDone } = await reader
      .read()
      .then((r) => ({ value: r.value, chunkDone: r.done }));
    if (chunkDone) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split(/\r?\n/);
    buffer = frames.pop() ?? "";
    for (const line of frames) {
      consumeLine(line);
    }
  }

  buffer += decoder.decode();
  for (const line of buffer.split(/\r?\n/)) consumeLine(line);
  if (done) return done;
  // A partial stream is not proof of a completed run.
  throw new Error(
    "AgentMug stream ended without a terminal run status. Partial output was discarded.",
  );
}

async function invokeSync(
  invokeUrl: string,
  apiKey: string,
  message: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AgentInvocationResult> {
  const res = await fetchImpl(invokeUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ message }),
    redirect: "error",
    signal: AbortSignal.timeout(5 * 60_000),
  });
  if (!res.ok) {
    const body = await readBoundedResponse(
      res,
      MAX_MANIFEST_BYTES,
      "Invoke error response",
    ).catch(() => "");
    throw new Error(
      `AgentMug invoke failed (HTTP ${res.status}): ${body.slice(0, 400)}`,
    );
  }
  return JSON.parse(
    await readBoundedResponse(res, MAX_STREAM_TEXT_CHARS, "Invoke response"),
  ) as AgentInvocationResult;
}

/**
 * Format the AgentMug result as MCP content blocks. We always
 * include the final output as text; if any tools were called, we
 * append a compact list so the host LLM can see what happened
 * (useful for follow-up reasoning).
 */
function formatResult(result: AgentInvocationResult): string {
  const parts: string[] = [];
  if (result.output) {
    parts.push(result.output);
  } else if (result.text) {
    parts.push(result.text);
  }
  if (result.toolCalls && result.toolCalls.length > 0) {
    const lines = result.toolCalls
      .map((c) => `  - ${c.name} ${c.ok ? "✓" : "✗"}`)
      .join("\n");
    parts.push(`\n---\nTools used (${result.toolCalls.length}):\n${lines}`);
  }
  if (result.status === "failed") {
    parts.push(
      `\n[run failed — see https://agentmug.com/runs/${result.runId} for details]`,
    );
  } else if (result.status === "paused") {
    parts.push(
      `\n[agent paused waiting for user input — open https://agentmug.com/runs/${result.runId} to resume]`,
    );
  }
  if (result.receipt) {
    const reads = result.receipt.reads?.length ?? 0;
    const writes = result.receipt.writes?.length ?? 0;
    const approvals = result.receipt.approvals?.length ?? 0;
    parts.push(
      `\n[receipt ${result.receipt.runId || result.runId}: ${reads} source read${reads === 1 ? "" : "s"}, ${writes} write${writes === 1 ? "" : "s"}, ${approvals} approval record${approvals === 1 ? "" : "s"}]`,
    );
  }
  return parts.join("");
}

function sourceContractText(manifest: AgentManifest): string {
  const sources = manifest.sources ?? {
    ready: true,
    requirements: [],
    missing: [],
    stale: [],
  };
  return JSON.stringify(
    {
      agent: {
        id: manifest.id,
        name: manifest.name,
      },
      sourceContract: sources,
      privacy:
        "This is a requirement/readiness summary only. Private source locators, filenames, account ids, cursors, and content are intentionally excluded.",
    },
    null,
    2,
  );
}

function reliabilityText(manifest: AgentManifest): string {
  const reliability = manifest.reliability;
  const publicRun = (run: ReliabilityRunSummary | null) =>
    run
      ? {
          id: run.id,
          agentId: run.agentId,
          trigger: run.trigger,
          status: run.status,
          blueprintVersion: run.blueprintVersion,
          aggregateScore: run.aggregateScore,
          passRate: run.passRate,
          casesRun: run.casesRun,
          error:
            run.status === "failed"
              ? "Reliability check failed safely."
              : undefined,
          durationMs: run.durationMs,
          startedAt: run.startedAt,
          completedAt: run.completedAt,
          createdAt: run.createdAt,
        }
      : null;
  return JSON.stringify(
    {
      agent: {
        id: manifest.id,
        name: manifest.name,
      },
      reliability: reliability
        ? {
            safeSimulation: true,
            caseCount: reliability.caseCount,
            canRun: reliability.canRun,
            latestRun: publicRun(reliability.latestRun),
            history: reliability.history.map((run) => publicRun(run)),
            privacy: reliability.privacy,
          }
        : {
            safeSimulation: true,
            caseCount: 0,
            canRun: false,
            latestRun: null,
            history: [],
            privacy:
              "Private regression inputs and detailed trajectories stay in AgentMug.",
          },
    },
    null,
    2,
  );
}

function reliabilityResultText(run: ReliabilityRunSummary): string {
  if (run.status !== "completed") {
    return `Reliability check ${run.status}. No live tools were called.`;
  }
  const score =
    typeof run.aggregateScore === "number"
      ? `${Math.round(run.aggregateScore)}% score`
      : "score unavailable";
  const passRate =
    typeof run.passRate === "number"
      ? `${Math.round(run.passRate * 100)}% pass rate`
      : "pass rate unavailable";
  return `Reliability check completed: ${score}, ${passRate}, ${run.casesRun} case${run.casesRun === 1 ? "" : "s"}. Safe simulation was used; no live tools were called.`;
}

function sourceSetupBlockers(manifest: AgentManifest): string[] {
  if (!manifest.sources) return [];
  return [...new Set([...manifest.sources.missing, ...manifest.sources.stale])];
}

function sourceSetupReady(manifest: AgentManifest): boolean {
  return (
    !manifest.sources ||
    (manifest.sources.ready && sourceSetupBlockers(manifest).length === 0)
  );
}

export function createBridgeRequestHandlers(options: {
  initialManifest: AgentManifest;
  loadManifest: () => Promise<AgentManifest>;
  invoke: (args: Record<string, unknown>) => Promise<AgentInvocationResult>;
  runReliability?: () => Promise<ReliabilityRunSummary>;
}) {
  let manifest = options.initialManifest;
  const initialAgentId = manifest.id;
  const initialToolName = manifest.tool.name;
  const sourceUri = `agentmug://agents/${encodeURIComponent(initialAgentId)}/source-contract`;
  const receiptUri = `agentmug://agents/${encodeURIComponent(initialAgentId)}/latest-run-receipt`;
  const reliabilityUri = `agentmug://agents/${encodeURIComponent(initialAgentId)}/reliability`;
  // Keep the derived control tool within the common MCP 64-character bound.
  const reliabilityToolName = `${initialToolName.slice(0, 52)}_safe_check`;
  let latestReceipt: RunReceiptSummary | null = null;

  const refreshManifest = async (): Promise<AgentManifest> => {
    const fresh = await options.loadManifest();
    if (fresh.id !== initialAgentId || fresh.tool.name !== initialToolName) {
      throw new Error(
        "Agent identity or tool name changed. Restart the MCP bridge to accept the new contract.",
      );
    }
    manifest = fresh;
    return fresh;
  };

  return {
    currentManifest: () => manifest,

    async listTools() {
      const current = await refreshManifest();
      return {
        tools: [
          {
            name: current.tool.name,
            description: [
              current.tool.description,
              current.sources
                ? sourceSetupReady(current)
                  ? "Required private sources are ready."
                  : `Source setup is incomplete: ${
                      sourceSetupBlockers(current).join(", ") ||
                      "open the source contract resource for details"
                    }.`
                : "",
            ]
              .filter(Boolean)
              .join(" "),
            inputSchema: current.tool.input_schema,
          } satisfies Tool,
          ...(current.reliability && options.runReliability
            ? [
                {
                  name: reliabilityToolName,
                  description:
                    "Run this worker's owner-private regression suite in safe simulation. This spends model tokens, never calls live tools, and returns summary scores without exposing private test cases.",
                  inputSchema: {
                    type: "object" as const,
                    properties: {},
                    additionalProperties: false,
                  },
                } satisfies Tool,
              ]
            : []),
        ],
      };
    },

    async listResources() {
      const current = await refreshManifest();
      return {
        resources: [
          {
            uri: sourceUri,
            name: `${current.name} source contract`,
            description:
              "Secret-free source requirements and current readiness. Private locators and content never cross MCP.",
            mimeType: "application/json",
          },
          ...(current.reliability
            ? [
                {
                  uri: reliabilityUri,
                  name: `${current.name} reliability`,
                  description:
                    "Secret-free safe-simulation scores and recent check history. Private test cases stay in AgentMug.",
                  mimeType: "application/json",
                },
              ]
            : []),
          ...(latestReceipt
            ? [
                {
                  uri: receiptUri,
                  name: `${current.name} latest run receipt`,
                  description:
                    "Evidence, writes, approvals, and evaluations recorded for the latest run through this bridge.",
                  mimeType: "application/json",
                },
              ]
            : []),
        ],
      };
    },

    async readResource(uri: string) {
      const current = await refreshManifest();
      if (uri === sourceUri) {
        return {
          contents: [
            {
              uri: sourceUri,
              mimeType: "application/json",
              text: sourceContractText(current),
            },
          ],
        };
      }
      if (uri === reliabilityUri && current.reliability) {
        return {
          contents: [
            {
              uri: reliabilityUri,
              mimeType: "application/json",
              text: reliabilityText(current),
            },
          ],
        };
      }
      if (uri === receiptUri && latestReceipt) {
        return {
          contents: [
            {
              uri: receiptUri,
              mimeType: "application/json",
              text: JSON.stringify(latestReceipt, null, 2),
            },
          ],
        };
      }
      throw new Error(`Unknown resource: ${uri}`);
    },

    async callTool(name: string, args: Record<string, unknown>) {
      try {
        const current = await refreshManifest();
        if (name === reliabilityToolName) {
          if (!current.reliability || !options.runReliability) {
            throw new Error(
              "Reliability checking is not available for this worker.",
            );
          }
          const result = await options.runReliability();
          return {
            content: [
              { type: "text" as const, text: reliabilityResultText(result) },
            ],
            structuredContent: {
              safeSimulation: true,
              run: result,
              privacy: current.reliability.privacy,
            },
            isError: result.status === "failed",
          };
        }
        if (name !== current.tool.name) {
          throw new Error(`Unknown tool: ${name}`);
        }
        if (!sourceSetupReady(current)) {
          const blockers = sourceSetupBlockers(current);
          throw new Error(
            `Required private sources are not ready: ${blockers.join(", ") || "open the source contract resource"}.`,
          );
        }
        const result = await options.invoke(args);
        latestReceipt = result.receipt ?? {
          runId: result.runId,
        };
        return {
          content: [{ type: "text" as const, text: formatResult(result) }],
          structuredContent: {
            runId: result.runId,
            status: result.status,
            output: result.output || result.text,
            receipt: latestReceipt,
          },
          isError: result.status === "failed",
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: message }],
          isError: true,
        };
      }
    },
  };
}

async function main(): Promise<void> {
  const config = resolveConfig();
  const manifest = await fetchManifest(config.manifestUrl, config.apiKey);
  const handlers = createBridgeRequestHandlers({
    initialManifest: manifest,
    loadManifest: () => fetchManifest(config.manifestUrl, config.apiKey),
    invoke: (args) => invokeAgent(config, args),
    runReliability: () =>
      runReliabilityCheck(config.reliabilityCheckUrl, config.apiKey),
  });

  const server = new Server(
    {
      name: `agentmug-${manifest.tool.name}`,
      version: VERSION,
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    },
  );

  // ListTools — return the single AgentMug agent as a callable tool.
  // The agent's name + description + input_schema all come from the
  // manifest, so adding a new agent to AgentMug is a no-op here.
  server.setRequestHandler(ListToolsRequestSchema, () => handlers.listTools());

  server.setRequestHandler(ListResourcesRequestSchema, () =>
    handlers.listResources(),
  );

  server.setRequestHandler(ReadResourceRequestSchema, (request) =>
    handlers.readResource(request.params.uri),
  );

  // CallTool — forward to the AgentMug invoke endpoint and return
  // the agent's output as text content. Errors surface to the MCP
  // host as an isError response so the host LLM can recover.
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    handlers.callTool(request.params.name, request.params.arguments ?? {}),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // The server runs until stdin closes. Log a startup line to
  // stderr so the MCP host's logs show the bridge is alive.
  process.stderr.write(
    `agentmug-mcp-bridge v${VERSION} ready — agent "${manifest.name}" exposed as tool "${manifest.tool.name}"\n`,
  );
}

function isEntrypoint(): boolean {
  return Boolean(
    process.argv[1] &&
    resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)),
  );
}

if (isEntrypoint()) {
  main().catch((err) => {
    const message =
      err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`agentmug-mcp-bridge: fatal: ${message}\n`);
    process.exit(1);
  });
}
