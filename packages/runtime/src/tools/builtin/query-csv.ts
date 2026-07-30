// query_csv — analyze a CSV blob in the LLM's tool loop.
//
// Composable with fetch_url: the LLM can fetch a CSV URL and pipe
// the body into this tool to get summary + filtered rows back. The
// executor parses the CSV (RFC 4180-ish), and returns:
//   - column names + simple per-column type guesses
//   - row count
//   - either a head sample, a tail sample, or rows matching a basic
//     filter (column = value, contains, gt, lt)
//
// Why not run arbitrary SQL: needing the LLM to write SQL on data it
// hasn't seen yet leads to query mistakes. Constrained operations
// keep the loop reliable and the tool teachable.

import type { InlineToolDefinition } from "../types";

export const queryCsvDefinition: InlineToolDefinition = {
  type: "inline",
  name: "query_csv",
  description:
    "Parse a CSV string and return a structured view: columns, row count, and a sample (head/tail) or filtered rows. Use after fetch_url when you need to read tabular data.",
  inputSchema: {
    type: "object",
    properties: {
      csv: {
        type: "string",
        description:
          "Raw CSV text. First row is the header. Quoted fields with commas/newlines are supported.",
      },
      action: {
        type: "string",
        enum: ["summary", "head", "tail", "filter"],
        description:
          "What to return: 'summary' (columns + types + counts only), 'head' (first N rows), 'tail' (last N rows), or 'filter' (rows matching `filter`).",
      },
      n: {
        type: "number",
        description: "Row count for head/tail. Default 10. Clamped to 100.",
      },
      filter: {
        type: "object",
        properties: {
          column: { type: "string" },
          op: {
            type: "string",
            enum: ["eq", "ne", "contains", "gt", "lt", "gte", "lte"],
          },
          value: { type: "string" },
        },
        required: ["column", "op", "value"],
        description:
          "Row filter. Numeric ops (gt/lt/gte/lte) coerce both sides to numbers; comparison falls back to string.",
      },
    },
    required: ["csv"],
  },
};

export type QueryCsvInput = {
  csv: string;
  action?: "summary" | "head" | "tail" | "filter";
  n?: number;
  filter?: {
    column: string;
    op: "eq" | "ne" | "contains" | "gt" | "lt" | "gte" | "lte";
    value: string;
  };
};

export type QueryCsvResult = {
  rowCount: number;
  columns: Array<{ name: string; type: "number" | "string" | "boolean" | "date" | "mixed" }>;
  rows?: Array<Record<string, string>>;
  /** True if rows[] was truncated to a maximum. */
  truncated?: boolean;
};
