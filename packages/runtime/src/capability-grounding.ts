// Capability grounding — the general fix for an agent DESCRIBING tools or
// actions it cannot actually perform.
//
// An agent's system prompt is authored separately from the tools it's given
// (a wizard, a CLI flag, an imported .agent file, a later edit), so the two
// can drift: the prompt confidently orchestrates create_reminder / memory.save
// / an inbound trigger the agent was never wired with, and the model then
// "talks about" doing the task — or worse, claims it happened. The model is
// handed the real tool schemas, but a forceful authored prompt overrides that
// signal. This injects the agent's ACTUAL registered tools as authoritative
// facts plus a blanket "this is everything you can do" rule, so the model
// reconciles its instructions against ground truth on EVERY run.
//
// Mirror of identity-grounding: provider-/tool-agnostic, pure + total (so the
// wording is unit-testable), and it travels with the engine to desktop/CLI —
// the same registry that decides what runs decides what the agent may claim.

export type GroundedTool = { name: string; description?: string };

// Defensive caps so a pathological registry (or a long tool description) can't
// bloat or reshape the system prompt.
const MAX_TOOLS = 60;
const MAX_DESC_LEN = 140;

/** First sentence/clause of a tool description, whitespace-collapsed + capped.
 *  No regex lookbehind — keeps the directive portable to every runtime target
 *  (node, desktop WebView2, CLI) without depending on engine quirks. */
function firstClause(desc: unknown): string | undefined {
  if (typeof desc !== "string") return undefined;
  const t = desc.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  const m = t.match(/^[^.!?]*[.!?]/);
  const clause = m ? m[0] : t;
  return clause.slice(0, MAX_DESC_LEN);
}

/**
 * Build the authoritative "your tools" directive from the exact tools the
 * engine registered for this run. Empty/garbage-tolerant: a registry with no
 * usable tools yields the honest text-only grounding rather than an empty
 * block.
 */
export function buildCapabilityDirective(tools: GroundedTool[]): string {
  const seen = new Set<string>();
  const valid: GroundedTool[] = [];
  for (const t of tools ?? []) {
    const name = t && typeof t.name === "string" ? t.name.replace(/\s+/g, " ").trim() : "";
    if (!name || seen.has(name)) continue;
    seen.add(name);
    valid.push({ name, description: t.description });
  }
  // Defensive cap (the real catalog is well under this). If it ever trips,
  // truncation stays HONEST: the count of un-listed tools is stated so the
  // "these are the ONLY tools" wording can't contradict a registered tool.
  const ordered = valid.slice(0, MAX_TOOLS);
  const extra = valid.length - ordered.length;

  if (ordered.length === 0) {
    return `

## Your tools — you have NONE on this run
You have no action tools available. You can only reason and reply in text — you cannot send messages, create events or reminders, save data, browse, or call any API. If the instructions above describe taking such actions, do NOT claim to perform them and never report that an action happened. Explain plainly what you'd need (a connected tool) and answer with what you can: analysis and text.`;
  }

  const lines = ordered
    .map((t) => {
      const d = firstClause(t.description);
      return d ? `- ${t.name} — ${d}` : `- ${t.name}`;
    })
    .join("\n");
  const more = extra > 0 ? `\n- …and ${extra} more tool${extra === 1 ? "" : "s"} you also have` : "";

  return `

## Your tools (authoritative — this is EVERYTHING you can do)
These are the ONLY tools you have on this run:
${lines}${more}
This list is the ground truth, even when the instructions above mention other tools or capabilities. If your instructions reference a tool or action that is NOT registered for you, you do NOT have it: never pretend to call it, and never claim an action happened unless a tool you actually have performed it. Instead, use the closest tool you do have, or tell the user plainly what you can't do and what you can do instead. Only describe yourself as automatically receiving, watching, or monitoring messages or events if a tool above provides that — otherwise you act only when the user runs or messages you.`;
}

/**
 * The promises in a stored capability plan that nothing can keep.
 *
 * Lives in the RUNTIME, not the server, because every surface needs it: the
 * `.agent` file carries `blueprint.capabilityPlan`, and desktop, the CLI, the
 * self-hosted runner and quickstart each build their own persistence adapter
 * from that file. When only the cloud adapter derived refusals, every
 * off-cloud run — the entire "run it anywhere" story — executed with the
 * refusal block missing: the model saw a prompt ordering the impossible part,
 * a tool list that looked capable of it, and no instruction to refuse.
 *
 * Read defensively. capabilityPlan is written by several versions of the
 * wizard, and a worker whose plan is malformed must still RUN — it simply
 * gets no refusal block, which is the behaviour it had before this existed.
 */
