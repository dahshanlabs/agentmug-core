// Plugin API — the extension point for third-party packages.
//
// Phase 30. Until now, adding a new built-in tool required editing
// `@agentmug/runtime` itself. Custom executors could be registered
// at the call site via `tools.register(definition, executor)`, but
// there was no canonical way for an npm package to ship a coherent
// bundle of definitions + executors + (optional) adapter
// implementations.
//
// `definePlugin()` is that canonical shape. A plugin author exports
// the result, the consumer calls `registry.loadPlugin(plugin)`,
// every tool the plugin defines is registered in one call.
//
// Example plugin package shape:
//
//   // @agentmug-plugins/hackernews/index.ts
//   import { definePlugin } from "@agentmug/runtime";
//
//   export default definePlugin({
//     name: "hackernews",
//     version: "1.0.0",
//     tools: [
//       {
//         definition: hnSearchDefinition,
//         executor: new HnSearchExecutor(),
//       },
//     ],
//   });
//
//   // Consumer
//   import hnPlugin from "@agentmug-plugins/hackernews";
//   const tools = new InMemoryToolRegistry();
//   tools.loadPlugin(hnPlugin);
//
// Plugins can also carry adapter implementations (LlmClient,
// PersistenceAdapter, TracingAdapter) for ecosystem packages that
// want to ship "an OpenTelemetry-flavored AgentMug" or "an SQLite
// persistence variant" as a single import.

import type { LlmClient } from "./adapters/llm";
import type { PersistenceAdapter } from "./adapters/persistence";
import type { TracingAdapter } from "./adapters/tracing";
import type {
  BrainAdapter,
  KnowledgeAdapter,
  ReceiptAdapter,
  SourceAdapter,
} from "./sources/adapters";
import type { ToolDefinition } from "./tools/types";
import type { ToolExecutor } from "./tools/registry";

/**
 * One registered tool inside a plugin — a definition (schema +
 * description) paired with its executor (runtime behavior).
 */
export type PluginTool = {
  definition: ToolDefinition;
  executor: ToolExecutor;
};

/**
 * Adapter bundle a plugin can ship. All fields optional — a plugin
 * that only adds tools doesn't need to populate this.
 *
 * Future-compatible: this object is extended (additive only) as
 * new adapter types ship (TranscriptionAdapter, RemindersAdapter,
 * etc.). Plugins built against older versions keep working because
 * they only set the fields they know about.
 */
export type PluginAdapters = {
  llm?: LlmClient;
  persistence?: PersistenceAdapter;
  tracing?: TracingAdapter;
  /** Raw local/provider artifact adapters contributed by the plugin. */
  sources?: SourceAdapter[];
  /** Optional retrieval/index implementation for source evidence. */
  knowledge?: KnowledgeAdapter;
  /** Optional curated durable-memory implementation (e.g. Klypix). */
  brain?: BrainAdapter;
  /** Optional run-receipt persistence implementation. */
  receipts?: ReceiptAdapter;
};

/**
 * The shape returned by `definePlugin()`. Pure data — easy to
 * serialize, easy to inspect, easy to merge.
 */
export type AgentMugPlugin = {
  /** Stable npm-style identifier (e.g. "hackernews", "notion"). */
  name: string;
  /** Semver string the plugin author manages. */
  version: string;
  /** Tools the plugin registers. */
  tools?: PluginTool[];
  /** Adapter implementations the plugin offers. */
  adapters?: PluginAdapters;
  /**
   * Free-form metadata for catalog discovery, billing, marketing
   * surface (docs link, support link, etc.). Not consumed by the
   * runtime.
   */
  metadata?: Record<string, unknown>;
};

/**
 * Identity helper so plugins can use a typed builder rather than
 * literal objects. Catches missing fields at compile time and lets
 * IDEs autocomplete plugin shape.
 *
 * Returns the input unchanged at runtime — pure passthrough.
 */
export function definePlugin(plugin: AgentMugPlugin): AgentMugPlugin {
  if (!plugin.name) {
    throw new Error("Plugin missing `name`.");
  }
  if (!plugin.version) {
    throw new Error(`Plugin "${plugin.name}" missing \`version\`.`);
  }
  return plugin;
}
