// Identity grounding — the general fix for the agent GUESSING identities.
//
// Agents used to fabricate emails/accounts (labeling a Gmail digest with a
// sibling Outlook address, mixing up FROM/TO) because the system prompt had NO
// authoritative record of who the agent is connected to — so the model
// pattern-matched a plausible-looking address. This injects the agent's real
// connected accounts as authoritative facts + a blanket "never fabricate an
// identity" rule. Provider-agnostic and tool-agnostic: it flows from the
// account bindings, so a new provider is grounded automatically with zero
// per-tool code. Pure + total so the wording is unit-testable and travels with
// the engine to desktop/CLI.

import type { ConnectedAccount } from "./adapters/persistence";

// Defensive caps + sanitization so a malformed or oversized label can't bloat
// or reshape the system prompt. This builder is the reusable grounding gate —
// any host's adapter feeds it, so it never trusts the input is already clean.
const MAX_PROVIDERS = 20;
const MAX_ACCOUNTS_PER_PROVIDER = 10;
const MAX_LABEL_LEN = 120;

function cleanLabel(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const t = s.replace(/\s+/g, " ").trim(); // collapse newlines/whitespace
  return t ? t.slice(0, MAX_LABEL_LEN) : null;
}

export function buildIdentityDirective(accounts: ConnectedAccount[]): string {
  const list = (accounts ?? [])
    .map((a) => {
      if (!a || typeof a.provider !== "string" || !a.provider.trim()) return null;
      const labels = (Array.isArray(a.accounts) ? a.accounts : [])
        .map(cleanLabel)
        .filter((x): x is string => x !== null)
        .slice(0, MAX_ACCOUNTS_PER_PROVIDER);
      return labels.length > 0
        ? { provider: a.provider.replace(/\s+/g, " ").trim(), accounts: labels }
        : null;
    })
    .filter((x): x is { provider: string; accounts: string[] } => x !== null)
    .slice(0, MAX_PROVIDERS);
  if (list.length === 0) {
    // No concrete accounts to ground — still forbid fabrication outright.
    return `

## Identities — never fabricate
Never invent, infer, or guess an email address, account name, phone number, or any identity. Use ONLY what your tools actually return. If you don't have it, say you don't — do not pattern-match a plausible-looking one.`;
  }
  const lines = list.map((a) => `- ${a.provider}: ${a.accounts.join(", ")}`).join("\n");
  return `

## Your connected accounts (authoritative — NEVER guess these)
${lines}
When you name an email address, account, phone number, or identity, use ONLY this list and what your tools actually return — never invent, infer, or copy one from a different account. If it isn't here and no tool returned it, say you don't have it rather than guessing.`;
}