export function unkeepablePromisesFromPlan(plan: unknown): string[] {
  const source = plan as
    | { resolutions?: unknown; capabilities?: { resolutions?: unknown } }
    | null;
  const list = Array.isArray(source?.resolutions)
    ? source.resolutions
    : Array.isArray(source?.capabilities?.resolutions)
      ? source.capabilities.resolutions
      : [];
  const out: string[] = [];
  for (const entry of list as Array<Record<string, unknown>>) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.status !== "unsupported") continue;
    const requirement =
      typeof entry.requirement === "string" ? entry.requirement.trim() : "";
    if (requirement) out.push(requirement);
  }
  return out;
}

/** How many sites can be named before the block stops being readable. */
const MAX_GROUNDING_URLS = 8;

/**
 * Websites this worker treats as authoritative, and the discipline that makes
 * that worth anything.
 *
 * The fetching itself already exists — fetch_url does http/https only, blocks
 * private addresses, times out, truncates and strips HTML. What was missing is
 * everything AROUND the fetch: nothing told the model these pages outrank its
 * own memory, nothing required it to say which page an answer came from, and
 * nothing stopped it answering from training data when a fetch failed.
 *
 * That last one is the dangerous case. A worker answering customers about a
 * company's prices, stock or opening hours must never improvise when the site
 * is unreachable — a plausible wrong price is worse than "I couldn't check".
 *
 * The URLs come from the worker's own `url` parameters, so each owner points
 * it at their own site and the same worker serves any company.
 */
export function buildWebGroundingDirective(urls: string[]): string {
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const raw of urls ?? []) {
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!/^https?:\/\//i.test(value)) continue;
    if (seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    clean.push(value.slice(0, 500));
    if (clean.length >= MAX_GROUNDING_URLS) break;
  }
  if (clean.length === 0) return "";
  const lines = clean.map((url) => `- ${url}`).join("\n");

  return `

## Where the facts come from
These pages are the authority for this job:
${lines}
Read them with fetch_url before answering anything about what they cover — prices, availability, offerings, hours, policies, contact details. They outrank anything you remember: your training data is older than this business's website, so a confident answer from memory is how you quote last year's price to a paying customer.

Say which page you used, by URL, whenever an answer depends on one.

If a page cannot be fetched, say so and answer only what you can support. Never fill the gap from memory and never guess a number — "I couldn't reach the site just now" is a good answer, and an invented price is not.`;
}

/** Cap so a long contract cannot crowd out the instructions themselves. */
const MAX_REFUSALS = 12;

/**
 * The promises this worker was created with that nothing here can keep.
 *
 * Creation no longer blocks: a worker with one unprovable promise still keeps
 * the other five, and its owner learns more from a real run than from a
 * refused draft. That trade is only honest if the worker itself KNOWS — an
 * uninformed model improvises, answers in chat, and implies the deed was
 * done, which is worse than the refusal it replaced.
 *
 * So the unkeepable promises travel with the worker and arrive here as hard
 * refusals: do the rest, say this part plainly, never fake it.
 */
export function buildRefusalDirective(promises: string[]): string {
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const promise of promises ?? []) {
    const text =
      typeof promise === "string" ? promise.replace(/\s+/g, " ").trim() : "";
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    clean.push(text.slice(0, 300));
  }
  if (clean.length === 0) return "";
  const ordered = clean.slice(0, MAX_REFUSALS);
  const extra = clean.length - ordered.length;
  const lines = ordered.map((promise) => `- ${promise}`).join("\n");
  const more =
    extra > 0
      ? `\n- …and ${extra} more part${extra === 1 ? "" : "s"} of this job that is also not set up`
      : "";

  return `

## Parts of this job you CANNOT do
Your owner asked for these and nothing available to you can deliver them:
${lines}${more}
Do everything else in your instructions normally. For these specific parts: never attempt them, never imply they happened, and never substitute a chat message for the action. If the work reaches one of them, say plainly which part you could not do and why, then deliver the parts you did. Being useful about the rest is the job; quietly skipping one of these, or describing it as done, is a failure.`;
}
