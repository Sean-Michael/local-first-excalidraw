/**
 * OpenTelemetry tracing for the assistant, the MCP server and drawing operations.
 *
 * Off unless an OTLP endpoint (`OTEL_EXPORTER_OTLP_ENDPOINT` or `_TRACES_ENDPOINT`, sent as
 * http/protobuf) or `LFX_TRACE_FILE` (JSON lines) is set. Spans follow the OpenTelemetry GenAI
 * semantic conventions, plus the OpenInference attributes Phoenix uses for its LLM views.
 * Prompts, replies and tool payloads are recorded only with
 * `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true`.
 */
import fs from "node:fs";
import { type Attributes, type Context, context, type Link, propagation, type Span, type SpanContext, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, NodeTracerProvider, type ReadableSpan, SimpleSpanProcessor, type SpanExporter, type SpanProcessor } from "@opentelemetry/sdk-trace-node";
import { VERSION } from "./config.js";

export { SpanKind };
export type { Span, SpanContext };

const MAX_CONTENT_CHARS = 16_000;
const tracer = trace.getTracer("local-first-excalidraw", VERSION);
const isTrue = (v: string | undefined) => /^(1|true)$/i.test(v ?? "");

let provider: NodeTracerProvider | undefined;
let capture = false;

/** Appends finished spans to a file as JSON lines (one span per line). */
class FileExporter implements SpanExporter {
  constructor(private file: string) {}

  export(spans: ReadableSpan[], done: (r: { code: number; error?: Error }) => void) {
    try {
      fs.appendFileSync(this.file, spans.map((s) => JSON.stringify(spanJson(s)) + "\n").join(""), { mode: 0o600 });
      done({ code: 0 });
    } catch (e) {
      done({ code: 1, error: e as Error });
    }
  }

  async shutdown() {}
}

const hrMs = (t: [number, number]) => t[0] * 1e3 + t[1] / 1e6;

function spanJson(s: ReadableSpan) {
  return {
    service: s.resource.attributes["service.name"],
    traceId: s.spanContext().traceId,
    spanId: s.spanContext().spanId,
    parentSpanId: s.parentSpanContext?.spanId,
    name: s.name,
    kind: SpanKind[s.kind],
    start: new Date(hrMs(s.startTime)).toISOString(),
    durationMs: Math.round(hrMs(s.duration) * 1000) / 1000,
    status: s.status.code === SpanStatusCode.ERROR ? { error: s.status.message ?? true } : undefined,
    attributes: s.attributes,
    events: s.events.length ? s.events.map((e) => ({ name: e.name, atMs: Math.round(hrMs(e.time) - hrMs(s.startTime)), attributes: e.attributes })) : undefined,
    links: s.links.length ? s.links.map((l) => ({ traceId: l.context.traceId, spanId: l.context.spanId })) : undefined,
  };
}

/**
 * Starts exporting spans if the environment asks for it. `exporter` adds one (for tests).
 * Returns whether tracing is on.
 */
export function initTelemetry(service: string, opts: { exporter?: SpanExporter; captureContent?: boolean } = {}): boolean {
  if (provider) return true;
  const env = process.env;
  if (isTrue(env.OTEL_SDK_DISABLED)) return false;
  const processors: SpanProcessor[] = [];
  if (opts.exporter) processors.push(new SimpleSpanProcessor(opts.exporter));
  if ((env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || env.OTEL_EXPORTER_OTLP_ENDPOINT) && env.OTEL_TRACES_EXPORTER !== "none") {
    processors.push(new BatchSpanProcessor(new OTLPTraceExporter(), { scheduledDelayMillis: 1000 }));
  }
  if (env.LFX_TRACE_FILE) processors.push(new SimpleSpanProcessor(new FileExporter(env.LFX_TRACE_FILE)));
  if (!processors.length) return false;
  capture = opts.captureContent ?? isTrue(env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT);
  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ "service.name": env.OTEL_SERVICE_NAME || service, "service.version": VERSION }),
    spanProcessors: processors,
  });
  provider.register();
  // Short-lived processes (the MCP server) flush when they run out of work.
  process.once("beforeExit", () => void shutdownTelemetry());
  return true;
}

