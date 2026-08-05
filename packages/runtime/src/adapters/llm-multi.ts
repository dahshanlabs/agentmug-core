// Multi-provider LlmClient — routes each streamMessage call to the
// right underlying client (Anthropic / OpenAI / Gemini / any
// OpenAI-compatible vendor) based on the model id.
//
// Why this exists: the engine doesn't know or care which provider it's
// talking to — it just calls `streamMessage({ model, ... })`. The
// MultiLlmClient delegates per call so an agent declaring
// `primaryModel: "gpt-4o"` runs against OpenAI while another agent on
// the same instance using `primaryModel: "claude-sonnet-4-6"` runs
// against Anthropic. Same engine, same persistence, same execution
// loop.
//
// Routing rules (deliberately conservative — string prefix match):
//   - `claude-*` / `anthropic.*` → Anthropic
//   - `gpt-*` / `o1-*` / `o3-*` / `o4-*` / `openai.*` → OpenAI
//   - `gemini-*` / `google.*` → Gemini
//   - `deepseek-*` → DeepSeek · `glm-*` → Zhipu/Z.ai · `kimi-*`/`moonshot-*`
//     → Moonshot · `qwen*` → Alibaba DashScope intl · `minimax*` → MiniMax
//     · `grok-*` → xAI · `mistral-*` → Mistral — all via their
//     OpenAI-compatible endpoints (same OpenAiLlmClient, different baseURL).
//   - `vendor/model` (slash format) → OpenRouter.
//   - anything else → OpenRouter when configured, else throws before the
//     call so callers can fall back or surface a clear message.

import {
  AnthropicLlmClient,
  type AnthropicLlmClientOptions,
} from "./llm";
import type {
  LlmClient,
  LlmStreamEvent,
  LlmStreamParams,
} from "./llm";
import {
  OpenAiLlmClient,
  type OpenAiLlmClientOptions,
} from "./llm-openai";
import {
  GeminiLlmClient,
  type GeminiLlmClientOptions,
} from "./llm-gemini";

/** Providers with first-class adapters. */
export type LlmProvider = "anthropic" | "openai" | "gemini" | CompatProvider;

/** Providers served through the OpenAI-compatible adapter + a base URL. */
export type CompatProvider =
  | "deepseek"
  | "zhipu"
  | "moonshot"
  | "qwen"
  | "minimax"
  | "xai"
  | "mistral"
  | "openrouter";

/** Metadata for one OpenAI-compatible vendor. */
export type CompatProviderInfo = {
  prefixes: string[];
  envKey: string;
  envBaseUrl: string;
  baseURL: string;
  /** Human label for BYOK pickers (desktop Settings, CLI help). */
  label: string;
  /** Data-residency note surfaced in the picker (best-effort). */
  residency?: string;
  /** Where the user gets a key — shown under the field. */
  keysUrl?: string;
  /** Example model id for the picker hint. */
  exampleModel?: string;
};

/**
 * OpenAI-compatible vendor endpoints. envKey/envBaseUrl are what
 * createMultiLlmClientFromEnv reads; baseURL is the default endpoint.
 * label/residency/keysUrl/exampleModel drive the BYOK pickers so the
 * desktop + CLI never hardcode a second copy of this list.
 */
