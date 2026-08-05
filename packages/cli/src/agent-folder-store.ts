// node:fs folder store for the portable Manager.
//
// Treats the DIRECTORY containing the agent you ran as a small fleet: every
// *.agent / *.agent.json file beside it is a manageable worker. list_agents
// scans it, create_agent writes a new file in, update_agent overwrites in
// place, invoke_agent loads a sibling and runs it. Mirrors FileAgentFileStore
// (single file) but over a folder.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  parseAgentFile,
  serializeAgentFile,
  toAsciiSlug,
  type AgentFileV1,
  type AgentFolderStore,
  type StoredAgent,
} from "@agentmug/runtime";

function slug(name: string): string {
  return toAsciiSlug(name, 48);
}

export class FileAgentFolderStore implements AgentFolderStore {
  private readonly dir: string;
  constructor(anyPathInFolder: string) {
    this.dir = dirname(anyPathInFolder);
  }

  async list(): Promise<StoredAgent[]> {
    let names: string[] = [];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: StoredAgent[] = [];
    for (const n of names) {
      if (!n.endsWith(".agent") && !n.endsWith(".agent.json")) continue;
      const path = join(this.dir, n);
      try {
        const file = parseAgentFile(JSON.parse(await readFile(path, "utf8")));
        out.push({
          id: file.id,
          name: file.name,
          description: file.description,
          path,
          file,
        });
      } catch {
        /* skip files that aren't valid agents */
      }
    }
    return out;
  }

  async get(idOrName: string): Promise<StoredAgent | null> {
    const all = await this.list();
    return (
      all.find((a) => a.id === idOrName) ??
      all.find((a) => a.name === idOrName) ??
      null
    );
  }

  async write(file: AgentFileV1): Promise<StoredAgent> {
    const existing = (await this.list()).find((a) => a.id === file.id);
    const path = existing?.path ?? join(this.dir, `${slug(file.name) || file.id}.agent`);
    await writeFile(path, serializeAgentFile(file), "utf8");
    return {
      id: file.id,
      name: file.name,
      description: file.description,
      path,
      file,
    };
  }
}
