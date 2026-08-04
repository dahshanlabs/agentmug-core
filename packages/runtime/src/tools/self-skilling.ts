// Verified Self-Skilling — the PORTABLE executors.
//
// The cloud persists skills to Postgres; this runs the SAME loop off-cloud,
// persisting into the agent's own `.agent` file via the serializer. The agent
// genuinely learns + replays skills on the CLI/desktop, not just in the cloud.
//
// Browser-safe: NO node:fs. Persistence is a pluggable `AgentFileStore`
// (load/save an AgentFileV1) the host supplies — node:fs on the CLI, Tauri fs
// on desktop, in-memory for tests. Same pattern as the credential resolver.

import type { AgentFileV1, AgentSkill } from "../format/agent-file";
import { buildAgentFile } from "../format/agent-file";
import type { LlmClient } from "../adapters/llm";
import type {
  ToolExecutor,
  ToolExecutionContext,
  ToolRegistry,
} from "./registry";
import {
  saveSkillDefinition,
  useSkillDefinition,
  type SaveSkillInput,
  type SaveSkillResult,
  type UseSkillInput,
  type UseSkillResult,
} from "./builtin/skills";

// Limits mirror the cloud (blueprint-learn.ts) so a skill saved locally and
// one saved in the cloud obey the same bounds.
export const MAX_SKILL_RECIPE_CHARS = 4000;
export const MAX_SKILL_NAME_CHARS = 60;
export const MAX_SKILL_TRIGGER_CHARS = 200;
export const MAX_SKILLS_PER_AGENT = 60;
const DEFAULT_VERIFY_MODEL = "claude-sonnet-4-6";
const SKILLS_SECTION_HEADER = "## Skills you've learned";

// ── Persistence abstraction ────────────────────────────────────────────────

/**
 * How the self-skilling executors read + persist the agent. The host wires the
 * IO (a `.agent` file on disk for CLI/desktop, in-memory for tests) so the
 * runtime stays free of any filesystem dependency.
 */
export interface AgentFileStore {
  load(): Promise<AgentFileV1>;
  save(file: AgentFileV1): Promise<void>;
}

/** In-memory store — holds the agent file in a variable. Tests + simple hosts. */
export class InMemoryAgentFileStore implements AgentFileStore {
  constructor(private file: AgentFileV1) {}
  async load(): Promise<AgentFileV1> {
    return this.file;
  }
  async save(file: AgentFileV1): Promise<void> {
    this.file = file;
  }
  /** The current snapshot (e.g. to serialize to disk after a run). */
  current(): AgentFileV1 {
    return this.file;
  }
}

// ── Skill-index rendering (mirrors the cloud's cheap in-prompt index) ────────

export function normalizeSkillName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_SKILL_NAME_CHARS);
}

/** The always-loaded index: verified skills only, name + trigger (cheap). */
function renderSkillsIndex(skills: AgentSkill[]): string {
  const verified = skills.filter((s) => s.verified === true);
  if (verified.length === 0) return "";
  const lines = verified.map((s) => `- **${s.name}** — ${s.trigger}`).join("\n");
  return `${SKILLS_SECTION_HEADER}\nVerified skills you can reuse. When a request matches one, call use_skill with its name to load the exact steps, then follow them. Do NOT re-derive a skill from scratch.\n${lines}\n`;
}

/** Remove an existing "## …" section (header to the next "## "). */
function stripSection(prompt: string, header: string): string {
  const start = prompt.indexOf(header);
  if (start === -1) return prompt;
  const rest = prompt.slice(start + header.length);
  const nextRel = rest.indexOf("\n## ");
  if (nextRel === -1) return prompt.slice(0, start);
  const nextAbs = start + header.length + nextRel + 1;
  return prompt.slice(0, start) + prompt.slice(nextAbs);
}

/** Replace the skills index in a system prompt with a freshly rendered one. */
function upsertSkillsIndex(systemPrompt: string, skills: AgentSkill[]): string {
  const base = stripSection(systemPrompt ?? "", SKILLS_SECTION_HEADER).trimEnd();
  const index = renderSkillsIndex(skills);
  if (!index) return base ? `${base}\n` : base;
  return base ? `${base}\n\n${index}` : index;
}

// ── Verification (the keep-or-reject gate) ──────────────────────────────────