export const OPENAI_COMPAT_PROVIDERS: Record<CompatProvider, CompatProviderInfo> = {
  deepseek: {
    prefixes: ["deepseek-"],
    envKey: "DEEPSEEK_API_KEY",
    envBaseUrl: "DEEPSEEK_BASE_URL",
    baseURL: "https://api.deepseek.com",
    label: "DeepSeek",
    residency: "China",
    keysUrl: "https://platform.deepseek.com/api_keys",
    exampleModel: "deepseek-chat",
  },
  zhipu: {
    prefixes: ["glm-"],
    envKey: "ZHIPU_API_KEY",
    envBaseUrl: "ZHIPU_BASE_URL",
    baseURL: "https://api.z.ai/api/paas/v4",
    label: "Zhipu / GLM (Z.ai)",
    residency: "China",
    keysUrl: "https://z.ai/manage-apikey/apikey-list",
    exampleModel: "glm-4.6",
  },
  moonshot: {
    prefixes: ["kimi-", "moonshot-"],
    envKey: "MOONSHOT_API_KEY",
    envBaseUrl: "MOONSHOT_BASE_URL",
    baseURL: "https://api.moonshot.ai/v1",
    label: "Moonshot / Kimi",
    residency: "China",
    keysUrl: "https://platform.moonshot.ai/console/api-keys",
    exampleModel: "kimi-k3",
  },
  qwen: {
    prefixes: ["qwen"],
    envKey: "DASHSCOPE_API_KEY",
    envBaseUrl: "DASHSCOPE_BASE_URL",
    baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    label: "Qwen (Alibaba DashScope)",
    residency: "Singapore (intl)",
    keysUrl: "https://bailian.console.alibabacloud.com/",
    exampleModel: "qwen-max",
  },
  minimax: {
    prefixes: ["minimax"],
    envKey: "MINIMAX_API_KEY",
    envBaseUrl: "MINIMAX_BASE_URL",
    baseURL: "https://api.minimax.io/v1",
    label: "MiniMax",
    residency: "China",
    keysUrl: "https://www.minimax.io/platform/user-center/basic-information/interface-key",
    exampleModel: "minimax-m2",
  },
  xai: {
    prefixes: ["grok-"],
    envKey: "XAI_API_KEY",
    envBaseUrl: "XAI_BASE_URL",
    baseURL: "https://api.x.ai/v1",
    label: "xAI (Grok)",
    residency: "US",
    keysUrl: "https://console.x.ai/",
    exampleModel: "grok-4",
  },
  mistral: {
    prefixes: ["mistral-", "codestral-", "ministral-", "magistral-", "pixtral-", "devstral-", "voxtral-", "open-mistral-", "open-mixtral-"],
    envKey: "MISTRAL_API_KEY",
    envBaseUrl: "MISTRAL_BASE_URL",
    baseURL: "https://api.mistral.ai/v1",
    label: "Mistral",
    residency: "EU",
    keysUrl: "https://console.mistral.ai/api-keys",
    exampleModel: "mistral-large-latest",
  },
  openrouter: {
    prefixes: [], // slash-format ids and (when configured) unknown prefixes
    envKey: "OPENROUTER_API_KEY",
    envBaseUrl: "OPENROUTER_BASE_URL",
    baseURL: "https://openrouter.ai/api/v1",
    label: "OpenRouter (~300 models)",
    residency: "US (router)",
    keysUrl: "https://openrouter.ai/keys",
    exampleModel: "anthropic/claude-sonnet-4.5",
  },
};

/** Native (non-compat) providers, for the BYOK pickers. */
export type NativeProvider = "anthropic" | "openai" | "gemini";
export const NATIVE_PROVIDERS: Record<
  NativeProvider,
  { label: string; envKey: string; residency?: string; keysUrl?: string; exampleModel?: string }
> = {
  anthropic: {
    label: "Anthropic (Claude)",
    envKey: "ANTHROPIC_API_KEY",
    residency: "US",
    keysUrl: "https://console.anthropic.com/settings/keys",
    exampleModel: "claude-sonnet-4-6",
  },
  openai: {
    label: "OpenAI",
    envKey: "OPENAI_API_KEY",
    residency: "US",
    keysUrl: "https://platform.openai.com/api-keys",
    exampleModel: "gpt-4o",
  },
  gemini: {
    label: "Google Gemini",
    envKey: "GEMINI_API_KEY",
    residency: "US",
    keysUrl: "https://aistudio.google.com/apikey",
    exampleModel: "gemini-2.5-pro",
  },
};

export function detectProvider(model: string): LlmProvider | null {
  // Slash FIRST: "openai/gpt-4o" is an OpenRouter id, not an OpenAI one.
  // (Keeps this router in lockstep with the api-server's detectProviderKey.)
  if (model.includes("/")) {
    return "openrouter";
  }
  const lower = model.toLowerCase();
  if (lower.startsWith("claude-") || lower.startsWith("anthropic.")) {
    return "anthropic";
  }
  if (
    lower.startsWith("gpt-") ||
    lower === "o1" ||
    lower === "o3" ||
    lower === "o4" ||
    lower.startsWith("o1-") ||
    lower.startsWith("o3-") ||
    lower.startsWith("o4-") ||
    lower.startsWith("openai.")
  ) {
    return "openai";
  }
  if (lower.startsWith("gemini-") || lower.startsWith("google.")) {
    return "gemini";
  }
  for (const [key, info] of Object.entries(OPENAI_COMPAT_PROVIDERS)) {
    if (info.prefixes.some((p) => lower.startsWith(p))) {
      return key as CompatProvider;
    }
  }
  return null;
}

/**
 * A user-supplied OpenAI-compatible endpoint — Ollama, LM Studio, vLLM,
 * or any self-hosted server. Routed by explicit model list or the
 * reserved `local/` / `custom/` namespace, never by vendor prefix.
 */
export type CustomEndpointOptions = Omit<OpenAiLlmClientOptions, "apiKey"> & {
  /** Optional — local servers (Ollama) accept any/no key; a placeholder is
   *  sent when omitted so the SDK constructor doesn't reject an empty key. */
  apiKey?: string;
  /** Model ids this endpoint serves (e.g. ["llama3.1", "qwen2.5-coder"]).
   *  A model id also routes here if it starts with `local/` or `custom/`. */
  models?: string[];
};

