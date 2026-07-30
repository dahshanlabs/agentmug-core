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
