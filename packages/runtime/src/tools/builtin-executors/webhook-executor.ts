// Portable webhook tool executor.
//
// A WebhookToolReference in a blueprint declares a fixed URL + method; the LLM
// supplies a JSON payload as the tool input. This executor calls that URL with
// the payload and returns the response — the generic "POST my data somewhere"
// tool. Browser-safe (global fetch); same net-guard as web.fetch_json
// (HTTPS-only by default, private/loopback hosts blocked, timeout, body cap),
// so a webhook tool can't be turned into an SSRF lever. One executor, shared
// by cloud, desktop, and CLI.

import type { ToolExecutor, ToolExecutionContext } from "../registry";
import type {
  ToolReference,
  WebhookToolReference,
} from "../../format/agent-file";
import type { WebhookToolDefinition } from "../types";
import { isPrivateHost, readEnv } from "./net-guard";

const RESPONSE_CAP_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

export class WebhookExecutor implements ToolExecutor {
  constructor(
    private readonly def: {
      url: string;
      method?: string;
      name?: string;
      requiresUserAuth?: boolean;
    },
  ) {}

  async execute(input: unknown, ctx: ToolExecutionContext): Promise<unknown> {
    let target: URL;
    try {
      target = new URL(this.def.url);
    } catch {
      return {
        status: "error",
        message: `Invalid webhook URL: ${this.def.url}`,
      };
    }
    if (
      target.protocol !== "https:" &&
      readEnv("WEBHOOK_ALLOW_HTTP") !== "true"
    ) {
      return {
        status: "error",
        message:
          "Webhook URL must be HTTPS (set WEBHOOK_ALLOW_HTTP=true for local dev).",
      };
    }
    if (isPrivateHost(target.hostname)) {
      return {
        status: "error",
        message: `Refusing to call private/loopback host '${target.hostname}'.`,
      };
    }

    const method = (this.def.method ?? "POST").toUpperCase();
    const args = (input ?? {}) as Record<string, unknown>;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/plain;q=0.9, */*;q=0.5",
      "User-Agent": "AgentMug-Runtime webhook",
    };
    if (this.def.requiresUserAuth) {
      const provider = `webhook:${this.def.name ?? "default"}`;
      const resolved = await ctx.credentialResolver?.resolve(provider, {
        signal: ctx.signal,
      });
      if (!resolved?.accessToken) {
        throw new Error(
          `Authenticated webhook '${this.def.name ?? "webhook"}' needs local credential '${provider}'.`,
        );
      }
      headers.Authorization = `${resolved.tokenType ?? "Bearer"} ${resolved.accessToken}`;
    }

    let body: string | undefined;
    if (method === "GET" || method === "DELETE") {
      for (const [k, v] of Object.entries(args)) {
        target.searchParams.set(
          k,
          typeof v === "object" ? JSON.stringify(v) : String(v),
        );
      }
    } else {
      body = JSON.stringify(args);
    }

    // Honor the run's abort signal AND a hard timeout.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    ctx.signal?.addEventListener("abort", onAbort);

    let res: Response;
    try {
      res = await fetch(target.toString(), {
        method,
        headers,
        body,
        // A public URL redirecting to loopback/private space would bypass the
        // preflight above. Refuse redirects; webhook endpoints must be final.
        redirect: "error",
        signal: controller.signal,
      });
    } catch (err) {
      const message =
        err instanceof Error
          ? err.name === "AbortError"
            ? `Webhook request aborted/timed out after ${DEFAULT_TIMEOUT_MS}ms`
            : err.message
          : String(err);
      return { status: "error", message };
    } finally {
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", onAbort);
    }

    const raw = await res.text();
    const truncated = raw.length > RESPONSE_CAP_BYTES;
    const capped = truncated ? raw.slice(0, RESPONSE_CAP_BYTES) : raw;
    const ct = res.headers.get("content-type");
    let parsed: unknown = capped;
    if (ct && /json/i.test(ct) && capped.trim()) {
      try {
        parsed = JSON.parse(capped);
      } catch {
        parsed = capped;
      }
    }
    return {
      status: res.ok ? "ok" : "http_error",
      http_status: res.status,
      body: parsed,
      truncated,
    };
  }
}

/** Build a webhook ToolDefinition from a blueprint webhook ref. Input schema is
 *  permissive (the LLM sends an arbitrary JSON payload to the URL). */
export function webhookToolDefinition(
  ref: WebhookToolReference,
): WebhookToolDefinition {
  return {
    type: "webhook",
    name: ref.name,
    description:
      ref.description ?? `Send a JSON payload to the ${ref.name} webhook.`,
    url: ref.url,
    method: ref.method,
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
  };
}

/** Register every webhook tool the agent declares onto a registry. One call
 *  from any host (cloud/desktop/CLI) — portable. */
export function registerWebhookTools(
  registry: { register: (d: WebhookToolDefinition, e: ToolExecutor) => void },
  refs: ToolReference[],
): void {
  for (const ref of refs) {
    if (ref.kind === "webhook") {
      const def = webhookToolDefinition(ref);
      registry.register(
        def,
        new WebhookExecutor({
          ...def,
          requiresUserAuth: ref.requiresUserAuth === true,
        }),
      );
    }
  }
}