export type MultiLlmClientOptions = {
  anthropic?: AnthropicLlmClientOptions;
  openai?: OpenAiLlmClientOptions;
  gemini?: GeminiLlmClientOptions;
  /** Serve Gemini through its OpenAI-compatible endpoint (via OpenAiLlmClient)
   *  instead of the native SDK — the path a webview host uses so it can inject
   *  a custom fetch (the native @google/genai SDK can't take one). baseURL
   *  defaults to GEMINI_OPENAI_BASE_URL. Wins over `gemini` when both are set. */
  geminiViaOpenAI?: OpenAiLlmClientOptions;
  /** OpenAI-compatible vendors (DeepSeek, Zhipu, Moonshot, Qwen, MiniMax,
   *  xAI, Mistral, OpenRouter) — each is an OpenAiLlmClient with its own
   *  apiKey + baseURL. */
  compat?: Partial<Record<CompatProvider, OpenAiLlmClientOptions>>;
  /** A local / self-hosted OpenAI-compatible endpoint (Ollama, LM Studio). */
  custom?: CustomEndpointOptions;
};

/** Reserved namespaces that force routing to the custom/local endpoint. */
const CUSTOM_NAMESPACES = ["local/", "custom/"];

/** Gemini's OpenAI-compatible endpoint — lets an OpenAiLlmClient (which accepts
 *  a custom fetch) serve Gemini, so a webview host can reach it without CORS. */
export const GEMINI_OPENAI_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai/";

export class MultiLlmClient implements LlmClient {
  private anthropicClient: AnthropicLlmClient | null = null;
  private openaiClient: OpenAiLlmClient | null = null;
  private geminiClient: LlmClient | null = null;
  private compatClients = new Map<CompatProvider, OpenAiLlmClient>();
  private customClient: OpenAiLlmClient | null = null;
  private customModels = new Set<string>();

  constructor(options: MultiLlmClientOptions) {
    if (options.anthropic) {
      this.anthropicClient = new AnthropicLlmClient(options.anthropic);
    }
    if (options.openai) {
      this.openaiClient = new OpenAiLlmClient(options.openai);
    }
    // geminiViaOpenAI wins over the native SDK: the native @google/genai SDK
    // can't take a custom fetch, so a webview host (desktop) routes Gemini
    // through its OpenAI-compatible endpoint via the OpenAiLlmClient instead.
    if (options.geminiViaOpenAI) {
      this.geminiClient = new OpenAiLlmClient({
        baseURL: GEMINI_OPENAI_BASE_URL,
        ...options.geminiViaOpenAI,
      });
    } else if (options.gemini) {
      this.geminiClient = new GeminiLlmClient(options.gemini);
    }
    for (const [key, opts] of Object.entries(options.compat ?? {})) {
      if (opts) {
        this.compatClients.set(key as CompatProvider, new OpenAiLlmClient(opts));
      }
    }
    if (options.custom?.baseURL) {
      // A local model isn't a reasoning model even if named "gpt-5-*", so
      // force plain max_tokens unless the caller overrode it. apiKey is
      // optional (Ollama needs none) — pass a placeholder so the SDK ctor
      // doesn't reject an empty key.
      this.customClient = new OpenAiLlmClient({
        forcePlainMaxTokens: true,
        ...options.custom,
        apiKey: options.custom.apiKey || "local",
      });
      for (const m of options.custom.models ?? []) {
        this.customModels.add(m.toLowerCase());
      }
    }
  }

  private isCustomModel(model: string): boolean {
    if (!this.customClient) return false;
    const lower = model.toLowerCase();
    return (
      CUSTOM_NAMESPACES.some((ns) => lower.startsWith(ns)) ||
      this.customModels.has(lower)
    );
  }

  /** True if at least one provider is configured. */
  hasAnyProvider(): boolean {
    return Boolean(
      this.anthropicClient ||
        this.openaiClient ||
        this.geminiClient ||
        this.compatClients.size > 0 ||
        this.customClient,
    );
  }