export type SkillCheck = { name: string; passed: boolean; note?: string };
export type SkillVerification = {
  status: "verified" | "unverified";
  score: number;
  checks: SkillCheck[];
  passed: number;
  total: number;
  verifiedAt: string;
  model: string;
};

/** Reviews a captured skill and decides keep-or-reject. Injected, so a host
 *  can swap the model or supply a stricter/cheaper judge. */
export type SkillVerifier = (skill: {
  name: string;
  trigger: string;
  recipe: string;
}) => Promise<SkillVerification>;

const VERIFY_SYSTEM = `You are a strict reviewer deciding whether an AI agent should PERMANENTLY save a new reusable "skill" (a captured way of doing a task). Be conservative — a skill that gets saved will be replayed on future requests, so a bad one is worse than none.

Judge ONLY these four checks:
- reusable: the steps are general enough to work again on similar FUTURE requests, not a frozen one-off that only worked for one specific input.
- trigger_clear: the "when to use" accurately and specifically describes the situations this applies to, and matches the steps.
- followable: the steps are concrete and self-contained — named tools, clear order, and what inputs are needed — so the agent could replay them.
- safe: no irreversible/destructive action without a confirmation step, and NO secrets, tokens, or credentials hard-coded into the steps.

Respond ONLY with JSON in exactly this shape:
{"checks":[{"name":"reusable","passed":true,"note":"short reason"},{"name":"trigger_clear","passed":true,"note":"short reason"},{"name":"followable","passed":true,"note":"short reason"},{"name":"safe","passed":true,"note":"short reason"}],"verdict":"verified","summary":"one sentence"}
Set verdict to "verified" only if reusable, followable, and safe all pass.`;

async function collectText(
  llm: LlmClient,
  params: { model: string; system: string; user: string; maxTokens: number },
): Promise<string> {
  let text = "";
  for await (const ev of llm.streamMessage({
    model: params.model,
    maxTokens: params.maxTokens,
    system: params.system,
    messages: [{ role: "user", content: params.user }],
  })) {
    if (ev.type === "text_delta") text += ev.text;
  }
  return text;
}

/**
 * The default verifier — an LLM-as-judge over the four checks. `verdict`
 * "verified" requires the judge to agree, the `safe` check to pass (hard
 * gate), and ≥75% of checks to pass. Identical logic to the cloud.
 */
export function createLlmSkillVerifier(
  llm: LlmClient,
  model: string = DEFAULT_VERIFY_MODEL,
): SkillVerifier {
  return async ({ name, trigger, recipe }) => {
    const text = await collectText(llm, {
      model,
      maxTokens: 700,
      system: VERIFY_SYSTEM,
      user: `SKILL NAME: ${name}\n\nWHEN TO USE: ${trigger}\n\nSTEPS / RECIPE:\n${recipe}`,
    });
    const match = text.match(/\{[\s\S]*\}/);
    let raw: { checks?: SkillCheck[]; verdict?: string } = {};
    try {
      raw = match ? JSON.parse(match[0]) : {};
    } catch {
      raw = {};
    }
    const checks: SkillCheck[] = Array.isArray(raw.checks)
      ? raw.checks
          .filter((c) => c && typeof c.name === "string")
          .map((c) => ({ name: c.name, passed: Boolean(c.passed), note: c.note }))
      : [];
    const total = checks.length;
    const passed = checks.filter((c) => c.passed).length;
    const safeOk = checks.find((c) => c.name === "safe")?.passed ?? false;
    const ok = raw.verdict === "verified" && safeOk && total > 0 && passed / total >= 0.75;
    return {
      status: ok ? "verified" : "unverified",
      score: total > 0 ? Math.round((passed / total) * 100) : 0,
      checks,
      passed,
      total,
      verifiedAt: new Date().toISOString(),
      model,
    };
  };
}

// ── Executors ───────────────────────────────────────────────────────────────

/** save_skill — verify, then persist into the .agent file (skills + index). */
export class SaveSkillExecutor implements ToolExecutor {
  constructor(
    private readonly store: AgentFileStore,
    private readonly verify: SkillVerifier,
  ) {}

