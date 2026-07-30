// File-backed AgentFileStore — the CLI's persistence for self-skilling + brain.
//
// The runtime defines the AgentFileStore interface but stays browser-safe (no
// node:fs). This concrete store reads/writes the agent's `.agent` file on disk,
// so when an agent calls save_skill / brain_remember during a CLI run, the new
// skill/page is written straight back into the file it was loaded from — the
// agent genuinely learns + remembers, locally and portably.

import { readFile, writeFile } from "node:fs/promises";
import {
  parseAgentFile,
  serializeAgentFile,
  type AgentFileStore,
  type AgentFileV1,
} from "@agentmug/runtime";

export class FileAgentFileStore implements AgentFileStore {
  constructor(private readonly path: string) {}

  async load(): Promise<AgentFileV1> {
    return parseAgentFile(JSON.parse(await readFile(this.path, "utf8")));
  }

  async save(file: AgentFileV1): Promise<void> {
    await writeFile(this.path, serializeAgentFile(file), "utf8");
  }
}
