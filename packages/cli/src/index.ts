// agentmug CLI — the fourth runtime.
//
// Cloud (api-server), Desktop (Tauri), now Terminal. Same engine,
// same .agent format. Lets any shell script, cron job, GitHub
// Action, or *other agent* invoke an AgentMug agent as a tool:
//
//   agentmug run morning-brief.agent --input "today's news"
//   echo "Hello" | agentmug run translator.agent --stdin
//   cat news.txt | agentmug run summarize.agent --stdin --json
//
// The CLI is intentionally minimal: load file, wire Node adapters,
// run, print. Tools that need local resources (create_reminder
// writing to an .ics file) take their target path via a flag.

import { readFile, writeFile, access } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { stdin } from "node:process";
import {
  runAgent,
  createMultiLlmClientFromEnv,
  detectProvider,
  OPENAI_COMPAT_PROVIDERS,
  NATIVE_PROVIDERS,
  InMemoryToolRegistry,
  registerCoreToolsFor,
  registerPortableManagerTools,
  registerWebhookTools,
  normalizeTools,
  saveSkillDefinition,
  useSkillDefinition,
  SaveSkillExecutor,
  UseSkillExecutor,
  createLlmSkillVerifier,
  brainRememberDefinition,
  brainLookupDefinition,
  BrainRememberExecutor,
  BrainLookupExecutor,
  buildBrainIndex,
  createReminderDefinition,
  twilioSendSmsDefinition,
  twilioSendWhatsappDefinition,
  telegramSendMessageDefinition,
  discordSendMessageDefinition,
  slackSendMessageDefinition,
  parseAgentFile,
  getRequiredCredentials,
  getScheduleTriggers,
  unsupportedTriggers,
  CLI_CAPABILITIES,
  type AgentFileV1,
  type AgentRecord,
  type BlueprintRecord,
  type CreateReminderInput,
  type LlmCallTrace,
  type NewRun,
  type PersistenceAdapter,
  type RunCompletion,
  type RunFailure,
  type ToolExecutionContext,
  type ToolExecutor,
  type TracingAdapter,
  type TranscriptionTrace,
  type ReminderInput,
  type ReminderResult,
  type ReminderContext,
  type RemindersAdapter,
  prepareSourceExecution,
} from "@agentmug/runtime";
import { FileAgentFileStore } from "./agent-file-store.js";
import { FileAgentFolderStore } from "./agent-folder-store.js";

/**
 * The env var whose key is required to run a given model, or null when the
 * provider can't be determined from the id (unknown → a local/custom endpoint
 * via AGENTMUG_CUSTOM_BASE_URL, or OpenRouter via a 'vendor/model' id; the
 * MultiLlmClient throws a precise error at run time if none is configured).
 */
function requiredProviderEnvVar(model: string): string | null {
  const p = detectProvider(model);
  if (p === "anthropic") return NATIVE_PROVIDERS.anthropic.envKey;
  if (p === "openai") return NATIVE_PROVIDERS.openai.envKey;
  if (p === "gemini") return NATIVE_PROVIDERS.gemini.envKey;
  if (p && p in OPENAI_COMPAT_PROVIDERS) {
    return OPENAI_COMPAT_PROVIDERS[p as keyof typeof OPENAI_COMPAT_PROVIDERS]
      .envKey;
  }
  return null;
}
import { EnvCredentialResolver } from "./credential-resolver.js";
import { loadConfig, apiRequest, streamSse } from "./lib/api-client.js";
import {
  CliTwilioSendSmsExecutor,
  CliTwilioSendWhatsappExecutor,
  CliTelegramSendMessageExecutor,
  CliDiscordSendMessageExecutor,
  CliSlackSendMessageExecutor,
} from "./tools/connectors.js";
import {
  bindCliSource,
  cliSourceStatuses,
  countBlockingSourceItems,
  prepareCliSources,
  sourceReadinessErrorLines,
  unbindCliSource,
} from "./source-host.js";
import { CliReceiptStore, CliSourceBindingStore } from "./source-state.js";
import { terminalSafeOneLine } from "./terminal-safety.js";
import {
  evaluationCounts,
  formatCloudReliabilityRun,
  formatCloudReliabilitySummary,
  type CloudReliabilityRun,
  type CloudReliabilitySummary,
} from "./reliability.js";

const HELP = `agentmug — run AgentMug agents from the terminal

Available now (v0.1):
  agentmug run <path-to-.agent> --input "<text>"         Run with inline text
  agentmug run <path-to-.agent> --stdin                  Read input from stdin
  agentmug run <path-to-.agent> --input-file <path>      Read input from file
  agentmug check <path-to-.agent>                        Setup check: what the agent
                                                         needs vs what THIS machine has
                                                         (read-only, never runs the agent;
                                                         exit 1 if anything is missing)

Private grounded sources (requirements travel; local paths never enter .agent):
  agentmug sources list <agent>                         Show required and optional sources
  agentmug sources bind <agent> <source-id> <path>      Bind a local file/folder/workspace
                  [--approve]                           Explicitly approve an on-bind read
  agentmug sources unbind <agent> <source-id>           Remove only this machine's binding
  agentmug sources check <agent>                        Inspect readiness without running

Private grounding receipts:
  agentmug receipts list <agent>                        List this machine's saved receipts
  agentmug receipts get <agent> <run-id>                Inspect one saved receipt
  agentmug receipts delete <agent> <run-id>             Explicitly remove one receipt

Cloud (agent-controllable surface — set AGENTMUG_API_KEY):
  agentmug create --prompt "..."                         Create a Claude-designed agent on agentmug.com
  agentmug list                                          List agents in your account
  agentmug get <agent-id>                                Show agent details
  agentmug fork <agent-id> [--as <new-name>]             Fork an existing agent
  agentmug invoke <agent-id> --input "..." [--stream]    Invoke a cloud-hosted agent
  agentmug edit <agent-id> [--system-prompt "..."]       Improve an agent's blueprint
                [--add-tool X] [--remove-tool Y] [--model M]
  agentmug key new --agent <agent-id>                    Mint a per-agent API key
  agentmug reliability status <agent-id>                 Inspect secret-free hosted scores
  agentmug reliability check <agent-id>                  Run the hosted safe-simulation suite

Options (run):
  --anthropic-key <key>   Override env ANTHROPIC_API_KEY
  --reminders-file <path> Where create_reminder writes VEVENTs (default ./agentmug-reminders.ics)
  --json                  Emit the final response as JSON instead of plain text
  --quiet                 Suppress streaming tokens (only print final output)
  -h, --help              Show this help

Environment:
  Inference keys (bring your own — the CLI calls the provider directly, keys
  never leave the machine; set the one matching your agent's model):
    ANTHROPIC_API_KEY   Claude models (claude-*)          [or --anthropic-key]
    OPENAI_API_KEY      OpenAI models (gpt-*, o1/o3/o4)
    GEMINI_API_KEY      Google Gemini (gemini-*)
    DEEPSEEK_API_KEY    DeepSeek (deepseek-*)     ZHIPU_API_KEY     GLM (glm-*)
    MOONSHOT_API_KEY    Kimi (kimi-*)             DASHSCOPE_API_KEY Qwen (qwen*)
    XAI_API_KEY         Grok (grok-*)             MISTRAL_API_KEY   Mistral (mistral-*)
    MINIMAX_API_KEY     MiniMax (minimax*)        OPENROUTER_API_KEY  vendor/model ids
  Local / self-hosted (Ollama, LM Studio, vLLM — OpenAI-compatible):
    AGENTMUG_CUSTOM_BASE_URL   e.g. http://localhost:11434/v1
    AGENTMUG_CUSTOM_MODELS     comma list, e.g. llama3.1,qwen2.5-coder  (or use a local/ id)
    AGENTMUG_CUSTOM_API_KEY    optional (most local servers need none)
  AGENTMUG_HOST           For cloud subcommands (default https://agentmug.com)
  AGENTMUG_API_KEY        For cloud subcommands (mint at agentmug.com → Settings → API)
  AGENTMUG_STATE_DIR      Override private local bindings/receipts directory
  Key scope: account commands require am_user_; invoke and reliability also
             accept an am_agent_ key scoped to that hosted worker.

Connector credentials (optional — only when the agent uses these tools):
  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER   twilio.send_sms / send_whatsapp
  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID                        telegram.send_message
  DISCORD_WEBHOOK_URL                                         discord.send_message
  SLACK_BOT_TOKEN                                             slack.send_message

Examples:
  agentmug sources bind finance.agent invoices ./private/Invoices.xlsx
  agentmug sources check finance.agent
  agentmug run my.agent --input "Remind me to file taxes tomorrow"
  echo "Translate to Arabic: Hello world" | agentmug run translate.agent --stdin
  agentmug run news-brief.agent --input "tech" --json | jq .response`;

