import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_FILE_SCHEMA_V1,
  checkArtifactCompatibility,
  parseAgentFile,
  type AgentFileV1,
} from "./agent-file";

function fileWithParameter(): AgentFileV1 {
  return {
    $schema: AGENT_FILE_SCHEMA_V1,
    id: "artifact-grounded-agent",
    name: "Artifact-grounded agent",
    description: "Uses a private source table without carrying its data.",
    version: "1.0.0",
    exportedAt: "2026-07-29T00:00:00.000Z",
    blueprint: {
      primaryModel: "claude-sonnet-4-6",
      systemPrompt: "Use the bound Source table 1 private knowledge.",
      tools: [],
    },
    parameters: [
      {
        name: "source_file_1",
        label: "Source table 1",
        type: "file",
        required: true,
        artifact: {
          kind: "table",
          accepts: [".csv", ".xlsx"],
          structure: ['Sheet "Invoices" columns: invoice_id, amount, due_date'],
        },
      },
    ],
    inputs: { accepts: ["text"] },
    outputs: { shape: "text" },
  };
}

test("parses a portable private file contract without a bound value", () => {
  const parsed = parseAgentFile(fileWithParameter());
  assert.equal(parsed.parameters?.[0]?.type, "file");
  assert.equal(JSON.stringify(parsed).includes("owner-invoices.xlsx"), false);
});

test("checks a recipient workbook before binding", () => {
  const parameter = fileWithParameter().parameters![0];
  const result = checkArtifactCompatibility(parameter, {
    filename: "my-invoices.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    kind: "table",
    structure: ['Sheet "Invoices" columns: invoice_id, amount, due_date'],
  });
  assert.equal(result.compatible, true);
  assert.deepEqual(result.missingStructure, []);
});

test("fails loud when required structure is absent", () => {
  const parameter = fileWithParameter().parameters![0];
  const result = checkArtifactCompatibility(parameter, {
    filename: "other.csv",
    mimeType: "text/csv",
    kind: "table",
    structure: ["Columns: customer, status"],
  });
  assert.equal(result.compatible, false);
  assert.equal(result.missingStructure.length, 1);
});

test("does not satisfy a required structural token with a substring collision", () => {
  const parameter = fileWithParameter().parameters![0];
  parameter.artifact!.structure = ["amount"];
  const result = checkArtifactCompatibility(parameter, {
    filename: "other.csv",
    mimeType: "text/csv",
    kind: "table",
    structure: ["discount_amount"],
  });
  assert.equal(result.compatible, false);
  assert.deepEqual(result.missingStructure, ["amount"]);

  const safeSuperset = checkArtifactCompatibility(parameter, {
    filename: "other.csv",
    mimeType: "text/csv",
    kind: "table",
    structure: ["Columns: invoice_id, amount, due_date"],
  });
  assert.equal(safeSuperset.compatible, true);
});

test("rejects file defaults so private bindings cannot travel", () => {
  const value = fileWithParameter();
  value.parameters![0].default = "owner-document-id";
  assert.throws(
    () => parseAgentFile(value),
    /cannot carry a default file binding/,
  );
});
