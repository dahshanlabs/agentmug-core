// Agent Brain — the portable tool DEFINITIONS.
//
// The agent's long-term, structured knowledge base: interlinked pages about
// the owner's world (people, accounts, preferences, recurring facts). Pages
// travel in the `.agent` file under `brain` (owner-private; only on a personal
// export). `brain_remember` records/updates a page; `brain_lookup` recalls one.
//
// Definitions live in @agentmug/runtime so any host can offer the tools; the
// portable EXECUTORS (see ../agent-brain.ts) run them off-cloud, persisting
// into the `.agent` file. The cloud has its own Postgres-backed executors.

import type { InlineToolDefinition } from "../types";

export const brainRememberDefinition: InlineToolDefinition = {
  type: "inline",
  name: "brain_remember",
  description:
    "Record or UPDATE a page in your long-term knowledge base — a durable fact about the user's world worth keeping across runs (a person, account, system, recurring preference). Re-remembering the same title UPDATES that page (and adds the new source). Use for knowledge that should persist; not for one-off task details.",
  inputSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description:
          "The page title — the entity or topic, e.g. 'Acme Corp' or 'Billing preferences'. Re-using a title updates that page.",
      },
      summary: {
        type: "string",
        description: "One line describing what this page is about (shown in the cheap index).",
      },
      content: {
        type: "string",
        description: "The full page body in markdown — the actual knowledge.",
      },
      links: {
        type: "array",
        items: { type: "string" },
        description: "Slugs/titles of related pages to link to.",
      },
      source: {
        type: "string",
        description: "Where this knowledge came from (provenance), e.g. 'from the user's 2026-06 email'.",
      },
    },
    required: ["title", "content", "source"],
  },
};

export const brainLookupDefinition: InlineToolDefinition = {
  type: "inline",
  name: "brain_lookup",
  description:
    "Load knowledge from your brain by topic or entity. Try this before asking the user for something you may already know. Returns the matching page (and related pages); if there's no exact hit it searches titles/summaries/content and lists what's available.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "What to look up — a page title/slug or a topic to search for.",
      },
    },
    required: ["query"],
  },
};

export type BrainRememberInput = {
  title: string;
  summary?: string;
  content: string;
  links?: string[];
  source: string;
};

export type BrainRememberResult = {
  ok: boolean;
  title?: string;
  created?: boolean;
  note: string;
};

export type BrainLookupInput = { query: string };

export type BrainLookupResult = {
  found: boolean;
  page?: {
    title: string;
    slug: string;
    summary: string;
    content: string;
    links: string[];
    sources: string[];
  };
  related?: { title: string; slug: string; summary: string }[];
  note: string;
};