  async execute(input: unknown, _ctx: ToolExecutionContext): Promise<SaveSkillResult> {
    const parsed = (input ?? {}) as Partial<SaveSkillInput>;
    const rawName = (parsed.name ?? "").trim();
    const trigger = (parsed.trigger ?? "").trim();
    const recipe = (parsed.recipe ?? "").trim();
    if (!rawName || !trigger || !recipe) {
      throw new Error("save_skill requires 'name', 'trigger', and 'recipe' (the steps to replay).");
    }
    const name = normalizeSkillName(rawName);
    if (!name) throw new Error("save_skill 'name' must contain letters or digits.");
    if (trigger.length > MAX_SKILL_TRIGGER_CHARS) {
      throw new Error(`'trigger' too long (${trigger.length}/${MAX_SKILL_TRIGGER_CHARS}).`);
    }
    if (recipe.length > MAX_SKILL_RECIPE_CHARS) {
      throw new Error(`'recipe' too long (${recipe.length}/${MAX_SKILL_RECIPE_CHARS}).`);
    }

    // VERIFY-BEFORE-KEEP — reject (don't save) if it doesn't pass.
    const verification = await this.verify({ name, trigger, recipe });
    if (verification.status !== "verified") {
      const failed = verification.checks
        .filter((c) => !c.passed)
        .map((c) => `${c.name}${c.note ? ` (${c.note})` : ""}`)
        .join("; ");
      throw new Error(
        `Skill "${name}" was NOT saved — it didn't pass verification (${verification.score}%). Issues: ${failed || "vague or one-off"}. Refine the steps/trigger and try again, or just complete the task this time.`,
      );
    }

    const file = await this.store.load();
    const existing = file.blueprint.skills ?? [];
    if (existing.length >= MAX_SKILLS_PER_AGENT && !existing.some((s) => s.name === name)) {
      throw new Error(`This agent already holds the max of ${MAX_SKILLS_PER_AGENT} skills.`);
    }
    const skill: AgentSkill = { name, trigger, recipe, verified: true };
    // Upsert by name (a re-saved skill replaces the old one).
    const nextSkills = [...existing.filter((s) => s.name !== name), skill];
    const nextFile = buildAgentFile({
      ...file,
      exportedAt: new Date().toISOString(),
      blueprint: {
        ...file.blueprint,
        skills: nextSkills,
        systemPrompt: upsertSkillsIndex(file.blueprint.systemPrompt, nextSkills),
      },
    });
    await this.store.save(nextFile);
    return {
      ok: true,
      name,
      score: verification.score,
      note: `Saved skill "${name}" (verified ${verification.score}%). It now travels with this agent and you'll see it in your skills index.`,
    };
  }
}

/** use_skill — load a saved skill's recipe from the .agent file to replay it. */
export class UseSkillExecutor implements ToolExecutor {
  constructor(private readonly store: AgentFileStore) {}

  async execute(input: unknown, _ctx: ToolExecutionContext): Promise<UseSkillResult> {
    const parsed = (input ?? {}) as Partial<UseSkillInput>;
    const want = normalizeSkillName((parsed.name ?? "").trim());
    const file = await this.store.load();
    const skills = file.blueprint.skills ?? [];
    const match = skills.find((s) => normalizeSkillName(s.name) === want);
    if (match) {
      return {
        found: true,
        name: match.name,
        trigger: match.trigger,
        recipe: match.recipe,
        verified: match.verified === true,
        note: "Follow these steps, adapting the specifics to the current request.",
      };
    }
    const available = skills.filter((s) => s.verified === true).map((s) => s.name);
    return {
      found: false,
      available,
      note: available.length
        ? `No skill named "${parsed.name}". Available: ${available.join(", ")}.`
        : `No skill named "${parsed.name}", and this agent has no saved skills yet.`,
    };
  }
}

// ── Registration helper ─────────────────────────────────────────────────────

/**
 * Wire save_skill + use_skill onto a registry with a host-supplied store +
 * verifier. One call from any runtime:
 *
 *   registerSelfSkillingSkills(registry, {
 *     store: new InMemoryAgentFileStore(agentFile),
 *     verify: createLlmSkillVerifier(llm),
 *   });
 */
export function registerSelfSkillingSkills(
  registry: ToolRegistry,
  opts: { store: AgentFileStore; verify: SkillVerifier },
): void {
  registry.register(saveSkillDefinition, new SaveSkillExecutor(opts.store, opts.verify));
  registry.register(useSkillDefinition, new UseSkillExecutor(opts.store));
}