/** Flushes pending spans. Safe to call when tracing is off. */
export async function shutdownTelemetry(): Promise<void> {
  const p = provider;
  provider = undefined;
  await p?.shutdown().catch(() => {});
}

/** Whether prompts, replies and tool payloads may be recorded. */
export const capturingContent = () => !!provider && capture;

/**
 * Content attributes, kept only when content capture is on. Objects are JSON-encoded and
 * long values clipped, so a span never carries a whole drawing or image.
 */
export function contentAttrs(attrs: Record<string, unknown>): Attributes {
  if (!capturingContent()) return {};
  const out: Attributes = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue;
    const s = typeof v === "string" ? v : JSON.stringify(v);
    out[k] = s.length > MAX_CONTENT_CHARS ? `${s.slice(0, MAX_CONTENT_CHARS)}… (${s.length} chars)` : s;
  }
  return out;
}

export function recordError(span: Span, e: unknown, type?: string) {
  const err = e as Error;
  span.setAttribute("error.type", type ?? (err?.name && err.name !== "Error" ? err.name : "error"));
  span.setStatus({ code: SpanStatusCode.ERROR, message: String(err?.message ?? e).slice(0, 500) });
}

export function markError(span: Span, type: string, message: string) {
  span.setAttribute("error.type", type);
  span.setStatus({ code: SpanStatusCode.ERROR, message: message.slice(0, 500) });
}

interface SpanOpts {
  kind?: SpanKind;
  /** Parent context; defaults to the active one. */
  parent?: Context;
  links?: Link[];
}

/** Runs `fn` in a new active span, recording a thrown error and ending the span when it settles. */
export async function withSpan<T>(name: string, attrs: Attributes, fn: (span: Span) => Promise<T> | T, opts: SpanOpts = {}): Promise<T> {
  return tracer.startActiveSpan(name, { kind: opts.kind ?? SpanKind.INTERNAL, attributes: attrs, links: opts.links }, opts.parent ?? context.active(), async (span) => {
    try {
      return await fn(span);
    } catch (e) {
      recordError(span, e);
      throw e;
    } finally {
      span.end();
    }
  });
}

/** A span the caller ends itself, for work that starts and finishes in separate callbacks. */
export function startSpan(name: string, attrs: Attributes, opts: SpanOpts = {}): Span {
  return tracer.startSpan(name, { kind: opts.kind ?? SpanKind.INTERNAL, attributes: attrs, links: opts.links }, opts.parent ?? context.active());
}

export const activeContext = () => context.active();
export const activeSpan = () => trace.getActiveSpan();
export const contextWith = (span: Span, parent = context.active()) => trace.setSpan(parent, span);
export const runIn = <T>(ctx: Context, fn: () => T): T => context.with(ctx, fn);

/** W3C trace headers for the active span, for requests to the daemon. */
export function traceHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  propagation.inject(context.active(), h);
  return h;
}

/** The context carried by incoming request headers (or the active one if none). */
export function contextFromHeaders(headers: Record<string, string | string[] | undefined>): Context {
  return headers.traceparent ? propagation.extract(context.active(), headers) : context.active();
}

/** The context a parent process passed in `TRACEPARENT`/`TRACESTATE`. */
export function contextFromEnv(): Context {
  const carrier = { traceparent: process.env.TRACEPARENT, tracestate: process.env.TRACESTATE };
  return carrier.traceparent ? propagation.extract(context.active(), carrier) : context.active();
}

/**
 * Environment for a child process that should report into this trace: the active span as
 * `TRACEPARENT`, plus this process's exporter settings. Header variables are left out: they
 * usually hold credentials, and this environment may end up on a command line.
 */
export function traceEnv(): Record<string, string> {
  if (!provider) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && ((k.startsWith("OTEL_") && !k.includes("HEADERS")) || k === "LFX_TRACE_FILE")) out[k] = v;
  }
  if (capture) out.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = "true";
  const h = traceHeaders();
  if (h.traceparent) out.TRACEPARENT = h.traceparent;
  if (h.tracestate) out.TRACESTATE = h.tracestate;
  return out;
}