type CliArgs = {
  command:
    | "run"
    | "check"
    | "help"
    | "create"
    | "list"
    | "get"
    | "fork"
    | "invoke"
    | "edit"
    | "key"
    | "sources"
    | "receipts"
    | "reliability";
  /** Subcommand for noun-style commands like `key new` and `sources bind`. */
  subcommand?: string;
  /** Positional arguments after command/subcommand, in original order. */
  positionals: string[];
  /** First positional argument after the command (agent path, agent id, etc.). */
  positional?: string;
  agentPath?: string;
  input?: string;
  inputFile?: string;
  useStdin: boolean;
  anthropicKey?: string;
  remindersFile: string;
  json: boolean;
  quiet: boolean;
  /** Free-form flags collected for cloud subcommands. */
  flags: Record<string, string | boolean>;
};

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: "help",
    useStdin: false,
    remindersFile: "./agentmug-reminders.ics",
    json: false,
    quiet: false,
    flags: {},
    positionals: [],
  };
  if (argv[0] === "-h" || argv[0] === "--help" || argv.length === 0) {
    return args;
  }

  const cmd = argv[0];
  const knownCommands: CliArgs["command"][] = [
    "run",
    "check",
    "create",
    "list",
    "get",
    "fork",
    "invoke",
    "edit",
    "key",
    "sources",
    "receipts",
    "reliability",
    "help",
  ];
  if (!knownCommands.includes(cmd as CliArgs["command"])) {
    throw new Error(`Unknown command: ${cmd}\n\n${HELP}`);
  }
  args.command = cmd as CliArgs["command"];

  let positionalStart = 1;
  // Compound commands like `key new` consume an extra positional
  // before flag parsing begins.
  if (
    cmd === "key" ||
    cmd === "sources" ||
    cmd === "receipts" ||
    cmd === "reliability"
  ) {
    args.subcommand = argv[1];
    positionalStart = 2;
  }

  for (let i = positionalStart; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--input") args.input = argv[++i];
    else if (a === "--input-file") args.inputFile = argv[++i];
    else if (a === "--stdin") args.useStdin = true;
    else if (a === "--anthropic-key") args.anthropicKey = argv[++i];
    else if (a === "--reminders-file") args.remindersFile = argv[++i];
    else if (a === "--json") args.json = true;
    else if (a === "--quiet") args.quiet = true;
    else if (a === "-h" || a === "--help") {
      args.command = "help";
      return args;
    } else if (a.startsWith("--")) {
      // Generic flag — value follows unless next arg is another flag.
      const flagName = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args.flags[flagName] = true;
      } else {
        args.flags[flagName] = next;
        i += 1;
      }
    } else {
      args.positionals.push(a);
    }
  }

  args.positional = args.positionals[0];
  if (
    cmd === "run" ||
    cmd === "check" ||
    cmd === "sources" ||
    cmd === "receipts"
  ) {
    args.agentPath = args.positionals[0];
  }
  if ((cmd === "run" || cmd === "check") && !args.agentPath) {
    throw new Error("Missing path to .agent file");
  }
  if (cmd === "sources") {
    if (!["bind", "list", "unbind", "check"].includes(args.subcommand ?? "")) {
      throw new Error(
        "Use one of: agentmug sources bind|list|unbind|check <path-to-.agent>",
      );
    }
    if (!args.agentPath) {
      throw new Error("Missing path to .agent file");
    }
  }
  if (cmd === "receipts") {
    if (!["list", "get", "delete"].includes(args.subcommand ?? "")) {
      throw new Error(
        "Use one of: agentmug receipts list|get|delete <path-to-.agent> [run-id]",
      );
    }
    if (!args.agentPath) {
      throw new Error("Missing path to .agent file");
    }
  }
  if (cmd === "reliability") {
    if (!["status", "check"].includes(args.subcommand ?? "")) {
      throw new Error(
        "Use one of: agentmug reliability status|check <agent-id>",
      );
    }
    if (!args.positional) {
      throw new Error("Missing hosted agent id");
    }
  }
  return args;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function resolveInput(args: CliArgs): Promise<string> {
  if (args.useStdin) return (await readStdin()).trim();
  if (args.inputFile) return (await readFile(args.inputFile, "utf8")).trim();
  if (typeof args.input === "string") return args.input;
  throw new Error("Provide one of --input, --input-file, or --stdin");
}

