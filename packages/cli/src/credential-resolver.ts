// CLI credential resolver — environment-variable backed.
//
// The terminal has no OAuth dance, so a portable executor that needs a
// provider token reads it from an env var: AGENTMUG_TOKEN_<PROVIDER>,
// where <PROVIDER> is the slug upper-cased with non-alphanumerics folded
// to "_" (e.g. "google" → AGENTMUG_TOKEN_GOOGLE, "microsoft-outlook" →
// AGENTMUG_TOKEN_MICROSOFT_OUTLOOK). BYO, scriptable, CI-friendly.
// Returns null when unset so the executor raises its own "Connect X".

import type { CredentialResolver, ResolvedCredential } from "@agentmug/runtime";

export class EnvCredentialResolver implements CredentialResolver {
  async resolve(provider: string): Promise<ResolvedCredential | null> {
    const envKey = `AGENTMUG_TOKEN_${provider
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")}`;
    const token = process.env[envKey];
    if (!token) return null;
    return { accessToken: token, tokenType: "bearer" };
  }
}
