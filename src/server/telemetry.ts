/**
 * OpenTelemetry tracing for the assistant, the MCP server and drawing operations.
 *
 * Off unless `tracing` in ai.json, an OTLP endpoint (`OTEL_EXPORTER_OTLP_ENDPOINT` or
 * `_TRACES_ENDPOINT`, sent as http/protobuf) or `LFX_TRACE_FILE` (JSON lines) turns it on.
 * ai.json, when it says on or off, beats the environment. Spans follow the OpenTelemetry GenAI
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
// Looked up per span: a tracer caches the provider it first used, and the provider changes when settings do.
const tracer = () => trace.getTracer("local-first-excalidraw", VERSION);
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

/** Tracing as set in ai.json. Unset `enabled` leaves tracing to the environment variables. */
export interface TracingConfig {
  enabled?: boolean;
  /** OTLP receiver (http/protobuf). `/v1/traces` is added unless the path already ends with it. */
  endpoint?: string;
  /** Receiver headers, `key=value,key2=value2` as in `OTEL_EXPORTER_OTLP_HEADERS`. */
  headers?: string;
  captureContent?: boolean;
  /** Also append spans to this file as JSON lines. */
  file?: string;
}

/** What tracing is doing right now, for the settings page. */
export interface TracingStatus {
  on: boolean;
  /** Where the configuration came from: ai.json, the environment, or nowhere. */
  source: "settings" | "environment" | "off";
  endpoint?: string;
  file?: string;
  capture: boolean;
  /** `OTEL_SDK_DISABLED` is set, which beats everything else. */
  disabledByEnv?: boolean;
  /** Tracing variables in the environment, used while ai.json leaves tracing unset. */
  env?: string[];
  /** Why the last batch didn't reach the receiver, until one does. */
  lastError?: string;
}

interface Resolved {
  source: TracingStatus["source"];
  /** Undefined: the exporter reads the OTEL_* variables itself. */
  otlp?: { url?: string; headers?: Record<string, string> };
  file?: string;
  capture: boolean;
}

const ENV_VARS = ["OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "LFX_TRACE_FILE", "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"];

/** The receiver URL spans are posted to. */
export function tracesUrl(endpoint: string): string {
  const u = endpoint.replace(/\/+$/, "");
  return /\/v1\/traces$/.test(u) ? u : `${u}/v1/traces`;
}

/** Parses `key=value,key2=value2`, URL-decoding values as the OTLP exporter does for the env variable. */
export function parseHeaders(s: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (s ?? "").split(",")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    let v = part.slice(i + 1).trim();
    try {
      v = decodeURIComponent(v);
    } catch {
      // keep it as written
    }
    out[part.slice(0, i).trim()] = v;
  }
  return out;
}

function resolve(t: TracingConfig | undefined): Resolved {
  const env = process.env;
  if (isTrue(env.OTEL_SDK_DISABLED) || t?.enabled === false) return { source: "off", capture: false };
  if (t?.enabled) {
    return { source: "settings", otlp: t.endpoint ? { url: tracesUrl(t.endpoint), headers: parseHeaders(t.headers) } : undefined, file: t.file, capture: !!t.captureContent };
  }
  const otlp = (env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || env.OTEL_EXPORTER_OTLP_ENDPOINT) && env.OTEL_TRACES_EXPORTER !== "none" ? {} : undefined;
  const file = env.LFX_TRACE_FILE || undefined;
  return { source: otlp || file ? "environment" : "off", otlp, file, capture: isTrue(env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT) };
}

/** Wraps an exporter to remember whether its last export got through. */
class StatusExporter implements SpanExporter {
  private generation = generation;

  constructor(private inner: SpanExporter) {}

  export(spans: ReadableSpan[], done: (r: { code: number; error?: Error }) => void) {
    this.inner.export(spans, (r) => {
      // A replaced exporter may still be retrying; its result is no longer news.
      if (this.generation === generation) lastError = r.code === 0 ? undefined : (r.error?.message ?? "export failed").slice(0, 300);
      done(r);
    });
  }

  shutdown() {
    return this.inner.shutdown();
  }

