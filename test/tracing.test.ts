import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { SettingsError, SettingsStore } from "../src/server/ai/settings.js";
import { configureTelemetry, parseHeaders, shutdownTelemetry, telemetryStatus, traceEnv, tracesUrl, withSpan } from "../src/server/telemetry.js";

const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `lfx-${name}-`));

for (const k of Object.keys(process.env)) if (k.startsWith("OTEL_") || k === "LFX_TRACE_FILE") delete process.env[k];
after(() => shutdownTelemetry());

test("tracing settings: headers are write-only and tied to the endpoint", () => {
  const dir = tmp("tracing-settings");
  const s = new SettingsStore(dir);
  assert.equal(s.tracing(), undefined);

  s.update({ tracing: { enabled: true, endpoint: "http://127.0.0.1:6006/", headers: "Authorization=Basic abc", captureContent: true } });
  const pub = s.public({ available: false }).tracing;
  assert.equal(pub.enabled, true);
  assert.equal(pub.endpoint, "http://127.0.0.1:6006");
  assert.equal(pub.hasHeaders, true);
  assert.equal(JSON.stringify(pub).includes("abc"), false, "headers never go back to the page");
  assert.equal(s.tracing()?.headers, "Authorization=Basic abc");

  // Absent keeps them; a different endpoint drops them; null clears them.
  s.update({ tracing: { enabled: true, endpoint: "http://127.0.0.1:6006", captureContent: false } });
  assert.equal(s.tracing()?.headers, "Authorization=Basic abc");
  s.update({ tracing: { enabled: true, endpoint: "https://cloud.example.com" } });
  assert.equal(s.tracing()?.headers, undefined);
  s.update({ tracing: { enabled: true, endpoint: "https://cloud.example.com", headers: "x-key=1" } });
  s.update({ tracing: { enabled: true, endpoint: "https://cloud.example.com", headers: null } });
  assert.equal(s.tracing()?.headers, undefined);

  // `file` resolves to the state dir; null hands tracing back to the environment.
  s.update({ tracing: { enabled: true, file: true } });
  assert.equal(s.tracing()?.file, path.join(dir, "traces.jsonl"));
  s.update({ tracing: null });
  assert.equal(s.tracing(), undefined);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "ai.json"), "utf8")).tracing, undefined);

  assert.throws(() => s.update({ tracing: { enabled: true, endpoint: "ftp://x" } }), SettingsError);
  assert.throws(() => s.update({ tracing: { enabled: true, endpoint: "http://u:p@x" } }), /tracing headers/);
  assert.throws(() => s.update({ tracing: { enabled: true, endpoint: "http://x", headers: "nonsense" } }), /key=value/);
});

test("tracing settings: a hand edit to ai.json notifies the daemon", () => {
  const dir = tmp("tracing-hand");
  const seen: unknown[] = [];
  const s = new SettingsStore(dir, (store) => seen.push(store.tracing()));
  fs.writeFileSync(path.join(dir, "ai.json"), '{ "tracing": { "enabled": false, }, // off\n}');
  s.get();
  assert.deepEqual(seen, [{ enabled: false, endpoint: undefined, headers: undefined, captureContent: undefined, file: undefined }]);
});

test("tracesUrl and parseHeaders", () => {
  assert.equal(tracesUrl("http://h:6006"), "http://h:6006/v1/traces");
  assert.equal(tracesUrl("http://h/api/public/otel/"), "http://h/api/public/otel/v1/traces");
  assert.equal(tracesUrl("http://h/v1/traces"), "http://h/v1/traces");
  assert.deepEqual(parseHeaders("Authorization=Basic%20abc, x-a = 1,bad"), { Authorization: "Basic abc", "x-a": "1" });
});

test("tracing turns on, moves and turns off without a restart", async () => {
  const got: { url?: string; auth?: string }[] = [];
  const server = http.createServer((req, res) => {
    got.push({ url: req.url, auth: req.headers.authorization });
    req.resume().on("end", () => res.writeHead(200).end());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const file = path.join(tmp("tracing-file"), "spans.jsonl");

  try {
    assert.equal(configureTelemetry(undefined), false);
    assert.equal(telemetryStatus().on, false);

    // On, to the receiver.
    assert.equal(configureTelemetry({ enabled: true, endpoint, headers: "Authorization=Bearer t" }), true);
    assert.deepEqual({ ...telemetryStatus(), env: undefined }, { on: true, source: "settings", endpoint: `${endpoint}/v1/traces`, file: undefined, capture: false, disabledByEnv: undefined, env: undefined, lastError: undefined });
    await withSpan("one", {}, async () => {
      // A child started from here reads ai.json itself, so only the trace context is passed.
      assert.deepEqual(Object.keys(traceEnv()), ["TRACEPARENT"]);
    });

    // Moved to a file: the receiver's batch is flushed on the way.
    assert.equal(configureTelemetry({ enabled: true, file, captureContent: true }), true);
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(got, [{ url: "/v1/traces", auth: "Bearer t" }]);
    assert.equal(telemetryStatus().capture, true);
    await withSpan("two", {}, async () => {});
    assert.deepEqual(fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l).name), ["two"]);

    // Off in settings beats the environment.
    process.env.LFX_TRACE_FILE = file;
    assert.equal(configureTelemetry({ enabled: false }), false);
    await withSpan("three", {}, async () => {});
    assert.equal(fs.readFileSync(file, "utf8").includes("three"), false);
    assert.deepEqual(traceEnv(), {});

    // Unset falls back to it.
    assert.equal(configureTelemetry(undefined), true);
    assert.equal(telemetryStatus().source, "environment");
    await withSpan("four", {}, async () => {});
    assert.equal(fs.readFileSync(file, "utf8").includes("four"), true);
  } finally {
    delete process.env.LFX_TRACE_FILE;
    await shutdownTelemetry();
    server.closeAllConnections();
    server.close();
  }
});

test("a receiver that refuses spans shows up in the status", async () => {
  const server = http.createServer((req, res) => req.resume().on("end", () => res.writeHead(401).end("bad key")));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  configureTelemetry({ enabled: true, endpoint, headers: "Authorization=wrong" });
  await withSpan("lost", {}, async () => {});
  for (let i = 0; i < 50 && !telemetryStatus().lastError; i++) await new Promise((r) => setTimeout(r, 100));
  assert.match(telemetryStatus().lastError ?? "", /401|Unauthorized/);
  await shutdownTelemetry();
  server.closeAllConnections();
  server.close();
});