  streamMessage(params: LlmStreamParams): AsyncIterable<LlmStreamEvent> {
    // A local/custom endpoint wins first — its models (e.g. "llama3.1") would
    // otherwise fall through to the OpenRouter fallback and mis-route.
    if (this.isCustomModel(params.model) && this.customClient) {
      return this.customClient.streamMessage(params);
    }
    let provider = detectProvider(params.model);
    // Unknown prefix: OpenRouter serves ~300 models under explicit vendor ids,
    // so when it's configured we hand it the id verbatim rather than failing.
    // A custom endpoint (if configured) takes precedence over OpenRouter for
    // unknown ids so a self-hosted server isn't shadowed by the router.
    if (provider === null && this.customClient) {
      return this.customClient.streamMessage(params);
    }
    if (provider === null && this.compatClients.has("openrouter")) {
      provider = "openrouter";
    }
    if (provider === "anthropic") {
      if (!this.anthropicClient) {
        throw new Error(
          `Agent uses Anthropic model '${params.model}' but ANTHROPIC_API_KEY is not configured on this server.`,
        );
      }
      return this.anthropicClient.streamMessage(params);
    }
    if (provider === "openai") {
      if (!this.openaiClient) {
        throw new Error(
          `Agent uses OpenAI model '${params.model}' but OPENAI_API_KEY is not configured on this server.`,
        );
      }
      return this.openaiClient.streamMessage(params);
    }
    if (provider === "gemini") {
      if (!this.geminiClient) {
        throw new Error(
          `Agent uses Gemini model '${params.model}' but GEMINI_API_KEY is not configured on this server.`,
        );
      }
      return this.geminiClient.streamMessage(params);
    }
    if (provider !== null) {
      const client = this.compatClients.get(provider);
      if (!client) {
        const info = OPENAI_COMPAT_PROVIDERS[provider];
        throw new Error(
          `Agent uses model '${params.model}' (provider: ${provider}) but ${info.envKey} is not configured on this server.`,
        );
      }
      return client.streamMessage(params);
    }
    throw new Error(
      `Unknown LLM provider for model '${params.model}'. Supported prefixes: claude-, gpt-, o1, o3, o4, gemini-, deepseek-, glm-, kimi-, moonshot-, qwen, minimax, grok-, mistral-, anthropic., openai., google. — or set OPENROUTER_API_KEY and use a 'vendor/model' id.`,
    );
  }
}

/**
 * Convenience factory — reads ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY
 * and every OpenAI-compatible vendor key (DEEPSEEK_API_KEY, ZHIPU_API_KEY,
 * MOONSHOT_API_KEY, DASHSCOPE_API_KEY, MINIMAX_API_KEY, XAI_API_KEY,
 * MISTRAL_API_KEY, OPENROUTER_API_KEY) from process.env and builds a
 * MultiLlmClient with whichever ones are set. Use directly in server
 * entrypoints; the desktop runtime uses its own credential-source pattern.
 */
/**
 * Build a MultiLlmClient from an explicit options object — the entrypoint
 * for front-ends (desktop, CLI) whose BYOK keys live in a settings store /
 * keychain, not process.env. `createMultiLlmClientFromEnv` is the env-backed
 * sibling; both end at `new MultiLlmClient(options)`.
 */
export function createMultiLlmClient(options: MultiLlmClientOptions): MultiLlmClient {
  return new MultiLlmClient(options);
}

export function createMultiLlmClientFromEnv(env: NodeJS.ProcessEnv = process.env): MultiLlmClient {
  const options: MultiLlmClientOptions = {};
  if (env.ANTHROPIC_API_KEY) {
    options.anthropic = { apiKey: env.ANTHROPIC_API_KEY };
  } else if (env.AI_INTEGRATIONS_ANTHROPIC_API_KEY) {
    options.anthropic = {
      apiKey: env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
      baseURL: env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
    };
  }
  if (env.OPENAI_API_KEY) {
    options.openai = {
      apiKey: env.OPENAI_API_KEY,
      baseURL: env.OPENAI_BASE_URL,
    };
  }
  if (env.GEMINI_API_KEY) {
    options.gemini = {
      apiKey: env.GEMINI_API_KEY,
      baseURL: env.GEMINI_BASE_URL,
    };
  }
  const compat: NonNullable<MultiLlmClientOptions["compat"]> = {};
  for (const [key, info] of Object.entries(OPENAI_COMPAT_PROVIDERS)) {
    const apiKey = env[info.envKey];
    if (apiKey) {
      compat[key as CompatProvider] = {
        apiKey,
        baseURL: env[info.envBaseUrl] || info.baseURL,
      };
    }
  }
  if (Object.keys(compat).length > 0) {
    options.compat = compat;
  }
  // A local / self-hosted OpenAI-compatible endpoint (Ollama, LM Studio, vLLM).
  // AGENTMUG_CUSTOM_BASE_URL is the switch; models is a comma list.
  if (env.AGENTMUG_CUSTOM_BASE_URL) {
    options.custom = {
      baseURL: env.AGENTMUG_CUSTOM_BASE_URL,
      apiKey: env.AGENTMUG_CUSTOM_API_KEY,
      models: (env.AGENTMUG_CUSTOM_MODELS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    };
  }
  return new MultiLlmClient(options);
}
