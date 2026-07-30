// Agent Brain — the PORTABLE executors.
//
// The cloud persists brain pages to Postgres; this runs the same loop off-cloud,
// persisting into the agent's own `.agent` file (`brain` array) via the
// serializer. Reuses the same pluggable AgentFileStore as self-skilling, so the
// runtime stays browser-safe (no node:fs). No LLM needed — pure structured CRUD.

import type { AgentBrainPage } from "../format/agent-file";
import { buildAgentFile } from "../format/agent-file";
import type {
  ToolExecutor,
  ToolExecutionContext,
  ToolRegistry,
} from "./registry";
import type { AgentFileStore } from "./self-skilling";
import {
  brainRememberDefinition,
  brainLookupDefinition,
  type BrainRememberInput,
  type BrainRememberResult,
  type BrainLookupInput,
  type BrainLookupResult,
} from "./builtin/brain";

// Limits mirror the cloud (brain-store.ts).
export const MAX_BRAIN_PAGE_CONTENT_CHARS = 8000;
export const MAX_BRAIN_TITLE_CHARS = 80;
export const MAX_BRAIN_SUMMARY_CHARS = 220;
export const MAX_BRAIN_LINKS = 20;
export const MAX_BRAIN_SOURCES = 12;
export const MAX_BRAIN_PAGES_IN_INDEX = 40;
export const MAX_BRAIN_INDEX_CHARS = 2500;
const BRAIN_SECTION_HEADER = "## Your knowledge base";

/** Title → stable slug (mirrors the cloud's normalizeBrainSlug). */
export function normalizeBrainSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_BRAIN_TITLE_CHARS);
}

/** Append a source, dedup, keep the most recent MAX_BRAIN_SOURCES. */
function appendSource(existing: string[], source: string): string[] {
  const s = source.trim();
  if (!s) return existing.slice(-MAX_BRAIN_SOURCES);
  return [...existing.filter((x) => x !== s), s].slice(-MAX_BRAIN_SOURCES);
}

function searchPages(pages: AgentBrainPage[], query: string): AgentBrainPage[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return pages
    .filter((p) =>
      `${p.title}\n${p.summary ?? ""}\n${p.content}`.toLowerCase().includes(q),
    )
    .slice(0, 5);
}

/**
 * The cheap, always-loaded brain INDEX (title + summary only) — pass this to
 * the engine as part of `memoryContext` so the agent knows what it has
 * recorded and can `brain_lookup` the full page on demand. Capped like the
 * cloud's buildBrainContext (40 pages / 2500 chars).
 */
export function buildBrainIndex(brain: AgentBrainPage[] | undefined): string {
  const pages = (brain ?? []).slice(0, MAX_BRAIN_PAGES_IN_INDEX);
  if (pages.length === 0) return "";
  let out = `${BRAIN_SECTION_HEADER}\nPages you've recorded about the user's world. Call brain_lookup with a title before asking the user for something you may already know.\n`;
  for (const p of pages) {
    const line = `- [[${p.slug}]] **${p.title}**${p.summary ? ` — ${p.summary}` : ""}\n`;
    if ((out + line).length > MAX_BRAIN_INDEX_CHARS) break;
    out += line;
  }
  return out;
}