  forceFlush() {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

let service = "local-first-excalidraw";
let testExporter: SpanExporter | undefined;
let forceCapture: boolean | undefined;
let resolved: Resolved = { source: "off", capture: false };
let applied = "";
let registered = false;
let lastError: string | undefined;
/** Bumped each time the exporters are replaced. */
let generation = 0;

/**
 * Starts exporting spans if the environment (or `tracing`, from ai.json) asks for it.
 * `exporter` adds one (for tests). Returns whether tracing is on.
 */
export function initTelemetry(name: string, opts: { exporter?: SpanExporter; captureContent?: boolean; tracing?: TracingConfig } = {}): boolean {
  service = name;
  if (opts.exporter) testExporter = opts.exporter;
  if (opts.captureContent !== undefined) forceCapture = opts.captureContent;
  return configureTelemetry(opts.tracing);
}

/**
 * Applies tracing settings, replacing the running exporters when they changed. The daemon calls
 * this whenever ai.json changes, so tracing turns on, off or moves without a restart.
 */
export function configureTelemetry(tracing: TracingConfig | undefined): boolean {
  const next = resolve(tracing);
  const key = JSON.stringify([service, next, !!testExporter]);
  if (key === applied) return !!provider;
  applied = key;
  const old = provider;
  provider = undefined;
  if (old) {
    // Spans already started end on the old provider, which flushes them as it shuts down.
    trace.disable();
    void old.shutdown().catch(() => {});
  }
  resolved = next;
  lastError = undefined;
  generation++;
  const processors: SpanProcessor[] = [];
  if (testExporter) processors.push(new SimpleSpanProcessor(testExporter));
  if (next.otlp) processors.push(new BatchSpanProcessor(new StatusExporter(new OTLPTraceExporter(next.otlp)), { scheduledDelayMillis: 1000 }));
  if (next.file) processors.push(new SimpleSpanProcessor(new StatusExporter(new FileExporter(next.file))));
  if (!processors.length) return false;
  capture = forceCapture ?? next.capture;
  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ "service.name": process.env.OTEL_SERVICE_NAME || service, "service.version": VERSION }),
    spanProcessors: processors,
  });
  // The context manager and propagator are registered once and outlive any one provider.
  provider.register(registered ? { contextManager: null, propagator: null } : {});
  if (!registered) {
    registered = true;
    // Short-lived processes (the MCP server) flush when they run out of work.
    process.once("beforeExit", () => void shutdownTelemetry());
  }
  return true;
}

export function telemetryStatus(): TracingStatus {
  const env = ENV_VARS.filter((k) => process.env[k]).map((k) => `${k}=${process.env[k]}`);
  return {
    on: !!provider,
    source: provider ? resolved.source : "off",
    endpoint: resolved.otlp ? (resolved.otlp.url ?? process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? tracesUrl(process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "")) : undefined,
    file: resolved.file,
    capture: capturingContent(),
    disabledByEnv: isTrue(process.env.OTEL_SDK_DISABLED) || undefined,
    env: env.length ? env : undefined,
    lastError,
  };
}

/** Flushes pending spans. Safe to call when tracing is off. */
export async function shutdownTelemetry(): Promise<void> {
  const p = provider;
  provider = undefined;
  applied = "";
  // Unregistered too, so a later configureTelemetry can register its own provider.
  if (p) trace.disable();
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
  return tracer().startActiveSpan(name, { kind: opts.kind ?? SpanKind.INTERNAL, attributes: attrs, links: opts.links }, opts.parent ?? context.active(), async (span) => {
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
  return tracer().startSpan(name, { kind: opts.kind ?? SpanKind.INTERNAL, attributes: attrs, links: opts.links }, opts.parent ?? context.active());
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
 * `TRACEPARENT`, plus this process's exporter settings. With tracing set in ai.json the child
 * reads that file itself. Otherwise header variables are left out: they usually hold
 * credentials, and this environment may end up on a command line.
 */
export function traceEnv(): Record<string, string> {
  if (!provider) return {};
  const out: Record<string, string> = {};
  if (resolved.source === "environment") {
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && ((k.startsWith("OTEL_") && !k.includes("HEADERS")) || k === "LFX_TRACE_FILE")) out[k] = v;
    }
    if (capture) out.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = "true";
  }
  const h = traceHeaders();
  if (h.traceparent) out.TRACEPARENT = h.traceparent;
  if (h.tracestate) out.TRACESTATE = h.tracestate;
  return out;
}
