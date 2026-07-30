// sheets.append_row — append rows to a Google Sheet via the user's
// connected Google account.
//
// Uses the SAME Google OAuth connection as gmail.send / calendar.create_event,
// but requires the spreadsheets scope (the user re-approves once when Google
// is connected after this ships). The cloud executor POSTs to the Sheets
// values:append endpoint with the user's bearer token.

import type { InlineToolDefinition } from "../types";

export const sheetsAppendRowDefinition: InlineToolDefinition = {
  type: "inline",
  name: "sheets.append_row",
  description:
    "Append one or more rows to a Google Sheet via the user's connected Google account (same connection as Gmail/Calendar; needs the Sheets permission). Use to LOG / save structured data to a spreadsheet.",
  inputSchema: {
    type: "object",
    properties: {
      spreadsheetId: {
        type: "string",
        description:
          "The spreadsheet id, from its URL: docs.google.com/spreadsheets/d/<ID>/edit.",
      },
      range: {
        type: "string",
        description: "The sheet or range to append to, e.g. 'Sheet1' or 'Sheet1!A:D'.",
      },
      values: {
        type: "array",
        description:
          'Rows to append — an array of row arrays, e.g. [["2026-06-04","Acme",42]].',
        items: { type: "array", items: {} },
      },
    },
    required: ["spreadsheetId", "range", "values"],
  },
};

export type SheetsAppendRowInput = {
  spreadsheetId: string;
  range: string;
  values: unknown[][];
};

export type SheetsAppendRowResult = {
  updatedRange: string;
  updatedRows: number;
};
