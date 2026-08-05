// Tool type shapes.
//
// Four tool categories cover the surfaces the platform must support:
//   - inline:  executes via an in-process JS function. Phase 1a uses
//              this for builtin tools (e.g. create_reminder) whose
//              executors live alongside the runtime caller.
//   - webhook: HTTP call to a URL with a payload — type only, no
//              executor yet.
//   - oauth:   webhook-like, authenticated with a user-specific OAuth
//              token retrieved at run time — type only, no executor.
//   - mcp:     proxied to an MCP server — type only, no executor.

import type { ActionEffectDefinition } from "../actions/types";

type ToolEffectMetadata = {
  /** Declares a real-world effect and the proof needed to call it successful. */
  effect?: ActionEffectDefinition;
};

export type InlineToolDefinition = ToolEffectMetadata & {
  type: "inline";
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type WebhookToolDefinition = ToolEffectMetadata & {
  type: "webhook";
  name: string;
  description: string;
  url: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  inputSchema?: Record<string, unknown>;
};

export type OAuthToolDefinition = ToolEffectMetadata & {
  type: "oauth";
  name: string;
  description: string;
  provider: string;
  scopes: string[];
  url: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  inputSchema?: Record<string, unknown>;
};

export type McpToolDefinition = ToolEffectMetadata & {
  type: "mcp";
  name: string;
  description: string;
  serverUrl: string;
  toolName: string;
};

export type ToolDefinition =
  | InlineToolDefinition
  | WebhookToolDefinition
  | OAuthToolDefinition
  | McpToolDefinition;