async function upsertBrainPage(
  store: AgentFileStore,
  input: BrainRememberInput,
): Promise<{ created: boolean; slug: string; title: string }> {
  const slug = normalizeBrainSlug(input.title);
  if (!slug) throw new Error("brain_remember: 'title' must contain letters or digits.");
  const title = input.title.trim().slice(0, MAX_BRAIN_TITLE_CHARS);
  const content = input.content.trim().slice(0, MAX_BRAIN_PAGE_CONTENT_CHARS);
  // summary/links are OPTIONAL: on update, only overwrite them when actually
  // provided — a content-only update must not wipe an existing summary/links.
  const summaryProvided = typeof input.summary === "string";
  const linksProvided = Array.isArray(input.links);
  const newSummary = summaryProvided
    ? input.summary!.trim().slice(0, MAX_BRAIN_SUMMARY_CHARS)
    : undefined;
  const newLinks = linksProvided
    ? input.links!.map((s) => String(s).trim()).filter(Boolean).slice(0, MAX_BRAIN_LINKS)
    : undefined;

  const file = await store.load();
  const pages = file.brain ?? [];
  const idx = pages.findIndex((p) => p.slug === slug);
  let nextPages: AgentBrainPage[];
  let created: boolean;
  if (idx >= 0) {
    const ex = pages[idx];
    const updated: AgentBrainPage = {
      slug,
      title,
      content,
      summary: newSummary ?? ex.summary ?? "",
      links: newLinks ?? ex.links ?? [],
      sources: appendSource(ex.sources ?? [], input.source),
    };
    nextPages = pages.map((p, i) => (i === idx ? updated : p));
    created = false;
  } else {
    nextPages = [
      ...pages,
      {
        slug,
        title,
        content,
        summary: newSummary ?? "",
        links: newLinks ?? [],
        sources: input.source.trim() ? [input.source.trim()] : [],
      },
    ];
    created = true;
  }
  const nextFile = buildAgentFile({
    ...file,
    exportedAt: new Date().toISOString(),
    brain: nextPages,
  });
  await store.save(nextFile);
  return { created, slug, title };
}

// ── Executors ───────────────────────────────────────────────────────────────

export class BrainRememberExecutor implements ToolExecutor {
  constructor(private readonly store: AgentFileStore) {}
  async execute(input: unknown, _ctx: ToolExecutionContext): Promise<BrainRememberResult> {
    const parsed = (input ?? {}) as Partial<BrainRememberInput>;
    const title = (parsed.title ?? "").trim();
    const content = (parsed.content ?? "").trim();
    const source = (parsed.source ?? "").trim();
    if (!title || !content || !source) {
      throw new Error("brain_remember requires 'title', 'content', and 'source'.");
    }
    const { created, slug, title: savedTitle } = await upsertBrainPage(this.store, {
      title,
      content,
      source,
      summary: parsed.summary,
      links: parsed.links,
    });
    return {
      ok: true,
      title: savedTitle,
      created,
      note: created
        ? `Created brain page "${savedTitle}" ([[${slug}]]). It travels with this agent.`
        : `Updated brain page "${savedTitle}" ([[${slug}]]).`,
    };
  }
}

export class BrainLookupExecutor implements ToolExecutor {
  constructor(private readonly store: AgentFileStore) {}
  async execute(input: unknown, _ctx: ToolExecutionContext): Promise<BrainLookupResult> {
    const query = ((input ?? {}) as Partial<BrainLookupInput>).query?.trim() ?? "";
    const file = await this.store.load();
    const pages = file.brain ?? [];
    const wantSlug = normalizeBrainSlug(query);
    const hit =
      pages.find(
        (p) => p.slug === wantSlug || p.title.toLowerCase() === query.toLowerCase(),
      ) ?? searchPages(pages, query)[0];

    if (hit) {
      const related = (hit.links ?? [])
        .map((l) => pages.find((p) => p.slug === normalizeBrainSlug(l)))
        .filter((p): p is AgentBrainPage => !!p)
        .map((p) => ({ title: p.title, slug: p.slug, summary: p.summary ?? "" }));
      return {
        found: true,
        page: {
          title: hit.title,
          slug: hit.slug,
          summary: hit.summary ?? "",
          content: hit.content,
          links: hit.links ?? [],
          sources: hit.sources ?? [],
        },
        related,
        note: "Use this knowledge in your answer.",
      };
    }
    const available = pages
      .slice(0, MAX_BRAIN_PAGES_IN_INDEX)
      .map((p) => ({ title: p.title, slug: p.slug, summary: p.summary ?? "" }));
    return {
      found: false,
      related: available,
      note: pages.length
        ? `No page matched "${query}". Available pages are listed in 'related'.`
        : `Your brain is empty — nothing recorded yet.`,
    };
  }
}

/** Wire brain_remember + brain_lookup onto a registry with a host store. */
export function registerAgentBrainTools(
  registry: ToolRegistry,
  opts: { store: AgentFileStore },
): void {
  registry.register(brainRememberDefinition, new BrainRememberExecutor(opts.store));
  registry.register(brainLookupDefinition, new BrainLookupExecutor(opts.store));
}
