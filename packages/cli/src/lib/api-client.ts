// Tiny HTTP client used by the CLI's cloud subcommands. Phase 28.
//
// Wraps the agentmug.com REST API with consistent auth + error
// handling so each command stays focused on its own logic. Auth
// comes from AGENTMUG_API_KEY env (a user-level `am_user_...`
// key). Host defaults to https://agentmug.com but can be
// overridden via AGENTMUG_HOST.

const DEFAULT_HOST = "https://agentmug.com";

export type ApiClientConfig = {
  host: string;
  apiKey: string;
};

export function loadConfig(): ApiClientConfig {
  const host = (process.env.AGENTMUG_HOST ?? DEFAULT_HOST).replace(/\/$/, "");
  const apiKey = (process.env.AGENTMUG_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new Error(
      "AGENTMUG_API_KEY env var is required for cloud subcommands.\n" +
        "Use an account key from Settings, or an agent-scoped key for invoke/reliability:\n" +
        "  export AGENTMUG_API_KEY=am_user_...",
    );
  }
  return { host, apiKey };
}

export async function apiRequest<T>(
  config: ApiClientConfig,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  options?: { headers?: Record<string, string> },
): Promise<T> {
  const url = `${config.host}${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...options?.headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      detail = parsed.error ?? parsed.message ?? text;
    } catch {
      /* leave raw */
    }
    throw new Error(
      `${method} ${path} → HTTP ${res.status}: ${detail.slice(0, 400)}`,
    );
  }
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

/**
 * Stream a Server-Sent Events response. Each `data:` line is
 * parsed as JSON and yielded. Used by `agentmug invoke` against
 * the /invoke/stream endpoint so long-running agents surface
 * progress instead of staring at a frozen socket.
 */
export async function* streamSse<T>(
  config: ApiClientConfig,
  method: "POST",
  path: string,
  body?: unknown,
): AsyncGenerator<T, void, void> {
  const url = `${config.host}${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `SSE ${method} ${path} → HTTP ${res.status}: ${text.slice(0, 400)}`,
    );
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try {
        yield JSON.parse(payload) as T;
      } catch {
        /* skip non-JSON heartbeats */
      }
    }
  }
}
