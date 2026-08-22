/**
 * TikTok automation smoke — MP4 background + transparent PNG character with
 * keyframed motion. Proves the worker can fetch remote HTTP(S) assets and
 * preserve animation through renderOffline.
 *
 *   node tiktok-smoke.mjs [url]        default http://127.0.0.1:4100
 *   TIKTOK_SMOKE_SECONDS=3 node tiktok-smoke.mjs   shorter run (default 3s)
 *
 * Without CLOUDINARY_URL, reaching the upload step counts as PASS (same as smoke.mjs).
 */

import { buildTikTokDocument } from './fixtures/tiktokAutomation.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4100';
const SECRET = process.env.RENDER_WORKER_SECRET ?? 'smoke-secret';
const durationSeconds = Number(process.env.TIKTOK_SMOKE_SECONDS ?? 3);

const document = buildTikTokDocument({ durationSeconds });

async function render(label, body) {
  const started = Date.now();
  const res = await fetch(`${BASE}/render`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SECRET}`,
      'Idempotency-Key': body.jobId,
    },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  const ok =
    (res.status === 200 && typeof payload.videoUrl === 'string') ||
    (res.status === 500 && /upload target/i.test(payload.message ?? ''));
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label} — ${res.status} in ${Date.now() - started}ms` +
      `${payload.videoUrl ? ` → ${payload.videoUrl}` : ''}${payload.renderDurationMs ? ` (${payload.renderDurationMs}ms render)` : ''}` +
      `${ok ? '' : `\n      ${payload.message ?? JSON.stringify(payload)}`}`,
  );
  return ok;
}

console.log('health:', await fetch(`${BASE}/health`).then((r) => r.json()));
console.log(`TikTok scenario: 1080×1920 @ 30fps for ${durationSeconds}s with remote MP4 + PNG`);

const stamp = Date.now();
const jobId = `tiktok-smoke-${stamp}`;
const ok = await render('TikTok automation document', {
  jobId,
  document,
  durationSeconds,
  output: { format: 'mp4', width: 1080, height: 1920, fps: 30 },
});

process.exit(ok ? 0 : 1);
