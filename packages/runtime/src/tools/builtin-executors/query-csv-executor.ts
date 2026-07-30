// Portable query_csv executor — pure JS, no host infra, no credentials.
//
// Part of the first-party core-tools bundle (see ../core-plugin.ts). The
// cloud has its own copy; this one ships INSIDE @agentmug/runtime so the CLI,
// desktop, and any npm consumer get a working query_csv via loadPlugin()
// instead of dead-ending at "Unknown tool". Browser-safe (no node:* imports).
//
// Parses RFC 4180-ish CSV (quoted fields with embedded commas + escaped
// quotes; newlines inside quoted fields are not supported in v1). Result rows
// are capped so a big file can't blow the LLM's context window.

import type { ToolExecutor } from "../registry";
import type { QueryCsvInput, QueryCsvResult } from "../builtin/query-csv";

const MAX_FILTER_ROWS = 200;
const MAX_HEAD_TAIL = 100;

export class QueryCsvExecutor implements ToolExecutor {
  async execute(input: unknown): Promise<QueryCsvResult> {
    const parsed = (input ?? {}) as Partial<QueryCsvInput>;
    if (typeof parsed.csv !== "string" || !parsed.csv.trim()) {
      throw new Error("query_csv requires a non-empty 'csv' string");
    }
    const { columns, rows } = parseCsv(parsed.csv);
    if (columns.length === 0) {
      throw new Error("query_csv: header row is empty");
    }
    const colTypes = columns.map((name) => ({
      name,
      type: guessColumnType(rows.map((r) => r[name] ?? "")),
    }));

    const action = parsed.action ?? "summary";

    if (action === "summary") {
      return { rowCount: rows.length, columns: colTypes };
    }

    if (action === "head" || action === "tail") {
      const n = clamp(parsed.n ?? 10, 1, MAX_HEAD_TAIL);
      const slice = action === "head" ? rows.slice(0, n) : rows.slice(-n);
      return {
        rowCount: rows.length,
        columns: colTypes,
        rows: slice,
        truncated: rows.length > n,
      };
    }

    // action === "filter"
    if (!parsed.filter || typeof parsed.filter !== "object") {
      throw new Error("query_csv: 'filter' is required when action='filter'");
    }
    const f = parsed.filter;
    if (!columns.includes(f.column)) {
      throw new Error(
        `query_csv: column '${f.column}' not found. Available: ${columns.join(", ")}`,
      );
    }
    const matched = rows.filter((r) => matches(r[f.column] ?? "", f.op, f.value));
    return {
      rowCount: rows.length,
      columns: colTypes,
      rows: matched.slice(0, MAX_FILTER_ROWS),
      truncated: matched.length > MAX_FILTER_ROWS,
    };
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (typeof n !== "number" || Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

function matches(cell: string, op: string, target: string): boolean {
  if (op === "contains") return cell.toLowerCase().includes(target.toLowerCase());
  if (op === "eq") return cell === target;
  if (op === "ne") return cell !== target;
  const lhs = Number(cell);
  const rhs = Number(target);
  const numeric = !Number.isNaN(lhs) && !Number.isNaN(rhs);
  if (op === "gt") return numeric ? lhs > rhs : cell > target;
  if (op === "lt") return numeric ? lhs < rhs : cell < target;
  if (op === "gte") return numeric ? lhs >= rhs : cell >= target;
  if (op === "lte") return numeric ? lhs <= rhs : cell <= target;
  return false;
}

function parseCsv(text: string): {
  columns: string[];
  rows: Array<Record<string, string>>;
} {
  const lines = text.replace(/\r\n/g, "\n").split("\n").filter((l) => l.length);
  if (lines.length === 0) return { columns: [], rows: [] };
  const columns = parseLine(lines[0]);
  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseLine(lines[i]);
    if (cells.length === 0) continue;
    const row: Record<string, string> = {};
    for (let c = 0; c < columns.length; c++) {
      row[columns[c]] = cells[c] ?? "";
    }
    rows.push(row);
  }
  return { columns, rows };
}

function parseLine(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      i++; // skip opening quote
      let field = "";
      while (i < line.length) {
        if (line[i] === '"') {
          if (line[i + 1] === '"') {
            field += '"';
            i += 2;
          } else {
            i++;
            break;
          }
        } else {
          field += line[i++];
        }
      }
      out.push(field);
      if (line[i] === ",") i++;
    } else {
      let field = "";
      while (i < line.length && line[i] !== ",") field += line[i++];
      out.push(field.trim());
      if (line[i] === ",") i++;
    }
  }
  return out;
}

function guessColumnType(
  values: string[],
): "number" | "string" | "boolean" | "date" | "mixed" {
  let nums = 0;
  let bools = 0;
  let dates = 0;
  let strs = 0;
  const sample = values.slice(0, 50).filter((v) => v.length > 0);
  if (sample.length === 0) return "string";
  for (const v of sample) {
    if (/^-?\d+(\.\d+)?$/.test(v)) nums++;
    else if (/^(true|false)$/i.test(v)) bools++;
    else if (/^\d{4}-\d{2}-\d{2}/.test(v) || !Number.isNaN(Date.parse(v))) {
      if (!/^-?\d+(\.\d+)?$/.test(v)) dates++;
      else nums++;
    } else strs++;
  }
  const winner = Math.max(nums, bools, dates, strs);
  const threshold = sample.length * 0.7;
  if (winner < threshold) return "mixed";
  if (winner === nums) return "number";
  if (winner === bools) return "boolean";
  if (winner === dates) return "date";
  return "string";
}