async function loadAgentFile(path: string): Promise<AgentFileV1> {
  let raw: string;
  try {
    raw = await readFile(resolvePath(path), "utf8");
  } catch (err) {
    throw new Error(
      `Could not read agent file ${path}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`Agent file ${path} is not valid JSON`);
  }
  return parseAgentFile(json);
}

/** In-memory persistence backed by the loaded .agent file. */
class FileAgentPersistence implements PersistenceAdapter {
  private runs = new Map<
    string,
    NewRun & Partial<RunCompletion & RunFailure>
  >();
  constructor(private agentFile: AgentFileV1) {}
  async getAgent(id: string): Promise<AgentRecord | null> {
    if (id !== this.agentFile.id) return null;
    return {
      id: this.agentFile.id,
      name: this.agentFile.name,
      description: this.agentFile.description,
    };
  }
  async getLatestBlueprint(agentId: string): Promise<BlueprintRecord | null> {
    if (agentId !== this.agentFile.id) return null;
    return {
      systemPrompt: this.agentFile.blueprint.systemPrompt,
      primaryModel: this.agentFile.blueprint.primaryModel,
      maxTokens: this.agentFile.blueprint.maxTokens ?? null,
      evaluation: this.agentFile.evaluation,
      // Carry the side-effect gate so the injection backstop holds off-cloud.
      guardrails: this.agentFile.blueprint.guardrails,
    };
  }
  async createRun(run: NewRun): Promise<void> {
    this.runs.set(run.id, { ...run });
  }
  async completeRun(update: RunCompletion): Promise<void> {
    const existing = this.runs.get(update.id);
    if (existing) this.runs.set(update.id, { ...existing, ...update });
  }
  async failRun(update: RunFailure): Promise<void> {
    const existing = this.runs.get(update.id);
    if (existing) this.runs.set(update.id, { ...existing, ...update });
  }
  async incrementAgentRunCount(_agentId: string): Promise<void> {
    /* no-op for CLI */
  }
}

/** Silent tracing — the CLI surfaces output directly. */
class SilentTracing implements TracingAdapter {
  async recordLlmCall(_event: LlmCallTrace): Promise<void> {}
  async recordTranscription(_event: TranscriptionTrace): Promise<void> {}
}

/** Appends VEVENT blocks to a local .ics file. Same iCal output as
 * the desktop runtime — the cron-friendly twin. */
class IcsFileRemindersAdapter implements RemindersAdapter {
  constructor(private path: string) {}
  async createReminder(
    input: ReminderInput,
    _ctx: ReminderContext,
  ): Promise<ReminderResult> {
    const uid = `${Date.now()}-${Math.random().toString(36).slice(2)}@agentmug-cli`;
    const vevent = buildVevent(uid, input);

    let existing = "";
    try {
      await access(this.path);
      existing = await readFile(this.path, "utf8");
    } catch {
      existing = "";
    }

    let next: string;
    if (
      existing.includes("BEGIN:VCALENDAR") &&
      existing.includes("END:VCALENDAR")
    ) {
      next = existing.replace(
        /END:VCALENDAR\s*$/i,
        `${vevent}\r\nEND:VCALENDAR\r\n`,
      );
    } else {
      next = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//AgentMug CLI//Reminders 1.0//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "X-WR-CALNAME:AgentMug CLI Reminders",
        vevent,
        "END:VCALENDAR",
        "",
      ].join("\r\n");
    }

    await writeFile(this.path, next, "utf8");
    return { id: uid, provider: "cli-ics" };
  }
}

class CliCreateReminderExecutor implements ToolExecutor {
  constructor(private sink: RemindersAdapter) {}
  async execute(input: unknown, ctx: ToolExecutionContext): Promise<unknown> {
    const parsed = (input ?? {}) as Partial<CreateReminderInput>;
    if (
      !parsed.title ||
      typeof parsed.title !== "string" ||
      !parsed.title.trim()
    ) {
      throw new Error("create_reminder requires a non-empty title");
    }
    const result = await this.sink.createReminder(
      {
        title: parsed.title.trim(),
        dueDate: parsed.due_date,
        priority: parsed.priority,
        notes: parsed.notes,
      },
      ctx,
    );
    return {
      id: result.id,
      status: "created" as const,
      title: parsed.title.trim(),
    };
  }
}

// ── agentmug check — Phase C: replay the connectivity contract locally ──
//
// Read-only and NEVER runs the agent (the CLI is an unattended runner; a
// setup check that fired the agent would be the opposite of consent). It
// answers one question honestly: "if I `agentmug run` this file on THIS
// machine, what will work, what won't, and what do I set to fix it?"
//
// Three honest tiers, never conflated:
//   ✓ present    — the env var/key this machine needs is set
//   ✗ missing    — with the EXACT env var name to set
//   ⚠ unproven   — creds present but only a real round-trip proves delivery;
//                  that lives on cloud (Verify), not here — we say so.
async function sourceCommand(args: CliArgs): Promise<number> {
  const file = await loadAgentFile(args.agentPath!);
  const store = new CliSourceBindingStore();
  const sourceId =
    args.positionals[1] ??
    (typeof args.flags.source === "string" ? args.flags.source : undefined);

  if (args.subcommand === "bind") {
    const targetPath =
      args.positionals[2] ??
      (typeof args.flags.path === "string" ? args.flags.path : undefined);
    if (!sourceId || !targetPath) {
      process.stderr.write(
        "agentmug sources bind <agent> <source-id> <local-path>\n",
      );
      return 2;
    }
    const status = await bindCliSource(
      args.agentPath!,
      file,
      sourceId,
      targetPath,
      { store, approved: args.flags.approve === true },
    );
    if (args.json) {
      process.stdout.write(
        `${JSON.stringify({ action: "bound", source: status }, null, 2)}\n`,
      );
    } else {
      process.stdout.write(
        `Bound '${terminalSafeOneLine(status.label)}' to ` +
          `${terminalSafeOneLine(status.displayName ?? "a private local source")}.\n` +
          "The local path stays in this CLI's private state and was not written to the .agent file.\n",
      );
    }
    return 0;
  }

  if (args.subcommand === "unbind") {
    if (!sourceId) {
      process.stderr.write("agentmug sources unbind <agent> <source-id>\n");
      return 2;
    }
    const removed = await unbindCliSource(
      args.agentPath!,
      file,
      sourceId,
      store,
    );
    if (args.json) {
      process.stdout.write(
        `${JSON.stringify({ action: "unbound", sourceId, removed }, null, 2)}\n`,
      );
    } else {
      process.stdout.write(
        removed
          ? `Removed this machine's private binding for '${terminalSafeOneLine(sourceId)}'.\n`
          : `No private binding exists for '${terminalSafeOneLine(sourceId)}'.\n`,
      );
    }
    return 0;
  }

  const prepared = await prepareCliSources(args.agentPath!, file, { store });
  const statuses = cliSourceStatuses(file, prepared);
  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ready: prepared.ready,
          sources: statuses,
        },
        null,
        2,
      )}\n`,
    );
  } else if ((file.sources?.length ?? 0) === 0) {
    process.stdout.write(
      `${terminalSafeOneLine(file.name)} declares no grounded source requirements.\n`,
    );
  } else {
    process.stdout.write(
      `${terminalSafeOneLine(file.name)} — private source ` +
        `${args.subcommand === "check" ? "readiness" : "bindings"}\n`,
    );
    for (const line of sourceReadinessErrorLines(file, prepared)) {
      process.stdout.write(`${line}\n`);
    }
    if (args.subcommand === "list") {
      for (const status of statuses.filter((item) => item.orphaned)) {
        process.stdout.write(
          `  ⚠ ${terminalSafeOneLine(status.id)} — orphaned private binding; unbind it if no longer needed\n`,
        );
      }
    }
    process.stdout.write(
      prepared.ready
        ? "\nReady — every required source is compatible and readable.\n"
        : "\nNot ready — bind or repair the items above before running.\n",
    );
  }
  return args.subcommand === "check" && !prepared.ready ? 1 : 0;
}

async function receiptsCommand(args: CliArgs): Promise<number> {
  const file = await loadAgentFile(args.agentPath!);
  const store = new CliReceiptStore(args.agentPath!, file.id, {
    agent: file,
  });
  const runId = args.positionals[1];
  if (args.subcommand === "list") {
    const receipts = await store.listSaved();
    const summaries = receipts.map((receipt) => ({
      id: receipt.id,
      runId: receipt.runId,
      status: receipt.status,
      startedAt: receipt.startedAt,
      completedAt: receipt.completedAt,
      sourceReads: receipt.reads.length,
      sourceWrites: receipt.writes.length,
      evaluations: evaluationCounts(receipt.evaluations),
      agentVersion: receipt.agentVersion,
      sourceAuthorityFingerprint: receipt.metadata?.sourceAuthorityFingerprint,
      receiptPersistence: receipt.metadata?.receiptPersistence,
    }));
    if (args.json) {
      process.stdout.write(
        `${JSON.stringify({ receipts: summaries }, null, 2)}\n`,
      );
    } else if (summaries.length === 0) {
      process.stdout.write("No local run receipts are saved for this agent.\n");
    } else {
      for (const receipt of summaries) {
        process.stdout.write(
          `${terminalSafeOneLine(receipt.runId)}  ` +
            `${terminalSafeOneLine(receipt.status, 50)}  ` +
            `${terminalSafeOneLine(receipt.completedAt ?? receipt.startedAt, 100)}  ` +
            `${receipt.sourceReads} read(s), ${receipt.sourceWrites} write(s), ` +
            `${receipt.evaluations.passed} check(s) passed, ${receipt.evaluations.failed} failed, ${receipt.evaluations.skipped} skipped\n`,
        );
      }
    }
    return 0;
  }

  if (!runId) {
    process.stderr.write(
      `agentmug receipts ${args.subcommand} <agent> <run-id>\n`,
    );
    return 2;
  }
  if (args.subcommand === "delete") {
    const removed = await store.remove(runId);
    if (args.json) {
      process.stdout.write(
        `${JSON.stringify({ action: "deleted", runId, removed }, null, 2)}\n`,
      );
    } else {
      process.stdout.write(
        removed
          ? `Deleted private receipt '${terminalSafeOneLine(runId)}'.\n`
          : `No private receipt exists for '${terminalSafeOneLine(runId)}'.\n`,
      );
    }
    return removed ? 0 : 1;
  }

  const receipt = await store.get(runId);
  if (!receipt) {
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ receipt: null }, null, 2)}\n`);
    } else {
      process.stdout.write(
        `No private receipt exists for '${terminalSafeOneLine(runId)}'.\n`,
      );
    }
    return 1;
  }
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ receipt }, null, 2)}\n`);
  } else {
    process.stdout.write(
      `Receipt ${terminalSafeOneLine(receipt.id)}\n` +
        `  run: ${terminalSafeOneLine(receipt.runId)}\n` +
        `  status: ${terminalSafeOneLine(receipt.status, 50)}\n` +
        `  agent version: ${terminalSafeOneLine(receipt.agentVersion ?? "unknown", 100)}\n` +
        `  source reads: ${receipt.reads.length}\n` +
        `  source writes: ${receipt.writes.length}\n` +
        `  approvals: ${receipt.approvals.length}\n` +
        `  portable checks: ${receipt.evaluations.length}\n` +
        receipt.evaluations
          .map(
            (evaluation) =>
              `    ${terminalSafeOneLine(evaluation.status, 20)} ${terminalSafeOneLine(evaluation.checkId, 200)}` +
              `${typeof evaluation.score === "number" ? ` (${Math.round(evaluation.score * 100)}%)` : ""}` +
              `${evaluation.message ? `: ${terminalSafeOneLine(evaluation.message, 500)}` : ""}\n`,
          )
          .join(""),
    );
  }
  return 0;
}

async function checkAgent(args: CliArgs): Promise<number> {
  const file = await loadAgentFile(args.agentPath!);
  const out = (s: string) =>
    process.stdout.write(`${terminalSafeOneLine(s, 8_000)}\n`);
  let missing = 0;

  out(`\n${file.name} — setup check (${CLI_CAPABILITIES.host} runtime)`);
  out(file.description ? `  ${file.description}\n` : "");

  // 1. Model key — the one universal requirement.
  const model = file.blueprint.primaryModel || "claude-sonnet-4-6";
  const modelEnvVar = requiredProviderEnvVar(model);
  if (modelEnvVar) {
    const configured = Boolean(
      modelEnvVar === "ANTHROPIC_API_KEY"
        ? (args.anthropicKey ?? process.env[modelEnvVar])
        : process.env[modelEnvVar],
    );
    out(
      configured
        ? `  configured: ${modelEnvVar} is set for ${model}`
        : `  missing: ${modelEnvVar} is not set for ${model}`,
    );
    if (!configured) missing++;
  } else {
    out(
      `  model: ${model}; the runtime will verify its custom endpoint or router configuration at run time`,
    );
  }

  // 2. Connector credentials — the same env conventions `run` uses. Known
  //    key-providers check their documented vars; OAuth providers check the
  //    AGENTMUG_TOKEN_<PROVIDER> convention (EnvCredentialResolver).
  const KEY_PROVIDER_VARS: Record<string, string[]> = {
    twilio: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"],
    telegram: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"],
    discord: ["DISCORD_WEBHOOK_URL"],
    slack: ["SLACK_BOT_TOKEN"],
  };
  for (const req of getRequiredCredentials(file)) {
    const vars = KEY_PROVIDER_VARS[req.provider] ?? [
      `AGENTMUG_TOKEN_${req.provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`,
    ];
    const unset = vars.filter((v) => !process.env[v]);
    if (unset.length === 0) {
      out(`  ✓ ${req.label} connected (for ${req.forTools.join(", ")})`);
    } else {
      missing++;
      out(
        `  ✗ ${req.label} — set ${unset.join(", ")} (needed by ${req.forTools.join(", ")})`,
      );
    }
  }

  // 3. Private grounded sources — inspect the actual local revision without
  //    executing the agent or copying a locator into the portable file.
  if ((file.sources?.length ?? 0) > 0) {
    const prepared = await prepareCliSources(args.agentPath!, file);
    out("");
    out("  Grounded sources:");
    for (const line of sourceReadinessErrorLines(file, prepared)) out(line);
    missing += countBlockingSourceItems(file, prepared);
  }

  if ((file.evaluation?.checks.length ?? 0) > 0) {
    const contract = file.evaluation!;
    out("");
    out(
      `  Portable checks: ${contract.checks.length}; failure policy ${contract.failurePolicy}` +
        `${contract.minimumScore === undefined ? "" : `; minimum score ${Math.round(contract.minimumScore * 100)}%`}`,
    );
    for (const check of contract.checks) {
      out(
        `    ${check.severity} ${check.name} (${check.phase}, ${check.type})`,
      );
    }
    out(
      "  These checks run in this local host and are recorded in its run receipt.",
    );
  }

  // 4. Triggers — what fires here vs what honestly can't.
  const schedules = getScheduleTriggers(file);
  for (const s of schedules) {
    out(
      `  • schedule "${s.label || s.cron}" (${s.cron}${s.timezone ? ` ${s.timezone}` : ""}) — the CLI doesn't register cron; add a crontab line calling \`agentmug run\` yourself.`,
    );
  }
  for (const u of unsupportedTriggers(file, CLI_CAPABILITIES)) {
    out(`  ⚠ ${(u.trigger as { type: string }).type} trigger: ${u.reason}`);
  }

  // 5. The declared contract — what the agent SAYS it needs to do its job.
  const c = file.connectivity;
  if (c?.delivers?.length || c?.reads?.length) {
    out("");
    for (const d of c.delivers ?? [])
      out(`  • delivers ${d.channel} to the ${d.to} via ${d.via}`);
    for (const r of c.reads ?? [])
      out(`  • reads ${r.resource} (${r.provider})`);
    out(
      "  ⚠ credentials-present is NOT delivery-proven — only a real round-trip proves the path. Run it on agentmug.com and tap Verify for an earned green.",
    );
  }

  out("");
  out(
    missing === 0
      ? "Ready to `agentmug run` — everything this machine needs is set."
      : `${missing} item(s) missing — set the variables above, then re-run \`agentmug check\`.`,
  );
  out("");
  return missing === 0 ? 0 : 1;
}

