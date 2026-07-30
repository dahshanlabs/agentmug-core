// a2a.discover — find an EXTERNAL A2A agent to call, by capability.
//
// The discovery half of the open agent economy. a2a.invoke can call any
// remote A2A agent, but only if the model already knows its URL. This tool
// lets the model FIND a counterparty first: it queries AgentMug's A2A
// registry by free-text + skill + capability and returns matching agents'
// Agent Card URLs, which feed straight into a2a.invoke's `card_url`.
//
// Safety: the executor (cloud) returns ONLY entries that are both VERIFIED
// (a live card with a valid signature from a trusted issuer) AND
// egress-allowed by the operator's policy — so a discovery result can never
// steer the agent to an unverified or blocked endpoint. The registry holds
// no credentials; calling a discovered agent still resolves auth server-side
// exactly as a2a.invoke does today.
//
// Definition is portable (ships in @agentmug/runtime); the executor lives in
// the cloud (api-server/src/tools/a2a-discover-executor.ts) because it reads
// the registry database and applies the egress policy.

import type { InlineToolDefinition } from "../types";

export const a2aDiscoverDefinition: InlineToolDefinition = {
  type: "inline",
  name: "a2a.discover",
  description:
    "Discover EXTERNAL A2A agents you can call, by capability. Searches AgentMug's registry of " +
    "verified third-party (and first-party) A2A agents and returns matches with their Agent Card " +
    "URL, description, and skills. Use this BEFORE a2a.invoke when you don't already know the " +
    "remote agent's URL — e.g. 'find an agent that can translate invoices', then pass the returned " +
    "`card_url` into a2a.invoke. Only verified, callable agents are returned. Returns an empty list " +
    "when nothing matches; prefer a dedicated native tool when one exists.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "What you need the remote agent to do, in plain language (e.g. 'translate a document', 'look up a CRM contact'). Matched against agent names, descriptions, and skills.",
      },
      skill: {
        type: "string",
        description:
          "Optional: narrow to agents advertising a specific skill name/id (substring match).",
      },
      capability: {
        type: "string",
        description:
          "Optional: require an A2A capability flag, e.g. 'streaming'. Only agents whose card advertises it are returned.",
      },
      limit: {
        type: "number",
        description: "Max results to return. Default 10, clamped to [1, 25].",
      },
    },
    required: ["query"],
  },
};

/** One discovered agent (no secrets; card_url feeds a2a.invoke). */
export type A2aDiscoverMatch = {
  name: string;
  /** Short slug for the Connect flow (provider key a2a:<slug>). */
  slug: string;
  /** The Agent Card URL — pass this to a2a.invoke's card_url. */
  card_url: string;
  description: string;
  /** Skill names the remote advertises — tells you what it can do. */
  skills: string[];
  /** First-party AgentMug, a public community submission, etc. */
  source: string;
  /** True when invoking it needs a connected key (most authed remotes). */
  requires_auth: boolean;
};

export type A2aDiscoverInput = {
  query: string;
  skill?: string;
  capability?: string;
  limit?: number;
};

export type A2aDiscoverResult = {
  status: "completed";
  /** Matching verified, callable agents (possibly empty). */
  matches: A2aDiscoverMatch[];
  /** How many matched (== matches.length; explicit for the model). */
  count: number;
};
