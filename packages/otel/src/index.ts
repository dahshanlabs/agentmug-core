// @agentmug/otel — OpenTelemetry tracing adapter for the runtime.
//
// Phase 30. Production teams already have OTel pipelines (Honeycomb,
// Datadog, Tempo, Jaeger, Sentry). Without this adapter, AgentMug
// runs are invisible to those pipelines and the observability team
// has to glue something together. With it: drop in, point at your
// existing OTel SDK, every LLM call + transcription becomes a span
// in your existing dashboards.
//
// Design:
//   - `OtelTracingAdapter` implements the runtime's `TracingAdapter`
//     interface 1:1. The mapping is:
//       recordLlmCall(event)  → start span, set attributes, end
//       recordTranscription(event) → same
//   - The adapter takes a Tracer instance (or pulls the default
//     "@agentmug/runtime" tracer from the global trace provider).
//     This lets consumers pre-configure trace context (resource
//     attrs, sampler, exporters) before handing the Tracer over.
//   - As an AgentMug plugin: export a `definePlugin()` result so
//     consumers can `tools.loadPlugin(otelPlugin)` rather than
//     constructing manually. Both APIs work.
//
// What's NOT here:
//   - SDK setup (the consumer's job — every OTel pipeline differs).
//   - Span exporting (OTel handles it; we just emit spans).
//   - Metrics (LLM tokens belong as span attributes; if a consumer
//     wants histograms they can wire those from span attrs).

import { SpanStatusCode, type Tracer, trace } from "@opentelemetry/api";
import {
  definePlugin,
  type AgentMugPlugin,
  type LlmCallTrace,
  type TracingAdapter,
  type TranscriptionTrace,
} from "@agentmug/runtime";

const TRACER_NAME = "@agentmug/runtime";

/**
 * TracingAdapter that emits OTel spans for every LLM call +
 * transcription. Pass a Tracer to override the default
 * (`trace.getTracer("@agentmug/runtime")`) — useful for test
 * isolation or per-tenant tracers.
 */
export class OtelTracingAdapter implements TracingAdapter {
  private tracer: Tracer;

  constructor(options: { tracer?: Tracer } = {}) {
    this.tracer = options.tracer ?? trace.getTracer(TRACER_NAME);
  }

  async recordLlmCall(event: LlmCallTrace): Promise<void> {
    // Use a manual start/end pair so we can backdate the start
    // timestamp to when the LLM call actually began. The event's
    // `latencyMs` is the wall-clock duration.
    const startTime = Date.now() - event.latencyMs;
    const span = this.tracer.startSpan(event.name ?? "llm.call", {
      startTime,
      attributes: {
        "agentmug.run.id": event.runId,
        "agentmug.agent.id": event.agentId,
        "agentmug.llm.model": event.model,
        "agentmug.llm.tokens": event.tokens,
        "agentmug.llm.cost_cents": event.costCents,
        "agentmug.llm.latency_ms": event.latencyMs,
        // Keep input + output as preview-only attributes — full
        // bodies belong in a span event if you want them, but
        // attributes have practical length limits (32KB in most
        // collectors).
        "agentmug.llm.input_preview": preview(event.input, 512),
        "agentmug.llm.output_preview": preview(event.output, 512),
      },
    });
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
  }

  async recordTranscription(event: TranscriptionTrace): Promise<void> {
    const startTime = Date.now() - event.latencyMs;
    const span = this.tracer.startSpan("transcription", {
      startTime,
      attributes: {
        "agentmug.transcription.provider": event.provider,
        "agentmug.transcription.audio_tokens": event.audioTokens ?? undefined,
        "agentmug.transcription.latency_ms": event.latencyMs,
      },
    });
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
  }
}

function preview(value: string | undefined, max: number): string {
  if (!value) return "";
  if (value.length <= max) return value;
  return value.slice(0, max) + `…(truncated ${value.length - max} chars)`;
}

/**
 * AgentMug plugin packaging the OTel adapter, for consumers who already
 * pass plugins around rather than constructing adapters by hand.
 *
 * NOTE: loading this into a registry does NOT enable tracing.
 * `InMemoryToolRegistry.loadPlugin` iterates `plugin.tools` only and never
 * reads `plugin.adapters`, and this plugin ships no tools — so
 * `tools.loadPlugin(createOtelPlugin())` is a no-op. Pass the adapter to the
 * run explicitly: `runAgent({ adapters: { tracing: plugin.adapters.tracing } })`.
 *
 * The plugin's `adapters.tracing` is the same instance the
 * standalone `OtelTracingAdapter` constructor produces.
 */
export function createOtelPlugin(
  options: { tracer?: Tracer } = {},
): AgentMugPlugin {
  return definePlugin({
    name: "@agentmug/otel",
    version: "0.1.0",
    adapters: {
      tracing: new OtelTracingAdapter(options),
    },
    metadata: {
      docs: "https://github.com/dahshanlabs/agentmug-core/tree/main/packages/otel",
    },
  });
}

export default createOtelPlugin;