async function runCli(args: CliArgs): Promise<number> {
  if (args.command === "help") {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }

  if (args.command === "sources") return sourceCommand(args);
  if (args.command === "receipts") return receiptsCommand(args);
  if (args.command === "reliability") return cloudReliability(args);

  // Phase C: setup check — read-only, dispatched BEFORE the Anthropic-key
  // gate (checking what's missing must not itself require a key).
  if (args.command === "check") return checkAgent(args);

  // Phase 28: dispatch cloud subcommands. Each hits the
  // /api/* surface with a user-level API key (am_user_...).
  // These let an agent (or any tool with shell access) create,
  // list, fork, and invoke agents on agentmug.com programmatically.
  if (args.command === "create") return cloudCreate(args);
  if (args.command === "list") return cloudList(args);
  if (args.command === "get") return cloudGet(args);
  if (args.command === "fork") return cloudFork(args);
  if (args.command === "invoke") return cloudInvoke(args);
  if (args.command === "edit") return cloudEdit(args);
  if (args.command === "key") return cloudKey(args);

  const agentFile = await loadAgentFile(args.agentPath!);
  const sourceBindingStore = new CliSourceBindingStore();
  const sourceRuntime = await prepareCliSources(args.agentPath!, agentFile, {
    store: sourceBindingStore,
  });
  if (!sourceRuntime.ready) {
    process.stderr.write(
      "Agent source requirements are not ready:\n" +
        `${sourceReadinessErrorLines(agentFile, sourceRuntime).join("\n")}\n` +
        `Run 'agentmug sources check ${terminalSafeOneLine(args.agentPath)}' for details.\n`,
    );
    return 2;
  }
  const userInput = await resolveInput(args);
  const hasSources = (agentFile.sources?.length ?? 0) > 0;
  const hasPortableReceipt =
    hasSources || (agentFile.evaluation?.checks.length ?? 0) > 0;
  const receiptStore = hasPortableReceipt
    ? new CliReceiptStore(args.agentPath!, agentFile.id, {
        agent: agentFile,
        bindings: sourceRuntime.bindings,
      })
    : undefined;

  // BYOK for ANY provider: the agent runs on whatever its blueprint.primaryModel
  // names (Claude / GPT / DeepSeek / Qwen / GLM / Kimi / xAI / Mistral /
  // OpenRouter / a local Ollama endpoint), using the matching provider key from
  // the environment. --anthropic-key stays as a back-compat override. Keys never
  // leave the machine — the CLI calls the provider directly.
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (args.anthropicKey) env.ANTHROPIC_API_KEY = args.anthropicKey;

  // Gate on the provider the agent's model ACTUALLY needs, not always Anthropic.
  // (Mirrors the engine default when primaryModel is unset.)
  const model = agentFile.blueprint.primaryModel || "claude-sonnet-4-6";
  const neededVar = requiredProviderEnvVar(model);
  if (neededVar && !env[neededVar]) {
    process.stderr.write(
      `Agent uses model '${terminalSafeOneLine(model)}' — set ${neededVar} in the environment` +
        (neededVar === "ANTHROPIC_API_KEY"
          ? " (or pass --anthropic-key)"
          : "") +
        " and re-run.\n",
    );
    return 2;
  }

  const persistence = new FileAgentPersistence(agentFile);
  const tracing = new SilentTracing();
  const llm = createMultiLlmClientFromEnv(env);

  const registry = new InMemoryToolRegistry();
  if (agentFile.blueprint.tools.includes("create_reminder")) {
    const sink = new IcsFileRemindersAdapter(args.remindersFile);
    registry.register(
      createReminderDefinition,
      new CliCreateReminderExecutor(sink),
    );
  }

  // Connector executors — registered when the agent declares them. Each reads
  // its credentials from environment variables (TWILIO_*, TELEGRAM_*,
  // DISCORD_WEBHOOK_URL, SLACK_BOT_TOKEN) and throws a clear "set X env var"
  // message at run time if unconfigured, mirroring the cloud executors. This
  // is the tri-runtime parity: `agentmug run` now actually SENDS, not just
  // describes.
  const t = agentFile.blueprint.tools;
  if (t.includes("twilio.send_sms"))
    registry.register(twilioSendSmsDefinition, new CliTwilioSendSmsExecutor());
  if (t.includes("twilio.send_whatsapp"))
    registry.register(
      twilioSendWhatsappDefinition,
      new CliTwilioSendWhatsappExecutor(),
    );
  if (t.includes("telegram.send_message"))
    registry.register(
      telegramSendMessageDefinition,
      new CliTelegramSendMessageExecutor(),
    );
  if (t.includes("discord.send_message"))
    registry.register(
      discordSendMessageDefinition,
      new CliDiscordSendMessageExecutor(),
    );
  if (t.includes("slack.send_message"))
    registry.register(
      slackSendMessageDefinition,
      new CliSlackSendMessageExecutor(),
    );

  // First-party core tools (fetch_url, web.fetch_json, query_csv) — registered
  // straight from the runtime for any the agent declares, so a portable .agent
  // that fetches a URL, calls a JSON API, or reads a CSV runs here too instead
  // of dead-ending at "Unknown tool". No env/credentials needed.
  registerCoreToolsFor(registry, Array.isArray(t) ? (t as string[]) : []);

  // Webhook tools (blueprint refs) — portable HTTP executor, same as cloud.
  registerWebhookTools(registry, normalizeTools(agentFile));

  // Verified Self-Skilling + Agent Brain — persist into the .agent FILE so the
  // agent genuinely learns + remembers LOCALLY (no cloud), exactly like the
  // cloud loop. The store reads/writes args.agentPath; save_skill verifies via
  // the same LLM judge before keeping. Registered only for declared tools.
  const agentStore = new FileAgentFileStore(args.agentPath!);
  const verifySkill = createLlmSkillVerifier(llm);
  if (t.includes("save_skill"))
    registry.register(
      saveSkillDefinition,
      new SaveSkillExecutor(agentStore, verifySkill),
    );
  if (t.includes("use_skill"))
    registry.register(useSkillDefinition, new UseSkillExecutor(agentStore));
  if (t.includes("brain_remember"))
    registry.register(
      brainRememberDefinition,
      new BrainRememberExecutor(agentStore),
    );
  if (t.includes("brain_lookup"))
    registry.register(
      brainLookupDefinition,
      new BrainLookupExecutor(agentStore),
    );

  // Portable Manager — list_agents / create_agent / update_agent / invoke_agent
  // over the FOLDER of .agent files beside this one. A Conductor can discover,
  // spawn, repair, and dispatch its fleet locally, no server. invoke_agent runs
  // a sibling agent through runAgent recursively (core tools + connectors,
  // recursion-depth-guarded).
  const folder = new FileAgentFolderStore(args.agentPath!);
  const toolNameList = normalizeTools(agentFile).map((x) => x.name);
  registerPortableManagerTools(registry, {
    store: folder,
    tools: toolNameList,
    runSubAgent: async ({ file, path, input, parentContext }) => {
      const subRegistry = new InMemoryToolRegistry();
      const subTools = normalizeTools(file).map((x) => x.name);
      registerCoreToolsFor(subRegistry, subTools);
      if (subTools.includes("twilio.send_sms"))
        subRegistry.register(
          twilioSendSmsDefinition,
          new CliTwilioSendSmsExecutor(),
        );
      if (subTools.includes("twilio.send_whatsapp"))
        subRegistry.register(
          twilioSendWhatsappDefinition,
          new CliTwilioSendWhatsappExecutor(),
        );
      if (subTools.includes("telegram.send_message"))
        subRegistry.register(
          telegramSendMessageDefinition,
          new CliTelegramSendMessageExecutor(),
        );
      if (subTools.includes("discord.send_message"))
        subRegistry.register(
          discordSendMessageDefinition,
          new CliDiscordSendMessageExecutor(),
        );
      if (subTools.includes("slack.send_message"))
        subRegistry.register(
          slackSendMessageDefinition,
          new CliSlackSendMessageExecutor(),
        );
      // A dispatched worker uses — and writes back to — its OWN brain + skills,
      // read from its own .agent file, exactly like a top-level run. Only a real
      // file path enables that; an in-memory locator stays brain-blind so we never
      // advertise a brain_lookup the sub-registry hasn't wired.
      const workerPath = path && !path.startsWith("mem://") ? path : null;
      const workerSources = workerPath
        ? await prepareCliSources(workerPath, file, {
            store: sourceBindingStore,
            adapter: sourceRuntime.adapter,
          })
        : null;
      if (workerSources && !workerSources.ready) {
        throw new Error(
          `Worker '${file.name}' source requirements are not ready: ` +
            sourceReadinessErrorLines(file, workerSources)
              .map((line) => line.trim())
              .join(" "),
        );
      }
      if (workerPath) {
        const workerStore = new FileAgentFileStore(workerPath);
        const verifyWorkerSkill = createLlmSkillVerifier(llm);
        if (subTools.includes("save_skill"))
          subRegistry.register(
            saveSkillDefinition,
            new SaveSkillExecutor(workerStore, verifyWorkerSkill),
          );
        if (subTools.includes("use_skill"))
          subRegistry.register(
            useSkillDefinition,
            new UseSkillExecutor(workerStore),
          );
        if (subTools.includes("brain_remember"))
          subRegistry.register(
            brainRememberDefinition,
            new BrainRememberExecutor(workerStore),
          );
        if (subTools.includes("brain_lookup"))
          subRegistry.register(
            brainLookupDefinition,
            new BrainLookupExecutor(workerStore),
          );
      }
      const sub = await runAgent({
        agentId: file.id,
        userId: "cli-local",
        userInput: input,
        adapters: {
          persistence: new FileAgentPersistence(file),
          tracing,
          llm,
          credentialResolver: new EnvCredentialResolver(),
          ...((file.sources?.length || file.evaluation?.checks.length) &&
          workerPath
            ? {
                receipts: new CliReceiptStore(workerPath, file.id, {
                  agent: file,
                  bindings: workerSources?.bindings ?? [],
                }),
              }
            : {}),
        },
        tools: subRegistry,
        sources: prepareSourceExecution({
          requirements: file.sources ?? [],
          bindings: workerSources?.bindings ?? [],
          adapters: file.sources?.length ? [sourceRuntime.adapter] : [],
        }),
        evaluation: file.evaluation,
        recursionDepth: (parentContext.recursionDepth ?? 0) + 1,
        memoryContext: workerPath ? buildBrainIndex(file.brain) : "",
        // The CLI is an unattended runner (cron/CI, no human) — any approval-
        // gated tool must fail closed here too, never block on a prompt nobody
        // can answer. (No shell executor is wired today, so this is currently a
        // no-op safeguard that keeps the CLI aligned with the desktop contract.)
        unattended: true,
        onEvent: () => {
          /* sub-agent stream is summarized into the tool_result, not printed */
        },
      });
      return {
        status: sub.status === "completed" ? "completed" : "failed",
        output: sub.output,
        error: sub.status === "failed" ? sub.output : undefined,
      };
    },
  });

  // Heads up — surface the builder's caveats (how the agent adapts the request)
  // once at run start, to stderr, matching the desktop + web callout. Skipped in
  // quiet / json mode so piped output stays clean.
  const caveats = agentFile.blueprint.caveats ?? [];
  if (caveats.length > 0 && !args.quiet && !args.json) {
    process.stderr.write("⚠ Heads up — how this agent adapts your request:\n");
    for (const c of caveats) {
      process.stderr.write(
        `  • You asked: ${terminalSafeOneLine(c.requested)}\n` +
          `    It does:   ${terminalSafeOneLine(c.doing)}\n` +
          `    Why:       ${terminalSafeOneLine(c.why)}\n`,
      );
    }
    process.stderr.write("\n");
  }

  let streamed = "";
  const result = await runAgent({
    agentId: agentFile.id,
    userId: "cli-local",
    userInput,
    adapters: {
      persistence,
      tracing,
      llm,
      // Keystone parity: portable credentialed executors resolve tokens
      // from AGENTMUG_TOKEN_<PROVIDER> env vars on the CLI.
      credentialResolver: new EnvCredentialResolver(),
      ...(hasPortableReceipt
        ? {
            receipts: receiptStore,
          }
        : {}),
    },
    tools: registry,
    sources: prepareSourceExecution({
      requirements: agentFile.sources ?? [],
      bindings: sourceRuntime.bindings,
      adapters: hasSources ? [sourceRuntime.adapter] : [],
    }),
    evaluation: agentFile.evaluation,
    // The CLI is an unattended runner (cron / CI / `agentmug run`) — no human to
    // approve anything. Mark it so any approval-gated tool fails closed instead
    // of blocking on a prompt nobody can answer. (No shell executor is wired in
    // the CLI today, so this is a forward-looking safeguard that keeps the CLI
    // aligned with the desktop unattended contract.)
    unattended: true,
    // Feed the cheap brain index into the prompt so the agent knows what it has
    // recorded and can brain_lookup the full page. (The skill index already
    // lives in the system prompt, written there by save_skill.)
    memoryContext: buildBrainIndex(agentFile.brain),
    onEvent: (event) => {
      if (event.type === "token") {
        streamed += event.content;
        if (!args.quiet && !args.json) process.stdout.write(event.content);
      }
    },
  });

  if (
    hasPortableReceipt &&
    result.receipt?.metadata?.receiptPersistence === "failed" &&
    !args.json
  ) {
    process.stderr.write(
      "warning: this run completed, but its private grounding receipt was not saved. " +
        "Run 'agentmug receipts list <agent>' and explicitly delete old receipts before retrying.\n",
    );
  }

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          runId: result.runId,
          status: result.status,
          response: result.output,
          totalTokens: result.totalTokens,
          costCents: result.costCents,
          latencyMs: result.latencyMs,
          ...(hasPortableReceipt ? { receipt: result.receipt } : {}),
        },
        null,
        2,
      ) + "\n",
    );
  } else if (args.quiet) {
    process.stdout.write(result.output + "\n");
  } else {
    process.stdout.write("\n");
    if (hasPortableReceipt && result.receipt) {
      const chunks = result.receipt.reads.reduce(
        (total, read) => total + read.chunkCount,
        0,
      );
      process.stderr.write(
        `[receipt ${result.receipt.id}: ${result.receipt.reads.length} source(s), ${chunks} evidence chunk(s), ${result.receipt.writes.length} write(s), ${result.receipt.evaluations.length} portable check(s)]\n`,
      );
    }
  }
  return result.status === "completed" ? 0 : 1;
}

