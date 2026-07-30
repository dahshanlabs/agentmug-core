# @agentmug/otel

OpenTelemetry tracing adapter for [@agentmug/runtime](https://npmjs.com/package/@agentmug/runtime). Emits LLM-call + transcription spans into your existing OTel SDK pipeline — Honeycomb, Datadog, Tempo, Jaeger, Sentry, anything that consumes OpenTelemetry.

```bash
npm install @agentmug/otel @opentelemetry/api
# plus whichever OTel SDK + exporter your stack uses
```

## Usage

Set up your OTel SDK once at process start (you almost certainly already have this in your app). Then plug the adapter into `runAgent()`:

```typescript
import { runAgent } from "@agentmug/runtime";
import { OtelTracingAdapter } from "@agentmug/otel";

const result = await runAgent({
  agentId: "...",
  userId: "...",
  userInput: "...",
  adapters: {
    persistence: yourPersistence,
    llm: yourLlmClient,
    tracing: new OtelTracingAdapter(),  // ← that's it
  },
  onEvent: () => {},
});
```

Every LLM call becomes a span with these attributes:
- `agentmug.run.id`
- `agentmug.agent.id`
- `agentmug.llm.model`
- `agentmug.llm.tokens`
- `agentmug.llm.cost_cents`
- `agentmug.llm.latency_ms`
- `agentmug.llm.input_preview` (truncated to 512 chars)
- `agentmug.llm.output_preview` (truncated to 512 chars)

Transcription calls get their own spans with provider + audio token counts.

## As a plugin

`createOtelPlugin()` packages the adapter as an `AgentMugPlugin`, which is handy
if you already pass plugins around. **It does not register tracing by itself** —
`InMemoryToolRegistry.loadPlugin` only reads `plugin.tools`, and this plugin
ships no tools. You still have to hand the adapter to `runAgent`:

```typescript
import { createOtelPlugin } from "@agentmug/otel";

const otelPlugin = createOtelPlugin();

await runAgent({
  // ...
  adapters: { tracing: otelPlugin.adapters.tracing },
});
```

If you are not already routing plugins through your own wiring, construct
`OtelTracingAdapter` directly as shown above — it is the same instance.

## Custom tracer

Pass your own `Tracer` if you need per-tenant tracing, test isolation, or want to attach resource attributes:

```typescript
import { trace } from "@opentelemetry/api";
new OtelTracingAdapter({
  tracer: trace.getTracer("my-app/agentmug", "2.1.0"),
});
```

## What this doesn't do

- **SDK setup** — every OTel pipeline is different. Configure your `NodeSDK` / `WebSDK` / exporter as you normally would.
- **Metrics** — token counts live as span attributes. If you want histograms, derive them from spans in your backend.
- **Logs** — the runtime's `onEvent` callback gives you token-by-token output. Wire that to your logging pipeline directly.

## License

Apache-2.0. Existing versions published under MIT remain MIT.
