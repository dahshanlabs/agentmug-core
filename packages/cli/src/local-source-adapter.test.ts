import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ExcelJS from "exceljs";
import {
  AGENT_FILE_SCHEMA_V1,
  checkAgentSourceReadiness,
  quickRun,
  type AgentFileV1,
  type LlmClient,
  type LlmStreamEvent,
  type LlmStreamParams,
  type SourceRequirement,
} from "@agentmug/runtime";
import { LocalReadOnlySourceAdapter } from "./local-source-adapter.js";
import { extractSourceFile } from "./source-extractors.js";
import {
  MAX_KLYPIX_CARD_CHARS,
  MAX_OFFICE_XML_ELEMENTS,
  MAX_SOURCE_FILE_BYTES,
} from "./source-limits.js";

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(entries: Record<string, string | Uint8Array>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let localOffset = 0;
  for (const [name, raw] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, "utf8");
    const body = typeof raw === "string" ? Buffer.from(raw, "utf8") : Buffer.from(raw);
    const checksum = crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.byteLength, 18);
    local.writeUInt32LE(body.byteLength, 22);
    local.writeUInt16LE(nameBytes.byteLength, 26);
    locals.push(local, nameBytes, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(body.byteLength, 20);
    central.writeUInt32LE(body.byteLength, 24);
    central.writeUInt16LE(nameBytes.byteLength, 28);
    central.writeUInt32LE(localOffset, 42);
    centrals.push(central, nameBytes);
    localOffset += local.byteLength + nameBytes.byteLength + body.byteLength;
  }
  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(centralBytes.byteLength, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...locals, centralBytes, eocd]);
}

function klypixFixture(
  overrides: {
    manifest?: Record<string, unknown>;
    extraEntries?: Record<string, string | Uint8Array>;
  } = {},
): Buffer {
  return storedZip({
    "manifest.json": JSON.stringify(
      overrides.manifest ?? {
        format: "klypix",
        version: 4,
        schemaVersion: 4,
        kind: "brain",
        stats: { itemCount: 2, assetCount: 0 },
      },
    ),
    "canvas.json": JSON.stringify({
      version: 4,
      order: ["txt_aa111111", "txt_bb222222"],
      connections: [
        {
          fromId: "txt_aa111111",
          toId: "txt_bb222222",
          relationship: "owned by",
        },
      ],
      tools: [{ command: "NEVER_IMPORT_THIS_CANVAS_COMMAND" }],
    }),
    "items/aa/txt_aa111111.json": JSON.stringify({
      type: "text",
      content: "Pricing decision\nUse annual billing.",
      tools: [{ command: "NEVER_IMPORT_THIS_COMMAND" }],
    }),
    "items/bb/txt_bb222222.json": JSON.stringify({
      type: "text",
      content: "Owner\nFinance team.",
      skills: [{ content: "NEVER_IMPORT_THIS_SKILL" }],
    }),
    ...overrides.extraEntries,
  });
}

class CapturingQuickRunLlm implements LlmClient {
  readonly calls: LlmStreamParams[] = [];

  async *streamMessage(
    params: LlmStreamParams,
  ): AsyncIterable<LlmStreamEvent> {
    this.calls.push(params);
    const answer = "The current KLYPIX decision is confirmed.";
    yield { type: "text_delta", text: answer };
    yield {
      type: "message_complete",
      stopReason: "end_turn",
      content: [{ type: "text", text: answer }],
    };
  }
}

async function temporaryRoot(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `agentmug-${name}-`));
}