function buildVevent(uid: string, input: ReminderInput): string {
  const now = toIcalUtc(new Date());
  const due = input.dueDate ? new Date(input.dueDate) : null;
  const isAllDay = !due || Number.isNaN(due.getTime());
  const startDate = isAllDay ? new Date() : due!;
  const endDate = isAllDay
    ? new Date(startDate.getTime() + 24 * 60 * 60 * 1000)
    : new Date(startDate.getTime() + 30 * 60 * 1000);
  const summary = input.priority === "high" ? `🔴 ${input.title}` : input.title;
  const lines: string[] = [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${now}`,
    `CREATED:${now}`,
    `LAST-MODIFIED:${now}`,
    isAllDay
      ? `DTSTART;VALUE=DATE:${toIcalDate(startDate)}`
      : `DTSTART:${toIcalUtc(startDate)}`,
    isAllDay
      ? `DTEND;VALUE=DATE:${toIcalDate(endDate)}`
      : `DTEND:${toIcalUtc(endDate)}`,
    `SUMMARY:${escapeIcalText(summary)}`,
    "STATUS:CONFIRMED",
    `PRIORITY:${rfcPriority(input.priority)}`,
  ];
  if (input.notes && input.notes.trim()) {
    lines.push(`DESCRIPTION:${escapeIcalText(input.notes)}`);
  }
  lines.push(
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "DESCRIPTION:Reminder",
    "TRIGGER:PT0M",
    "END:VALARM",
    "END:VEVENT",
  );
  return lines.join("\r\n");
}
function rfcPriority(p?: "low" | "medium" | "high"): number {
  if (p === "high") return 1;
  if (p === "low") return 9;
  return 5;
}
function toIcalUtc(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}
function toIcalDate(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}
function escapeIcalText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;")
    .replace(/\r?\n/g, "\\n");
}

// ─── Cloud subcommands (Phase 28) ────────────────────────────────────
// These hit agentmug.com over HTTPS with a user API key. They make
// the CLI fully agent-controllable: an LLM with shell access can
// design + ship a new agent into the user's account.

type AgentRow = {
  id: string;
  name: string;
  description: string;
  primaryModel?: string;
  status?: string;
  createdAt?: string;
};

async function cloudCreate(args: CliArgs): Promise<number> {
  const prompt = typeof args.flags.prompt === "string" ? args.flags.prompt : "";
  if (!prompt) {
    process.stderr.write(
      'agentmug create requires --prompt "..." describing the agent.\n',
    );
    return 2;
  }
  const config = loadConfig();
  // POST /api/agents with { prompt } triggers Claude blueprint
  // generation server-side, just like the web wizard does.
  const result = await apiRequest<AgentRow & { warning?: string }>(
    config,
    "POST",
    "/api/agents",
    {
      prompt,
      name: typeof args.flags.name === "string" ? args.flags.name : undefined,
    },
  );
  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(
      `Created agent "${result.name}" (id: ${result.id})\n` +
        `  ${config.host}/agents/${result.id}\n`,
    );
    // Surface the server warning when Claude generation fell back to
    // a generic blueprint, so a misconfigured run isn't silent.
    if (result.warning) {
      process.stderr.write(`⚠ ${result.warning}\n`);
    }
  }
  return 0;
}

async function cloudList(args: CliArgs): Promise<number> {
  const config = loadConfig();
  const result = await apiRequest<AgentRow[]>(config, "GET", "/api/agents");
  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    if (result.length === 0) {
      process.stdout.write(
        'No agents yet. Create one:\n  agentmug create --prompt "..."\n',
      );
      return 0;
    }
    for (const a of result) {
      const model = a.primaryModel ? ` [${a.primaryModel}]` : "";
      process.stdout.write(`${a.id}  ${a.name}${model}\n`);
    }
  }
  return 0;
}

async function cloudGet(args: CliArgs): Promise<number> {
  if (!args.positional) {
    process.stderr.write("agentmug get <agent-id>\n");
    return 2;
  }
  const config = loadConfig();
  const result = await apiRequest<AgentRow>(
    config,
    "GET",
    `/api/agents/${encodeURIComponent(args.positional)}`,
  );
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  return 0;
}

async function cloudFork(args: CliArgs): Promise<number> {
  if (!args.positional) {
    process.stderr.write("agentmug fork <agent-id> [--as <new-name>]\n");
    return 2;
  }
  const config = loadConfig();
  const result = await apiRequest<{ id: string; sourceId: string }>(
    config,
    "POST",
    `/api/agents/${encodeURIComponent(args.positional)}/fork`,
    typeof args.flags.as === "string" ? { name: args.flags.as } : undefined,
  );
  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(
      `Forked ${result.sourceId} → ${result.id}\n` +
        `  ${config.host}/agents/${result.id}\n`,
    );
  }
  return 0;
}

async function cloudEdit(args: CliArgs): Promise<number> {
  if (!args.positional) {
    process.stderr.write(
      'agentmug edit <agent-id> [--system-prompt "..."] [--add-tool X] [--remove-tool Y] [--model M]\n',
    );
    return 2;
  }
  const body: Record<string, unknown> = {};
  if (typeof args.flags["system-prompt"] === "string") {
    body.systemPrompt = args.flags["system-prompt"];
  }
  if (typeof args.flags["add-tool"] === "string") {
    body.addTools = [args.flags["add-tool"]];
  }
  if (typeof args.flags["remove-tool"] === "string") {
    body.removeTools = [args.flags["remove-tool"]];
  }
  if (typeof args.flags.model === "string") {
    body.primaryModel = args.flags.model;
  }
  if (Object.keys(body).length === 0) {
    process.stderr.write(
      "Nothing to edit. Pass at least one of --system-prompt / --add-tool / --remove-tool / --model.\n",
    );
    return 2;
  }
  const config = loadConfig();
  const result = await apiRequest<{ version: number; tools: string[] }>(
    config,
    "PATCH",
    `/api/agents/${encodeURIComponent(args.positional)}/blueprint`,
    body,
  );
  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(
      `Updated ${args.positional} → blueprint v${result.version}\n` +
        `  tools: ${result.tools.join(", ") || "(none)"}\n`,
    );
  }
  return 0;
}

async function cloudInvoke(args: CliArgs): Promise<number> {
  if (!args.positional) {
    process.stderr.write('agentmug invoke <agent-id> --input "..."\n');
    return 2;
  }
  const message = await resolveInput(args).catch(() => null);
  if (!message) {
    process.stderr.write(
      'agentmug invoke requires --input "..." / --stdin / --input-file <path>.\n',
    );
    return 2;
  }
  const config = loadConfig();
  const stream = args.flags.stream === true || args.flags.stream === "true";

  if (stream) {
    // SSE path — surface tokens + tool events live. Best for
    // long-running agents in an interactive terminal.
    const events = streamSse<{
      type: string;
      content?: string;
      name?: string;
      output?: string;
      message?: string;
    }>(
      config,
      "POST",
      `/api/external/agents/${encodeURIComponent(args.positional)}/invoke/stream`,
      { message },
    );
    let final = "";
    for await (const evt of events) {
      if (evt.type === "token" && evt.content) {
        if (!args.quiet && !args.json) process.stdout.write(evt.content);
      } else if (evt.type === "tool_start") {
        if (!args.quiet && !args.json)
          process.stderr.write(`\n[${evt.name}…] `);
      } else if (evt.type === "tool_complete") {
        if (!args.quiet && !args.json) process.stderr.write(`✓ `);
      } else if (evt.type === "done") {
        final = evt.output ?? "";
        if (args.json) {
          process.stdout.write(JSON.stringify(evt, null, 2) + "\n");
        } else if (args.quiet) {
          process.stdout.write(final + "\n");
        } else {
          process.stdout.write("\n");
        }
      } else if (evt.type === "error") {
        process.stderr.write(
          `\nerror: ${terminalSafeOneLine(evt.message ?? "unknown")}\n`,
        );
        return 1;
      }
    }
    return 0;
  }

  // Synchronous path — single JSON round-trip. Best for scripts.
  const result = await apiRequest<{
    runId: string;
    status: string;
    output: string;
    totalTokens: number;
    costCents: number;
    latencyMs: number;
  }>(
    config,
    "POST",
    `/api/external/agents/${encodeURIComponent(args.positional)}/invoke`,
    { message },
  );
  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(result.output + "\n");
  }
  return result.status === "completed" ? 0 : 1;
}

async function cloudReliability(args: CliArgs): Promise<number> {
  const agentId = args.positional!;
  const config = loadConfig();
  const basePath = `/api/external/agents/${encodeURIComponent(agentId)}/reliability`;

  if (args.subcommand === "status") {
    const summary = await apiRequest<CloudReliabilitySummary>(
      config,
      "GET",
      basePath,
    );
    if (args.json) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } else {
      for (const line of formatCloudReliabilitySummary(summary)) {
        process.stdout.write(`${terminalSafeOneLine(line, 1_000)}\n`);
      }
    }
    return 0;
  }

  const run = await apiRequest<CloudReliabilityRun>(
    config,
    "POST",
    `${basePath}/check`,
  );
  if (args.json) {
    process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
  } else {
    process.stdout.write(
      "Hosted reliability check completed in safe simulation. No live tools were called.\n",
    );
    for (const line of formatCloudReliabilityRun(run)) {
      process.stdout.write(`  ${terminalSafeOneLine(line, 1_000)}\n`);
    }
    process.stdout.write(
      "  Private cases stayed in AgentMug. This result covers the hosted worker, not a locally modified .agent file.\n",
    );
  }
  return run.status === "completed" ? 0 : 1;
}

async function cloudKey(args: CliArgs): Promise<number> {
  // `agentmug key new --agent <id> [--label <text>]` mints a per-agent
  // API key. Future: `key list`, `key revoke <id>`.
  if (args.subcommand !== "new") {
    process.stderr.write(
      'agentmug key new --agent <agent-id> [--label "..."]\n',
    );
    return 2;
  }
  const agentId = typeof args.flags.agent === "string" ? args.flags.agent : "";
  if (!agentId) {
    process.stderr.write("agentmug key new requires --agent <agent-id>.\n");
    return 2;
  }
  const config = loadConfig();
  const result = await apiRequest<{
    id: string;
    key: string;
    keyPrefix: string;
  }>(config, "POST", `/api/agents/${encodeURIComponent(agentId)}/keys`, {
    label: typeof args.flags.label === "string" ? args.flags.label : undefined,
  });
  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(
      `${result.key}\n\n` + `Save this key now — it won't be shown again.\n`,
    );
  }
  return 0;
}

try {
  const exitCode = await runCli(parseArgs(process.argv.slice(2)));
  process.exit(exitCode);
} catch (err) {
  process.stderr.write(
    `agentmug: ${terminalSafeOneLine(
      err instanceof Error ? err.message : String(err),
      8_000,
    )}\n`,
  );
  process.exit(1);
}
