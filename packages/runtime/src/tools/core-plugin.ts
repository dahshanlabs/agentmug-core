// First-party core-tools plugin — the infra-free compute tools, with
// executors, shipped INSIDE @agentmug/runtime.
//
// Why this exists: the runtime shipped tool DEFINITIONS but no executors, so
// every host (cloud, CLI, desktop) hand-reimplemented the same wire logic —
// and the CLI/desktop simply never wired the compute tools, so a portable
// .agent doing web fetches or CSV analysis validated everywhere but
// dead-ended with "Unknown tool" off-cloud. That broke the core promise:
// "one worker file, four places to run it."
//
// These three tools need ZERO host infrastructure and ZERO credentials —
// pure HTTP + parsing — so they can live in the portable package and be
// registered with one call:
//
//   import { createCoreToolsPlugin, InMemoryToolRegistry } from "@agentmug/runtime";
//   const registry = new InMemoryToolRegistry();
//   registry.loadPlugin(createCoreToolsPlugin());
//
// Or register only the subset an agent declares (see registerCoreToolsFor).
//
// Credentialed compute tools (web.research, image.generate, code.execute)
// and DB-backed tools (memory.*) are deliberately NOT here — they need a
// credential resolver / host infra and land in a later slice.

import type { AgentMugPlugin } from "../plugins";
import { definePlugin } from "../plugins";
import type { ToolRegistry } from "./registry";
import { fetchUrlDefinition } from "./builtin/fetch-url";
import { fetchJsonDefinition } from "./builtin/fetch-json";
import { queryCsvDefinition } from "./builtin/query-csv";
import { FetchUrlExecutor } from "./builtin-executors/fetch-url-executor";
import { FetchJsonExecutor } from "./builtin-executors/fetch-json-executor";
import { QueryCsvExecutor } from "./builtin-executors/query-csv-executor";

/**
 * The infra-free core tools (definition + executor): `fetch_url`,
 * `web.fetch_json`, `query_csv`. No credentials, no host services.
 */
export function createCoreToolsPlugin(): AgentMugPlugin {
  return definePlugin({
    name: "core-tools",
    version: "1.0.0",
    tools: [
      { definition: fetchUrlDefinition, executor: new FetchUrlExecutor() },
      { definition: fetchJsonDefinition, executor: new FetchJsonExecutor() },
      { definition: queryCsvDefinition, executor: new QueryCsvExecutor() },
    ],
    metadata: {
      description: "Infra-free compute tools: HTTP fetch, JSON API, CSV analysis.",
    },
  });
}

/**
 * Register ONLY the core tools an agent actually declares, so the LLM isn't
 * handed tools the agent's blueprint didn't ask for. `declaredToolNames` is
 * the agent's tool list (e.g. `agentFile.blueprint.tools` in string form).
 * Returns the names that were registered.
 */
export function registerCoreToolsFor(
  registry: ToolRegistry,
  declaredToolNames: readonly string[],
): string[] {
  const declared = new Set(declaredToolNames);
  const registered: string[] = [];
  for (const tool of createCoreToolsPlugin().tools ?? []) {
    if (declared.has(tool.definition.name)) {
      registry.register(tool.definition, tool.executor);
      registered.push(tool.definition.name);
    }
  }
  return registered;
}
