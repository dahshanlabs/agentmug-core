// Connection grounding — the general fix for an agent turning a BROKEN
// PRECONDITION into a question it asks you every single morning.
//
// The failure it kills: a scheduled digest agent whose Gmail connection has
// been revoked pauses on ask_user ("Gmail is disconnected — reconnect now, or
// keep sending Outlook-only digests?") on EVERY tick. That is not a
// clarification the model can act on: the answer ("reconnect it") is something
// only the human can do, outside the run, in Settings. So the run stalls, the
// next tick asks the identical question, and the "waiting for you" backlog
// grows one row per day until someone notices.
//
// The rule is simple and provider-agnostic: a missing connection is a FACT to
// state in the output, never a question to block on. Ground the model in which
// of its providers are down right now and forbid it from spending an ask_user
// on them — it should do whatever it still can with the connections it has and
// name the gap in its final answer, so the human learns about it from the
// result instead of from a stalled run.
//
// Mirror of identity-grounding / capability-grounding: pure + total (so the
// wording is unit-testable), fed by an OPTIONAL adapter method, and it travels
// with the engine to desktop/CLI unchanged.

/** One provider the agent needs but is NOT connected to right now. `capability`
 *  is an optional plain-language hint about what it's used for, so the model
 *  can describe the gap concretely ("I couldn't read Gmail"). */
export type MissingConnection = { provider: string; capability?: string };

// Defensive caps + sanitization: this builder is the reusable grounding gate,
// so it never trusts that a host's adapter already cleaned its input.
const MAX_PROVIDERS = 20;
const MAX_PROVIDER_LEN = 60;
const MAX_CAPABILITY_LEN = 120;

function clean(s: unknown, max: number): string | null {
  if (typeof s !== "string") return null;
  const t = s.replace(/\s+/g, " ").trim(); // collapse newlines/whitespace
  return t ? t.slice(0, max) : null;
}

/**
 * Build the "these connections are down" directive. Returns "" when nothing is
 * missing — the common case must add ZERO tokens to the system prompt.
 */
export function buildConnectionDirective(missing: MissingConnection[]): string {
  const seen = new Set<string>();
  const list: MissingConnection[] = [];
  for (const m of missing ?? []) {
    const provider = clean(m?.provider, MAX_PROVIDER_LEN);
    if (!provider) continue;
    const key = provider.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const capability = clean(m?.capability, MAX_CAPABILITY_LEN);
    list.push(capability ? { provider, capability } : { provider });
    if (list.length >= MAX_PROVIDERS) break;
  }
  if (list.length === 0) return "";

  const lines = list
    .map((m) => `- ${m.provider}${m.capability ? ` — needed for: ${m.capability}` : ""}`)
    .join("\n");
  return `

## Disconnected right now (authoritative)
${lines}
These connections are DOWN for this run. Any tool that depends on them will fail — that is expected, not a mystery to investigate.

Do NOT use ask_user about them. Reconnecting is something only the account owner can do in Settings → Connections, outside this run, so asking here just stalls the run and asks again next time. Instead: do everything you still CAN with the connections that work, then state the gap plainly in your final answer (which source was unavailable and what that means for the result). Never retry a disconnected provider more than once, and never present partial results as complete.`;
}
