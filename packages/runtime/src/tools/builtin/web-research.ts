// web.research — agents can browse the web and synthesize findings.
//
// The Perplexity / Gemini-Deep-Research / ChatGPT-search equivalent
// as a tool the LLM can call. Closes the gap between AgentMug
// agents (which previously could only fetch URLs the user gave
// them) and "research my top 3 competitors" agents.
//
// Backed by Tavily's search API in the cloud — search-grade
// quality, includes a synthesized answer plus the top sources, and
// returns clean extracted text rather than raw HTML. Without a key
// (TAVILY_API_KEY), the executor returns a clear error and the LLM
// falls back to reasoning from prior knowledge.
//
// User-facing label is "🔍 Researching: <query>" — same pattern as
// every other Phase 11/12 tool, hides the mechanism.

import type { InlineToolDefinition } from "../types";

export const webResearchDefinition: InlineToolDefinition = {
  type: "inline",
  name: "web.research",
  description:
    "Search the live web and synthesize findings. Use this for current information the agent's training cutoff doesn't cover — news, prices, current events, recent reviews, today's weather, competitor pricing, anything that changes. Returns a synthesized answer plus the top source pages with extracted content. Prefer this over fetch_url when you don't already know the right URL. NOT for personal email/calendar/Slack — those are separate tools.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "What to research, phrased as a search query. Be specific — 'OpenAI gpt-5 pricing per million tokens' beats 'openai pricing'. Add date qualifiers ('in 2026', 'recent') when the answer changes over time.",
      },
      depth: {
        type: "string",
        enum: ["basic", "advanced"],
        description:
          "basic = quick (~1s, 1 credit), advanced = deeper crawl (~2s, 2 credits). Default basic. Use advanced only for non-trivial research questions where the basic answer is too shallow.",
      },
      max_sources: {
        type: "number",
        description:
          "How many top sources to return content from. Default 5, max 10.",
      },
      include_domains: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional whitelist — only return results from these domains (e.g. ['github.com', 'arxiv.org']).",
      },
      exclude_domains: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional blacklist — never return results from these domains (e.g. ['reddit.com', 'quora.com']).",
      },
    },
    required: ["query"],
  },
};

export type WebResearchInput = {
  query: string;
  depth?: "basic" | "advanced";
  max_sources?: number;
  include_domains?: string[];
  exclude_domains?: string[];
};

export type WebResearchResult = {
  /** Synthesized answer (when the provider returns one). */
  answer: string;
  /** Source pages with extracted content. */
  sources: Array<{
    title: string;
    url: string;
    content: string;
    /** 0-1 relevance score from the provider. */
    score: number;
  }>;
  /** Total number of credits this call consumed. */
  credits_used: number;
  /** Echoed back so the LLM can confirm what it searched for. */
  query: string;
};
