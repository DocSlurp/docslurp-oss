#!/usr/bin/env node
// Synthetic SDK canary: no documents, databases or model-provider calls.
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { initializeObservability, withObservation, withHttpSpan, emitTelemetryLog, recordMediaTelemetry, flushObservability, shutdownObservability } from '../../packages/shared/dist/observability.js';

const live = process.argv.includes('--live');
if (live) {
  process.env.LANGFUSE_ENABLED = 'false';
  process.env.OTEL_SDK_DISABLED = 'false';
  for (const key of Object.keys(process.env)) if (/^OTEL_EXPORTER_OTLP_(TRACES|METRICS|LOGS)_/.test(key)) delete process.env[key];
  process.env.OTEL_TRACES_SAMPLER = 'parentbased_always_on';
  const credentials = JSON.parse(await readFile(`${process.env.HOME}/.local/share/docslurp/hosts/svc.credentials.json`, 'utf8'));
  process.env.OTEL_ENABLED = 'true';
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = credentials.apiURL;
  process.env.OTEL_EXPORTER_OTLP_HEADERS = `Authorization=Bearer%20${credentials.ingestionToken}`;
  process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/protobuf';
  process.env.OTEL_DEPLOYMENT_ENVIRONMENT = 'telemetry-smoke';
}
const service = process.argv.find(arg => arg.startsWith('--service='))?.slice('--service='.length) ?? 'docslurp-otel-canary';
const traceId = randomBytes(16).toString('hex');
const marker = `otel-canary-${randomBytes(8).toString('hex')}`;
const fault = process.argv.find(arg => arg.startsWith('--fault='))?.slice('--fault='.length);
const spanProcessor = fault ? {
  onStart() { if (fault === 'onStart') throw new Error('synthetic processor failure'); },
  onEnd() { if (fault === 'onEnd') throw new Error('synthetic processor failure'); },
  shutdown: async () => {}, forceFlush: async () => {},
} : undefined;
const logProcessor = fault === 'onEmit' ? {
  onEmit() { throw new Error('synthetic log failure'); }, shutdown: async () => {}, forceFlush: async () => {},
} : undefined;
if (!initializeObservability({ serviceName: service, spanProcessors: spanProcessor ? [spanProcessor] : [], logRecordProcessors: logProcessor ? [logProcessor] : [] })) throw new Error('Telemetry not initialized');
let calls = 0;
const businessError = new Error('synthetic business error');
const failBusiness = process.argv.includes('--fail-business');
let businessErrorPreserved = false;
try {
  try { await withHttpSpan({ method: 'GET', route: '/__telemetry/canary', status: () => 200,
    headers: { traceparent: `00-${traceId}-${randomBytes(8).toString('hex')}-01` },
  }, async () => {
    await withObservation({ name: 'worker.stage.telemetry-canary', input: 'private-input-never-export',
      metadata: { requestId: marker, runId: marker, stageName: 'telemetry-canary', authorization: 'Bearer private-secret-never-export' },
      result: () => ({ output: 'private-output-never-export', metadata: { providerRequestId: 'synthetic-provider-request', costState: 'estimated' } }),
    }, async () => { calls++; if (failBusiness) throw businessError; return 'ok'; });
    recordMediaTelemetry({ provider: "canary", model: "synthetic", operation: "transcribe", outcome: "succeeded", durationSeconds: 0.01, audioSeconds: 5, costUsd: 0, costSource: "synthetic", candidateFrames: 4, selectedFrames: 2, inputTokens: 10, outputTokens: 2 });
    emitTelemetryLog({ severityText: "info", body: "media.canary.completed", attributes: { "docslurp.runId": marker, "docslurp.media.provider": "canary", "docslurp.media.audioSeconds": 5, "docslurp.media.providerRequestId": "synthetic-provider-request", "docslurp.media.costState": "estimated" } });
    emitTelemetryLog({ severityText: 'info', eventName: 'docslurp.api.request_completed', body: 'GET /__telemetry/canary 200 1ms', attributes: {
      'docslurp.requestId': marker, 'http.request.method': 'GET', 'http.route': '/__telemetry/canary',
      authorization: 'Bearer private-secret-never-export',
    } });
  });
  } catch (error) { if (!failBusiness || error !== businessError) throw error; businessErrorPreserved = true; }
  if (failBusiness && !businessErrorPreserved) throw new Error('Business error lost');
  if (calls !== 1) throw new Error('Application callback was repeated');
  await flushObservability();
} finally {
  await shutdownObservability();
}
const evidence = { traceId, marker, service, calls, businessErrorPreserved };
const evidenceFile = process.argv.find(arg => arg.startsWith('--evidence='))?.slice('--evidence='.length);
if (evidenceFile) await writeFile(evidenceFile, JSON.stringify(evidence, null, 2), { mode: 0o600 });
console.log(JSON.stringify(evidence));
