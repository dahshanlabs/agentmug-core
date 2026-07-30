import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentFileV1, SourceRequirement } from "@agentmug/runtime";
import {
  bindCliSource,
  cliSourceStatuses,
  prepareCliSources,
  sourceReadinessErrorLines,
} from "./source-host.js";
import { CliSourceBindingStore } from "./source-state.js";

function agentFile(source: SourceRequirement): AgentFileV1 {
  return {
    $schema: "https://agentmug.com/schemas/agent-file-v1.json",
    version: "1.0.0",
    exportedAt: "2026-07-29T00:00:00.000Z",
    id: "finance-agent",
    name: "Finance",
    description: "",
    blueprint: {
      systemPrompt: "Use the source.",
      primaryModel: "claude-sonnet-4-6",
      tools: [],
    },
    inputs: { accepts: ["text"] },
    sources: [source],
  };
}

test("bind + readiness use private state while a shared copy requires rebind", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentmug-host-"));
  try {
    const agentPath = join(root, "finance.agent");
    const copyPath = join(root, "shared.agent");
    const sourcePath = join(root, "invoices.csv");
    const file: AgentFileV1 = agentFile({
      id: "invoices",
      label: "Invoices",
      role: "knowledge",
      kind: "file",
      required: true,
      accepts: { extensions: [".csv"] },
      access: { capabilities: ["read", "search", "cite", "version"] },
      sharing: { strategy: "rebind" },
    });
    const serialized = JSON.stringify(file);
    await writeFile(agentPath, serialized, "utf8");
    await writeFile(copyPath, serialized, "utf8");
    await writeFile(sourcePath, "invoice_id,total\nINV-1,42\n", "utf8");
    const stateRoot = join(root, "private");
    const store = new CliSourceBindingStore({ stateRoot });

    const status = await bindCliSource(
      agentPath,
      file,
      "invoices",
      sourcePath,
      { store },
    );
    assert.equal(status.status, "ready");
    assert.equal(await readFile(agentPath, "utf8"), serialized);

    const prepared = await prepareCliSources(agentPath, file, { store });
    assert.equal(prepared.ready, true);
    assert.equal(cliSourceStatuses(file, prepared)[0]!.bound, true);

    const recipient = await prepareCliSources(copyPath, file, { store });
    assert.equal(recipient.ready, false);
    assert.equal(
      cliSourceStatuses(file, recipient)[0]!.issues[0]!.code,
      "missing_binding",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read-only CLI refuses contracts that require source writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentmug-write-gate-"));
  try {
    const agentPath = join(root, "writer.agent");
    const sourcePath = join(root, "working.csv");
    const file = agentFile({
      id: "working",
      label: "Working file",
      role: "working",
      kind: "file",
      required: true,
      accepts: { extensions: [".csv"] },
      access: { capabilities: ["read", "write"] },
      approval: { write: "every-action", destructive: "forbidden" },
    });
    await writeFile(agentPath, JSON.stringify(file), "utf8");
    await writeFile(sourcePath, "id,value\n1,a\n", "utf8");
    const store = new CliSourceBindingStore({
      stateRoot: join(root, "private"),
    });
    await assert.rejects(
      bindCliSource(agentPath, file, "working", sourcePath, { store }),
      /missing required capability 'write'|cannot provide (?:required capability )?'write'/,
    );
    assert.deepEqual(
      await store.list(agentPath, file),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot changes require rebind while on-run sources refresh", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentmug-freshness-"));
  try {
    const sourcePath = join(root, "facts.csv");
    await writeFile(sourcePath, "id,value\n1,old\n", "utf8");
    const snapshotFile = agentFile({
      id: "facts",
      label: "Facts",
      role: "knowledge",
      kind: "file",
      required: true,
      accepts: { extensions: [".csv"] },
      freshness: { mode: "snapshot", onStale: "fail" },
      access: { capabilities: ["read", "cite", "version"] },
    });
    const snapshotAgentPath = join(root, "snapshot.agent");
    await writeFile(snapshotAgentPath, JSON.stringify(snapshotFile), "utf8");
    const store = new CliSourceBindingStore({
      stateRoot: join(root, "private"),
    });
    await bindCliSource(
      snapshotAgentPath,
      snapshotFile,
      "facts",
      sourcePath,
      { store },
    );
    await writeFile(sourcePath, "id,value\n1,new\n", "utf8");
    const stale = await prepareCliSources(snapshotAgentPath, snapshotFile, {
      store,
    });
    assert.equal(stale.ready, false);
    assert.equal(cliSourceStatuses(snapshotFile, stale)[0]!.status, "stale");
    assert.ok(
      cliSourceStatuses(snapshotFile, stale)[0]!.issues.some(
        (issue) => issue.code === "snapshot_revision_changed",
      ),
    );

    const onRunFile = agentFile({
      id: "facts",
      label: "Facts",
      role: "knowledge",
      kind: "file",
      required: true,
      accepts: { extensions: [".csv"] },
      freshness: { mode: "on-run", onStale: "fail" },
      access: { capabilities: ["read", "cite", "sync", "version"] },
    });
    const onRunAgentPath = join(root, "on-run.agent");
    await writeFile(onRunAgentPath, JSON.stringify(onRunFile), "utf8");
    await bindCliSource(
      onRunAgentPath,
      onRunFile,
      "facts",
      sourcePath,
      { store },
    );
    await writeFile(sourcePath, "id,value\n1,newest\n", "utf8");
    const refreshed = await prepareCliSources(onRunAgentPath, onRunFile, {
      store,
    });
    assert.equal(refreshed.ready, true);
    assert.equal(
      typeof refreshed.bindings[0]!.lastSyncedAt,
      "string",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("optional unbound watch sources do not block and orphans are never opened", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentmug-optional-"));
  try {
    const agentPath = join(root, "optional.agent");
    const file = agentFile({
      id: "optional_watch",
      label: "Optional watch",
      role: "knowledge",
      kind: "file",
      required: false,
      freshness: { mode: "watch", onStale: "fail" },
      access: { capabilities: ["read", "watch"] },
    });
    await writeFile(agentPath, JSON.stringify(file), "utf8");
    const store = new CliSourceBindingStore({
      stateRoot: join(root, "private"),
    });
    await store.put(agentPath, file, {
      id: "orphan-binding",
      sourceId: "removed_source",
      adapterId: "agentmug.cli.local-readonly.v1",
      kind: "file",
      status: "ready",
      locator: { path: join(root, "does-not-exist.txt") },
      capabilities: ["read"],
    });
    const prepared = await prepareCliSources(agentPath, file, { store });
    assert.equal(prepared.ready, true);
    const statuses = cliSourceStatuses(file, prepared);
    assert.equal(statuses[0]!.status, "optional");
    assert.equal(statuses[1]!.orphaned, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("on-bind approval is explicit and checked before touching the path", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentmug-approval-"));
  try {
    const agentPath = join(root, "approval.agent");
    const sourcePath = join(root, "approved.csv");
    const file = agentFile({
      id: "approved",
      label: "Approved source",
      role: "knowledge",
      kind: "file",
      required: true,
      accepts: { extensions: [".csv"] },
      access: { capabilities: ["read"] },
      approval: { read: "on-bind" },
    });
    await writeFile(agentPath, JSON.stringify(file), "utf8");
    const store = new CliSourceBindingStore({
      stateRoot: join(root, "private"),
    });
    await assert.rejects(
      bindCliSource(
        agentPath,
        file,
        "approved",
        join(root, "missing.csv"),
        { store },
      ),
      /rerun with --approve/,
    );
    await writeFile(sourcePath, "id,value\n1,ok\n", "utf8");
    const status = await bindCliSource(
      agentPath,
      file,
      "approved",
      sourcePath,
      { store, approved: true },
    );
    assert.equal(typeof status.approval?.approvedAt, "string");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unsupported schema contracts fail closed before reads and human diagnostics strip controls", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentmug-schema-gate-"));
  try {
    const agentPath = join(root, "schema.agent");
    const file = agentFile({
      id: "records",
      label: "Records\u001b]0;spoof\u0007\nforged",
      role: "knowledge",
      kind: "file",
      required: true,
      structure: {
        schema: {
          type: "array",
          items: { type: "object", required: ["id"] },
        },
      },
      access: { capabilities: ["read"] },
    });
    await writeFile(agentPath, JSON.stringify(file), "utf8");
    const store = new CliSourceBindingStore({
      stateRoot: join(root, "private"),
    });
    await assert.rejects(
      bindCliSource(
        agentPath,
        file,
        "records",
        join(root, "does-not-exist.json"),
        { store },
      ),
      /JSON Schema validation/,
    );
    const prepared = await prepareCliSources(agentPath, file, { store });
    assert.equal(prepared.ready, false);
    assert.ok(
      cliSourceStatuses(file, prepared)[0]!.issues.some(
        (issue) => issue.code === "structure_schema_unsupported",
      ),
    );
    for (const line of sourceReadinessErrorLines(file, prepared)) {
      assert.doesNotMatch(
        line,
        /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("web-only PDF and image contracts report an explicit local host gap", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentmug-format-gate-"));
  try {
    const agentPath = join(root, "pdf.agent");
    const file = agentFile({
      id: "reference",
      label: "Reference PDF",
      role: "knowledge",
      kind: "file",
      required: true,
      accepts: {
        extensions: [".pdf"],
        mediaTypes: ["application/pdf", "image/*"],
      },
      access: { capabilities: ["read", "cite"] },
    });
    await writeFile(agentPath, JSON.stringify(file), "utf8");
    const prepared = await prepareCliSources(agentPath, file, {
      store: new CliSourceBindingStore({
        stateRoot: join(root, "private"),
      }),
    });
    assert.equal(prepared.ready, false);
    assert.ok(
      cliSourceStatuses(file, prepared)[0]!.issues.some(
        (issue) => issue.code === "local_format_unsupported",
      ),
    );
    assert.match(
      sourceReadinessErrorLines(file, prepared).join("\n"),
      /Web\/cloud may support additional PDF or image formats/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
