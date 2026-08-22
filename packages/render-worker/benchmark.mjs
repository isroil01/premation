/**
 * Benchmark the TikTok automation scenario on the render worker.
 *
 * Measures render time, RSS memory delta, and output size. Optionally runs
 * two concurrent jobs when RENDER_WORKER_MAX_CONCURRENT >= 2.
 *
 *   node benchmark.mjs [url]              default http://127.0.0.1:4100
 *   BENCHMARK_SECONDS=30 node benchmark.mjs
 *   BENCHMARK_CONCURRENT=2 node benchmark.mjs
 *
 * Requires a running worker (`npm run build && npm start`).
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import { buildTikTokDocument } from './fixtures/tiktokAutomation.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4100';
const SECRET = process.env.RENDER_WORKER_SECRET ?? 'smoke-secret';
const durationSeconds = Number(process.env.BENCHMARK_SECONDS ?? 30);
const concurrent = Math.max(1, Number(process.env.BENCHMARK_CONCURRENT ?? 1));

function memMb() {
  return Math.round(process.memoryUsage().rss / (1024 * 1024));
}

async function runJob(index) {
  const document = buildTikTokDocument({ durationSeconds });
  const jobId = `tiktok-bench-${Date.now()}-${index}`;
  const memBefore = memMb();
  const started = Date.now();

  const res = await fetch(`${BASE}/render`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SECRET}`,
      'Idempotency-Key': jobId,
    },
    body: JSON.stringify({
      jobId,
      document,
      durationSeconds,
      output: { format: 'mp4', width: 1080, height: 1920, fps: 30 },
    }),
  });

  const payload = await res.json().catch(() => ({}));
  const elapsedMs = Date.now() - started;
  const memAfter = memMb();

  let outputBytes = null;
  if (typeof payload.videoUrl === 'string') {
    try {
      const head = await fetch(payload.videoUrl, { method: 'HEAD' });
      const len = head.headers.get('content-length');
      if (len) outputBytes = Number(len);
    } catch {
      /* optional */
    }
  }

  return {
    index,
    status: res.status,
    elapsedMs,
    renderDurationMs: payload.renderDurationMs ?? null,
    videoUrl: payload.videoUrl ?? null,
    message: payload.message ?? null,
    memBeforeMb: memBefore,
    memAfterMb: memAfter,
    memDeltaMb: memAfter - memBefore,
    outputBytes,
    frames: durationSeconds * 30,
  };
}

console.log('Benchmark host:', os.hostname());
console.log('Worker:', BASE);
console.log(`Scenario: 1080×1920 @ 30fps, ${durationSeconds}s (${durationSeconds * 30} frames)`);
console.log(`Concurrent jobs: ${concurrent}`);
console.log('health:', await fetch(`${BASE}/health`).then((r) => r.json()));

const startedAll = Date.now();
const results =
  concurrent === 1
    ? [await runJob(0)]
    : await Promise.all(Array.from({ length: concurrent }, (_, i) => runJob(i)));
const wallMs = Date.now() - startedAll;

console.log('\n--- Results ---');
for (const r of results) {
  const uploadOk = r.status === 200 && r.videoUrl;
  const renderOk = r.status === 500 && /upload target/i.test(r.message ?? '');
  const ok = uploadOk || renderOk;
  console.log(`Job ${r.index}: ${ok ? 'OK' : 'FAIL'} HTTP ${r.status}`);
  console.log(`  wall time: ${r.elapsedMs}ms`);
  if (r.renderDurationMs != null) console.log(`  worker renderDurationMs: ${r.renderDurationMs}`);
  console.log(`  client RSS: ${r.memBeforeMb} → ${r.memAfterMb} MB (Δ ${r.memDeltaMb >= 0 ? '+' : ''}${r.memDeltaMb})`);
  if (r.outputBytes != null) console.log(`  output size: ${(r.outputBytes / (1024 * 1024)).toFixed(2)} MB`);
  if (r.videoUrl) console.log(`  videoUrl: ${r.videoUrl}`);
  if (!ok) console.log(`  error: ${r.message}`);
}

console.log(`\nTotal wall time (${concurrent} job(s)): ${wallMs}ms`);
console.log('Note: CPU load is dominated by the worker process, not this client.');

const report = {
  at: new Date().toISOString(),
  durationSeconds,
  concurrent,
  wallMs,
  results,
};
await fs.writeFile('benchmark-last.json', JSON.stringify(report, null, 2));
console.log('Wrote benchmark-last.json');

process.exit(results.every((r) => r.status === 200 || /upload target/i.test(r.message ?? '')) ? 0 : 1);
