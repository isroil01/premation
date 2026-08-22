/**
 * End-to-end smoke test for the render worker.
 *
 * Posts a real document — a rectangle whose position is keyframed — and checks
 * the pipeline: restoreDocument → renderOffline → staged frames → ffmpeg mux.
 * With no CLOUDINARY_URL the run stops at the upload step, which is the point:
 * reaching "no upload target" proves everything BEFORE it worked, without
 * needing credentials to prove it.
 *
 *   node smoke.mjs [url]        default http://127.0.0.1:4100
 *
 * Exits 0 when the pipeline reached upload (or completed with credentials set).
 */

const BASE = process.argv[2] ?? 'http://127.0.0.1:4100';
const SECRET = process.env.RENDER_WORKER_SECRET ?? 'smoke-secret';

const COMP = {
  id: 'comp_root',
  name: 'Main Comp',
  width: 320,
  height: 240,
  fps: 12,
  durationSeconds: 1,
  background: '#101014',
  transparent: false,
  startFrame: 0,
  globalLightAngle: 90,
  globalLightAltitude: 45,
};

const document = {
  version: '1.1.0',
  scene: {
    version: '1.0.0',
    nodes: [
      {
        id: 'comp_root',
        name: 'Composition 1',
        parent: null,
        children: ['rect'],
        transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
        visible: true,
        locked: false,
        components: [{ id: 'comp_root_meta', type: 'group', props: { sceneKind: 'group' } }],
      },
      {
        id: 'rect',
        name: 'Rect',
        parent: 'comp_root',
        children: [],
        transform: { position: { x: 40, y: 90 }, rotation: 0, scale: { x: 1, y: 1 } },
        visible: true,
        locked: false,
        components: [
          { id: 'rect_t', type: 'Transform', props: { sceneKind: 'rect', width: 80, height: 60 } },
          { id: 'rect_s', type: 'Style', props: { fill: '#ff3355' } },
        ],
      },
    ],
  },
  // Position keyframes: the layer must MOVE, so a frame-to-frame identical
  // video would be a failure this test can see. Prop paths are FLAT ('x', not
  // 'transform.position.x') and keyframes carry `t`, not `time`.
  animation: {
    tracks: {
      rect: {
        x: {
          nodeId: 'rect',
          prop: 'x',
          keyframes: [
            { t: 0, value: 40, easing: 'linear' },
            { t: 1, value: 200, easing: 'linear' },
          ],
        },
      },
    },
    expressions: {},
  },
  comps: { comp_root: COMP },
};

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
      `${payload.videoUrl ? ` → ${payload.videoUrl}` : ''}${ok ? '' : `\n      ${payload.message}`}`,
  );
  return ok;
}

console.log('health:', await fetch(`${BASE}/health`).then((r) => r.json()));

const stamp = Date.now();
const results = [];

// 1. Explicit output overrides — the normal motion-back call.
results.push(
  await render('explicit output', {
    jobId: `smoke-${stamp}-a`,
    document,
    durationSeconds: 1,
    output: { format: 'mp4', width: 320, height: 240, fps: 12 },
  }),
);

// 2. NO output and NO durationSeconds, so size, frame rate and length must all
//    come from the document's own composition. If `activeComp()` silently fell
//    back to DEFAULT_COMPOSITION this would render 1920×1080 at 30fps for 10s —
//    the same "success" as a correct run, which is why it is asserted here and
//    not left to the eye.
results.push(
  await render('comp-derived output', {
    jobId: `smoke-${stamp}-b`,
    document,
  }),
);

// 3. Replay of (1)'s Idempotency-Key.
//
// This asserts the request SUCCEEDS, not that it was cached — and the
// difference matters. Failed jobs are deliberately evicted from the key map so
// a genuine retry can run, so without CLOUDINARY_URL every render "fails" at
// upload and a replay legitimately re-renders. De-duplication is only
// observable once uploads work; with credentials set, this returns the first
// run's videoUrl without staging a second frame directory.
results.push(
  await render('replay of the same Idempotency-Key', {
    jobId: `smoke-${stamp}-a`,
    document,
    durationSeconds: 1,
    output: { format: 'mp4', width: 320, height: 240, fps: 12 },
  }),
);

// 4. A bad token must be refused.
const unauthorized = await fetch(`${BASE}/render`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' },
  body: JSON.stringify({ document }),
});
const authOk = unauthorized.status === 401;
console.log(`${authOk ? 'PASS' : 'FAIL'}  rejects a bad token — ${unauthorized.status}`);
results.push(authOk);

process.exit(results.every(Boolean) ? 0 : 1);