test("folder reads stay contained and exclude hidden files and symlinks", async () => {
  const root = await temporaryRoot("contained");
  try {
    const folder = join(root, "knowledge");
    await mkdir(folder);
    await writeFile(
      join(folder, "visible.md"),
      "# Policy\nVisible grounded answer.\n",
      "utf8",
    );
    await writeFile(
      join(folder, ".secret.txt"),
      "DO-NOT-INGEST-HIDDEN-SECRET",
      "utf8",
    );
    const outside = join(root, "outside.txt");
    await writeFile(outside, "DO-NOT-INGEST-SYMLINK-SECRET", "utf8");
    let symlinkCreated = false;
    try {
      await symlink(outside, join(folder, "linked.txt"), "file");
      symlinkCreated = true;
    } catch {
      // Creating symlinks may require Developer Mode on Windows.
    }

    const requirement: SourceRequirement = {
      id: "policy_folder",
      label: "Policy folder",
      role: "knowledge",
      kind: "folder",
      required: true,
      access: { capabilities: ["read", "list", "search", "cite", "version"] },
    };
    const adapter = new LocalReadOnlySourceAdapter();
    const binding = await adapter.createBinding(requirement, folder);
    const chunks = await adapter.read(binding, {
      selector: { query: "grounded policy" },
    });
    const evidence = chunks.map((chunk) => chunk.content).join("\n");
    assert.match(evidence, /Visible grounded answer/);
    assert.doesNotMatch(evidence, /DO-NOT-INGEST-HIDDEN-SECRET/);
    assert.doesNotMatch(evidence, /DO-NOT-INGEST-SYMLINK-SECRET/);
    assert.ok(
      chunks.every(
        (chunk) =>
          !chunk.evidence.artifact?.relativePath?.includes(root),
      ),
    );

    await assert.rejects(
      adapter.read(binding, {
        selector: { relativePath: "../outside.txt" },
      }),
      /escapes|hidden path/,
    );
    if (symlinkCreated) {
      await assert.rejects(
        adapter.read(binding, {
          selector: { relativePath: "linked.txt" },
        }),
        /symbolic link/,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("oversized local files fail closed", async () => {
  const root = await temporaryRoot("oversize");
  try {
    const path = join(root, "too-large.txt");
    await writeFile(path, Buffer.alloc(MAX_SOURCE_FILE_BYTES + 1, 0x61));
    const adapter = new LocalReadOnlySourceAdapter();
    const requirement: SourceRequirement = {
      id: "large",
      label: "Large file",
      role: "knowledge",
      kind: "file",
      required: true,
      access: { capabilities: ["read"] },
    };
    await assert.rejects(
      adapter.createBinding(requirement, path),
      /10 MB limit/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot reads enforce the persisted pin on the same adapter and after restart", async () => {
  const root = await temporaryRoot("snapshot-pin");
  try {
    const path = join(root, "facts.txt");
    await writeFile(path, "Approved snapshot truth.", "utf8");
    const snapshotRequirement: SourceRequirement = {
      id: "facts",
      label: "Facts",
      role: "knowledge",
      kind: "file",
      required: true,
      freshness: { mode: "snapshot", onStale: "fail" },
      access: { capabilities: ["read", "cite", "version"] },
    };
    const firstAdapter = new LocalReadOnlySourceAdapter();
    const approved = await firstAdapter.createBinding(
      snapshotRequirement,
      path,
    );
    const reloaded = JSON.parse(
      JSON.stringify(approved),
    ) as typeof approved;

    await writeFile(path, "Unapproved replacement truth.", "utf8");
    await assert.rejects(
      firstAdapter.read(approved),
      /changed after approval.*bind it again/,
    );
    await assert.rejects(
      new LocalReadOnlySourceAdapter().read(reloaded),
      /changed after approval.*bind it again/,
    );

    const onRunRequirement: SourceRequirement = {
      ...snapshotRequirement,
      id: "live_facts",
      freshness: { mode: "on-run", onStale: "fail" },
      access: {
        capabilities: ["read", "cite", "sync", "version"],
      },
    };
    const onRunAdapter = new LocalReadOnlySourceAdapter();
    const onRunBinding = await onRunAdapter.createBinding(
      onRunRequirement,
      path,
    );
    await writeFile(path, "Newest on-run truth.", "utf8");
    const refreshed = await onRunAdapter.read(onRunBinding);
    assert.match(
      refreshed.map((chunk) => chunk.content).join("\n"),
      /Newest on-run truth/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Klypix imports card knowledge but ignores executable-looking fields", async () => {
  const root = await temporaryRoot("klypix");
  try {
    const path = join(root, "brain.klypix");
    await writeFile(path, klypixFixture());
    const requirement: SourceRequirement = {
      id: "project_brain",
      label: "Project brain",
      role: "brain",
      kind: "klypix",
      required: true,
      access: { capabilities: ["read", "search", "cite", "version"] },
    };
    const adapter = new LocalReadOnlySourceAdapter();
    const binding = await adapter.createBinding(requirement, path);
    assert.ok(binding.structure?.includes("Klypix brain snapshot"));
    assert.ok(
      binding.structure?.includes("Schema: cards and relationships"),
    );
    const chunks = await adapter.read(binding);
    const content = chunks.map((chunk) => chunk.content).join("\n");
    assert.match(content, /Use annual billing/);
    assert.match(content, /owned by card 2/);
    assert.doesNotMatch(content, /NEVER_IMPORT_THIS_COMMAND/);
    assert.doesNotMatch(content, /NEVER_IMPORT_THIS_SKILL/);
    assert.doesNotMatch(content, /NEVER_IMPORT_THIS_CANVAS_COMMAND/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Klypix accepts migrated safe item ids with canonical shards", async () => {
  const extracted = await extractSourceFile(
    "brain.klypix",
    storedZip({
      "manifest.json": JSON.stringify({
        format: "klypix",
        version: 4,
        schemaVersion: 4,
        kind: "brain",
        stats: { itemCount: 1, assetCount: 0 },
      }),
      "canvas.json": JSON.stringify({
        version: 4,
        order: ["legacy.note-1"],
        connections: [],
      }),
      "items/le/legacy.note-1.json": JSON.stringify({
        type: "text",
        content: "Migrated current truth.",
      }),
    }),
  );
  assert.deepEqual(extracted.records?.map((record) => record.id), [
    "legacy.note-1",
  ]);
});

test("Klypix binding removes an explicitly superseded card and emits auditable card evidence", async () => {
  const root = await temporaryRoot("klypix-correction");
  try {
    const path = join(root, "brain.klypix");
    const bytes = klypixFixture({
      extraEntries: {
        "canvas.json": JSON.stringify({
          version: 4,
          order: ["txt_aa111111", "txt_bb222222"],
          connections: [
            {
              fromId: "txt_aa111111",
              toId: "txt_bb222222",
              relationship: "relates_to",
              label: "superseded by",
            },
          ],
        }),
        "items/aa/txt_aa111111.json": JSON.stringify({
          type: "text",
          createdAt: 100,
          content:
            "Desktop Klypix runtime execution is deferred until a later release because local file embedded skills cannot run.",
        }),
        "items/bb/txt_bb222222.json": JSON.stringify({
          type: "text",
          createdAt: 200,
          content:
            "Desktop Klypix runtime execution CORRECTION: local file embedded skills are wired and run now; the deferred plan was WRONG.",
        }),
      },
    });
    await writeFile(path, bytes);
    const requirement: SourceRequirement = {
      id: "project_brain",
      label: "Project brain",
      role: "brain",
      kind: "klypix",
      required: true,
      access: { capabilities: ["read", "search", "cite", "version"] },
    };
    const adapter = new LocalReadOnlySourceAdapter();
    const binding = await adapter.createBinding(requirement, path);
    assert.equal(
      binding.revision?.contentHash,
      createHash("sha256").update(bytes).digest("hex"),
    );
    assert.equal(binding.revision?.idAttestation, "host-computed");

    const chunks = await adapter.read(binding, {
      selector: { query: "desktop Klypix runtime execution" },
      maxChunks: 10,
    });
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].evidence.artifact?.id, "txt_bb222222");
    assert.deepEqual(chunks[0].evidence.location, {
      kind: "record",
      collection: "klypix.cards",
      key: "txt_bb222222",
    });
    assert.equal(chunks[0].evidence.revision?.contentHash, binding.revision?.contentHash);
    assert.equal(
      chunks[0].evidence.revision?.idAttestation,
      "host-computed",
    );
    assert.ok(Date.parse(chunks[0].evidence.retrievedAt ?? "") > 0);
    assert.match(
      chunks[0].content,
      /^KLYPIX_CARD_ID: txt_bb222222\n/,
    );
    assert.match(chunks[0].content, /are wired and run now/);
    assert.doesNotMatch(chunks[0].content, /is deferred until/);
    assert.doesNotMatch(JSON.stringify(chunks), /txt_aa111111/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("quickRun sends only corrected Klypix truth and returns its exact card receipt", async () => {
  const root = await temporaryRoot("klypix-quickrun");
  try {
    const path = join(root, "brain.klypix");
    await writeFile(
      path,
      klypixFixture({
        extraEntries: {
          "canvas.json": JSON.stringify({
            version: 4,
            order: ["txt_aa111111", "txt_bb222222"],
            connections: [
              {
                fromId: "txt_aa111111",
                toId: "txt_bb222222",
                relationship: "superseded by",
              },
            ],
          }),
          "items/aa/txt_aa111111.json": JSON.stringify({
            type: "text",
            content: "STALE_DECISION: desktop execution is deferred.",
          }),
          "items/bb/txt_bb222222.json": JSON.stringify({
            type: "text",
            content:
              "CURRENT_DECISION: desktop execution is available now.",
          }),
        },
      }),
    );
    const requirement: SourceRequirement = {
      id: "project_brain",
      label: "Project brain",
      role: "brain",
      kind: "klypix",
      required: true,
      freshness: { mode: "snapshot", onStale: "fail" },
      access: { capabilities: ["read", "search", "cite", "version"] },
    };
    const adapter = new LocalReadOnlySourceAdapter();
    const binding = await adapter.createBinding(requirement, path);
    const agentFile: AgentFileV1 = {
      $schema: AGENT_FILE_SCHEMA_V1,
      id: "klypix-quickrun-proof",
      name: "Klypix quickRun proof",
      description: "Answers only from the corrected project brain.",
      version: "1.0.0",
      exportedAt: "2026-07-30T00:00:00.000Z",
      blueprint: {
        primaryModel: "claude-sonnet-4-6",
        systemPrompt: "Answer only from current KLYPIX evidence.",
        tools: [],
      },
      inputs: { accepts: ["text"] },
      sources: [requirement],
    };
    const llm = new CapturingQuickRunLlm();
    const result = await quickRun({
      agentFile,
      userInput: "What is the desktop execution decision?",
      llm,
      sourceBindings: [binding],
      sourceAdapters: [adapter],
    });

    assert.equal(result.status, "completed");
    assert.equal(llm.calls.length, 1);
    const system = llm.calls[0]!.system;
    assert.doesNotMatch(system, /STALE_DECISION|txt_aa111111/);
    const evidenceMarker = "\nSOURCE_EVIDENCE_JSON\n";
    const evidenceStart =
      system.indexOf(evidenceMarker) + evidenceMarker.length;
    const evidenceEnd = system.indexOf(
      "\nEND_SOURCE_EVIDENCE_JSON",
      evidenceStart,
    );
    assert.ok(evidenceStart >= evidenceMarker.length);
    assert.ok(evidenceEnd > evidenceStart);
    const directive = JSON.parse(
      system.slice(evidenceStart, evidenceEnd),
    ) as Array<Record<string, unknown>>;
    const revision = binding.revision!;
    const contentHash = revision.contentHash!;
    assert.deepEqual(directive, [
      {
        id: createHash("sha256")
          .update(
            `project_brain\u0000txt_bb222222\u0000${contentHash}`,
          )
          .digest("hex"),
        citation:
          `[source:project_brain | artifact:brain.klypix | ` +
          `revision:${revision.id} | record klypix.cards/txt_bb222222]`,
        revision,
        role: "brain",
        authority: null,
        priority: null,
        conflictPolicy: null,
        citations: null,
        trust: "raw",
        truncated: false,
        content:
          "KLYPIX_CARD_ID: txt_bb222222\n" +
          "CURRENT_DECISION: desktop execution is available now.",
      },
    ]);

    const read = result.receipt?.reads[0];
    assert.equal(result.receipt?.reads.length, 1);
    assert.equal(read?.sourceId, "project_brain");
    assert.deepEqual(read?.revision, revision);
    assert.equal(read?.chunkCount, 1);
    assert.equal(read?.evidence[0]?.artifact?.id, "txt_bb222222");
    assert.deepEqual(read?.evidence[0]?.location, {
      kind: "record",
      collection: "klypix.cards",
      key: "txt_bb222222",
    });
    assert.ok(
      Number.isFinite(Date.parse(read?.evidence[0]?.retrievedAt ?? "")),
    );
    assert.doesNotMatch(JSON.stringify(result.receipt), /txt_aa111111/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Klypix lexical CORRECTION projection removes stale text without a lifecycle edge", async () => {
  const extracted = await extractSourceFile(
    "brain.klypix",
    klypixFixture({
      extraEntries: {
        "canvas.json": JSON.stringify({
          version: 4,
          order: ["txt_aa111111", "txt_bb222222"],
          connections: [],
        }),
        "items/aa/txt_aa111111.json": JSON.stringify({
          type: "text",
          createdAt: 100,
          content:
            "Desktop Klypix runtime execution is deferred until a later release because local file embedded skills cannot run.",
        }),
        "items/bb/txt_bb222222.json": JSON.stringify({
          type: "text",
          createdAt: 200,
          content:
            "Desktop Klypix runtime execution CORRECTION: local file embedded skills now run; the deferred release plan was WRONG.",
        }),
      },
    }),
  );
  assert.deepEqual(extracted.records?.map((record) => record.id), [
    "txt_bb222222",
  ]);
  assert.doesNotMatch(extracted.content, /is deferred until/);
  assert.match(extracted.content, /CORRECTION/);
});

test("Klypix snapshot grounding excludes Archive cards and never uses them as correctors", async () => {
  const extracted = await extractSourceFile(
    "brain.klypix",
    klypixFixture({
      manifest: {
        format: "klypix",
        version: 4,
        schemaVersion: 4,
        kind: "brain",
        stats: { itemCount: 3, assetCount: 0 },
      },
      extraEntries: {
        "canvas.json": JSON.stringify({
          version: 4,
          order: [
            "ctn_cc333333",
            "txt_aa111111",
            "txt_bb222222",
          ],
          positions: {
            txt_bb222222: { parentId: "ctn_cc333333" },
          },
          connections: [],
        }),
        "items/aa/txt_aa111111.json": JSON.stringify({
          type: "text",
          createdAt: 200,
          content:
            "Desktop Klypix runtime execution is deferred pending a verified local release.",
        }),
        "items/bb/txt_bb222222.json": JSON.stringify({
          type: "text",
          createdAt: 300,
          content:
            "Desktop Klypix runtime execution CORRECTION: it is wired in an archived historical experiment.",
        }),
        "items/cc/ctn_cc333333.json": JSON.stringify({
          type: "container",
          title: "Archive",
        }),
      },
    }),
  );
  assert.deepEqual(extracted.records?.map((record) => record.id), [
    "txt_aa111111",
  ]);
  assert.match(extracted.content, /is deferred pending/);
  assert.doesNotMatch(extracted.content, /archived historical experiment/);
});

test("Klypix binding fails closed when its knowledge projection is lossy", async () => {
  assert.equal(MAX_KLYPIX_CARD_CHARS, 16 * 1024);
  const root = await temporaryRoot("klypix-lossy");
  try {
    const path = join(root, "brain.klypix");
    await writeFile(
      path,
      klypixFixture({
        extraEntries: {
          "items/aa/txt_aa111111.json": JSON.stringify({
            type: "text",
            content: "x".repeat(MAX_KLYPIX_CARD_CHARS + 1),
          }),
        },
      }),
    );
    const requirement: SourceRequirement = {
      id: "project_brain",
      label: "Project brain",
      role: "brain",
      kind: "klypix",
      required: true,
      access: { capabilities: ["read", "search", "cite", "version"] },
    };
    await assert.rejects(
      new LocalReadOnlySourceAdapter().createBinding(requirement, path),
      /exceeds complete extraction limits/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Klypix lifecycle graphs fail closed when cyclic or ambiguous", async () => {
  await assert.rejects(
    extractSourceFile(
      "brain.klypix",
      klypixFixture({
        extraEntries: {
          "canvas.json": JSON.stringify({
            version: 4,
            order: ["txt_aa111111", "txt_bb222222"],
            connections: [
              {
                fromId: "txt_aa111111",
                toId: "txt_bb222222",
                relationship: "superseded by",
              },
              {
                fromId: "txt_bb222222",
                toId: "txt_aa111111",
                relationship: "closed by",
              },
            ],
          }),
        },
      }),
    ),
    /cycle/,
  );

  await assert.rejects(
    extractSourceFile(
      "brain.klypix",
      klypixFixture({
        manifest: {
          format: "klypix",
          version: 4,
          schemaVersion: 4,
          kind: "brain",
          stats: { itemCount: 3, assetCount: 0 },
        },
        extraEntries: {
          "canvas.json": JSON.stringify({
            version: 4,
            order: [
              "txt_aa111111",
              "txt_bb222222",
              "txt_cc333333",
            ],
            connections: [
              {
                fromId: "txt_aa111111",
                toId: "txt_bb222222",
                relationship: "superseded by",
              },
              {
                fromId: "txt_aa111111",
                toId: "txt_cc333333",
                relationship: "closed by",
              },
            ],
          }),
          "items/cc/txt_cc333333.json": JSON.stringify({
            type: "text",
            content: "Competing successor.",
          }),
        },
      }),
    ),
    /multiple successors/,
  );
});

test("Klypix validates declared assets but never grounds their bytes", async () => {
  const assetMarker = "PRIVATE_ASSET_BYTES_MUST_NEVER_REACH_EVIDENCE";
  const extracted = await extractSourceFile(
    "brain.klypix",
    klypixFixture({
      manifest: {
        format: "klypix",
        version: 4,
        schemaVersion: 4,
        kind: "brain",
        stats: { itemCount: 2, assetCount: 1 },
      },
      extraEntries: {
        "assets/files/aa/attachment.bin": assetMarker,
      },
    }),
  );
  assert.equal(extracted.truncated, false);
  assert.doesNotMatch(extracted.content, new RegExp(assetMarker));
  assert.ok(
    extracted.records?.every((record) => !record.content.includes(assetMarker)),
  );

  await assert.rejects(
    extractSourceFile(
      "brain.klypix",
      klypixFixture({
        extraEntries: {
          "assets/files/aa/attachment.bin": assetMarker,
        },
      }),
    ),
    /manifest counts/,
  );
});

test("Klypix rejects non-packages, unsupported brains, unexpected entries, and forged ZIP views", async () => {
  await assert.rejects(
    extractSourceFile(
      "brain.klypix",
      Buffer.from(JSON.stringify({ cards: [{ content: "legacy" }] })),
    ),
    /not a ZIP package/,
  );
  await assert.rejects(
    extractSourceFile(
      "brain.klypix",
      klypixFixture({
        manifest: {
          format: "klypix",
          version: 4,
          schemaVersion: 4,
          kind: "canvas",
          stats: { itemCount: 2, assetCount: 0 },
        },
      }),
    ),
    /v4 brain packages/,
  );
  await assert.rejects(
    extractSourceFile(
      "brain.klypix",
      klypixFixture({ extraEntries: { "payload.exe": "binary" } }),
    ),
    /unexpected entry/,
  );
  await assert.rejects(
    extractSourceFile(
      "brain.klypix",
      klypixFixture({ extraEntries: { "assets/ignored.bin": "binary" } }),
    ),
    /unexpected entry/,
  );
  await assert.rejects(
    extractSourceFile(
      "brain.klypix",
      klypixFixture({
        manifest: {
          format: "klypix",
          version: 4,
          schemaVersion: 4,
          kind: "brain",
          stats: { itemCount: 3, assetCount: 0 },
        },
        extraEntries: {
          "items/cc/txt_cc333333.json": JSON.stringify({
            type: "text",
            content: "Unlisted card",
          }),
        },
      }),
    ),
    /order does not match/,
  );
  await assert.rejects(
    extractSourceFile(
      "brain.klypix",
      Buffer.concat([klypixFixture(), Buffer.from("trailer")]),
    ),
    /not a ZIP package|directory is malformed/,
  );

  const flagged = klypixFixture();
  const flaggedCentral = flagged.indexOf(
    Buffer.from([0x50, 0x4b, 0x01, 0x02]),
  );
  assert.ok(flaggedCentral >= 0);
  const flaggedLocal = flagged.readUInt32LE(flaggedCentral + 42);
  flagged.writeUInt16LE(0x0800, flaggedCentral + 8);
  flagged.writeUInt16LE(0x0800, flaggedLocal + 6);
  await assert.rejects(
    extractSourceFile("brain.klypix", flagged),
    /canonical flags/,
  );

  const forgedRatio = klypixFixture();
  const central = forgedRatio.indexOf(
    Buffer.from([0x50, 0x4b, 0x01, 0x02]),
  );
  assert.ok(central >= 0);
  forgedRatio.writeUInt32LE(10 * 1024 * 1024, central + 24);
  await assert.rejects(
    extractSourceFile("brain.klypix", forgedRatio),
    /safe limit|compression ratio/,
  );
});

test("Office archive preflight rejects trailing ZIP views and excessive XML complexity", async () => {
  const forgedView = Buffer.concat([
    storedZip({
      "[Content_Types].xml": "<Types/>",
      "word/document.xml": "<document/>",
    }),
    Buffer.from("trailer"),
  ]);
  await assert.rejects(
    extractSourceFile("forged.docx", forgedView),
    /directory is malformed/,
  );

  const deepXml = `<worksheet>${"<x/>".repeat(
    MAX_OFFICE_XML_ELEMENTS + 1,
  )}</worksheet>`;
  await assert.rejects(
    extractSourceFile(
      "deep.xlsx",
      storedZip({
        "[Content_Types].xml": "<Types/>",
        "xl/workbook.xml": "<workbook/>",
        "xl/worksheets/sheet1.xml": deepXml,
      }),
    ),
    /element limit/,
  );
});

test("XLSX bindings extract sheets, columns, values, and citations", async () => {
  const root = await temporaryRoot("xlsx");
  try {
    const path = join(root, "Invoices.xlsx");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Invoices");
    sheet.addRow(["invoice_id", "amount", "status"]);
    sheet.addRow(["INV-001", 125, "open"]);
    await workbook.xlsx.writeFile(path);

    const requirement: SourceRequirement = {
      id: "invoice_workbook",
      label: "Invoice workbook",
      role: "knowledge",
      kind: "file",
      required: true,
      accepts: { extensions: [".xlsx"] },
      structure: {
        required: [
          'Sheet "Invoices" columns: invoice_id, amount, status',
        ],
      },
      access: { capabilities: ["read", "search", "cite", "version"] },
    };
    const adapter = new LocalReadOnlySourceAdapter();
    const binding = await adapter.createBinding(requirement, path);
    assert.ok(
      binding.structure?.includes(
        'Sheet "Invoices" columns: invoice_id, amount, status',
      ),
    );
    const chunks = await adapter.read(binding, {
      selector: { query: "INV-001 amount" },
    });
    assert.match(chunks.map((chunk) => chunk.content).join("\n"), /INV-001/);
    assert.ok(
      chunks.every(
        (chunk) =>
          chunk.evidence.artifact?.relativePath === "Invoices.xlsx",
      ),
    );

    const folderRequirement: SourceRequirement = {
      ...requirement,
      id: "invoice_folder",
      label: "Invoice folder",
      kind: "folder",
      access: {
        capabilities: ["read", "list", "search", "cite", "version"],
      },
    };
    const folderBinding = await adapter.createBinding(
      folderRequirement,
      root,
    );
    assert.equal(folderBinding.extension, ".xlsx");
    assert.equal(
      checkAgentSourceReadiness(
        { sources: [folderRequirement] },
        {
          bindings: [folderBinding],
          adapters: [adapter.capabilities],
        },
      ).ready,
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("directory depth and private-state overlap fail before ingestion", async () => {
  const root = await temporaryRoot("directory-bounds");
  try {
    const stateRoot = join(root, "private-state");
    const adapter = new LocalReadOnlySourceAdapter({
      excludedRoots: [stateRoot],
    });
    const folderRequirement: SourceRequirement = {
      id: "workspace",
      label: "Workspace",
      role: "knowledge",
      kind: "workspace",
      required: true,
      access: { capabilities: ["read", "list"] },
    };
    await assert.rejects(
      adapter.createBinding(folderRequirement, root),
      /overlaps AgentMug's private state/,
    );

    const deepRoot = join(root, "deep");
    let cursor = deepRoot;
    await mkdir(cursor);
    for (let index = 0; index < 21; index += 1) {
      cursor = join(cursor, `level-${index}`);
      await mkdir(cursor);
    }
    await writeFile(join(cursor, "facts.txt"), "deep fact", "utf8");
    const boundedAdapter = new LocalReadOnlySourceAdapter();
    await assert.rejects(
      boundedAdapter.createBinding(folderRequirement, deepRoot),
      /safe depth of 20/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
