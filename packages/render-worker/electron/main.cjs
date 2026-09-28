/**
 * Premation render worker — the private `POST /render` service motion-back's
 * automation queue delegates to.
 *
 * This is the half of the Automation API that did not exist: motion-back
 * resolved templates, reserved quota and enqueued jobs against a renderer URL
 * that nothing implemented, so every automation render reached `queued` and
 * stopped there.
 *
 * Shape: one Electron main process serving HTTP; every render is the C++
 * engine's (`premation-engine --export`, engineRender.cjs): the engine opens
 * the document, renders it offline and pipes raw frames into ffmpeg with
 * encode.cjs's matrix, and the result is uploaded to Cloudinary. The response
 * is the contract motion-back validates:
 *
 *   { "videoUrl": "https://…", "renderDurationMs": 1234 }
 *
 * The offscreen-window render on the TypeScript renderer is gone
 * (docs/TS_ENGINE_REMOVAL.md phase 4): a document the engine cannot render
 * fails the job with the engine's reason.
 *
 * Env:
 *   RENDER_WORKER_SECRET   required — bearer token motion-back sends
 *   PORT                   default 4100
 *   CLOUDINARY_URL         cloudinary://<key>:<secret>@<cloud>  (required to upload)
 *   RENDER_WORKER_MAX_CONCURRENT   default 1
 *   RENDER_WORKER_MAX_BODY_BYTES   default 67108864 (64 MB)
 *   FFMPEG_PATH            default 'ffmpeg' on PATH
 *   PREMATION_ENGINE_PATH  the engine binary (default: resources/engine beside the app)
 */

const { app } = require('electron');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { promises: fs, existsSync } = require('node:fs');
const { CONTAINER_MIME, resolveEncode, wantsAlpha } = require('./encode.cjs');
const { renderViaEngine, resolveEngine } = require('./engineRender.cjs');

const PORT = positiveInt(process.env.PORT, 4100);
const SECRET = (process.env.RENDER_WORKER_SECRET ?? '').trim();
const MAX_CONCURRENT = positiveInt(process.env.RENDER_WORKER_MAX_CONCURRENT, 1);
const MAX_BODY_BYTES = positiveInt(process.env.RENDER_WORKER_MAX_BODY_BYTES, 64 * 1024 * 1024);
function positiveInt(raw, fallback) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function log(...args) {
  console.log('[render-worker]', ...args);
}

// ── ffmpeg ────────────────────────────────────────────────────────────

function resolveFfmpeg() {
  const explicit = (process.env.FFMPEG_PATH ?? '').trim();
  if (explicit) return explicit;
  const name = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const bundled = path.join(process.resourcesPath ?? '', 'ffmpeg', name);
  if (process.resourcesPath && existsSync(bundled)) return bundled;
  return 'ffmpeg';
}

// ── Upload ────────────────────────────────────────────────────────────

/** Parse `cloudinary://<api_key>:<api_secret>@<cloud_name>`. */
function cloudinaryConfig() {
  const raw = (process.env.CLOUDINARY_URL ?? '').trim();
  if (!raw) return null;
  const m = /^cloudinary:\/\/([^:]+):([^@]+)@(.+)$/.exec(raw);
  if (!m) throw new Error('CLOUDINARY_URL is malformed.');
  return { apiKey: m[1], apiSecret: m[2], cloudName: m[3] };
}

/**
 * Upload the finished mp4 and return its HTTPS URL.
 *
 * Signed upload built by hand rather than through the SDK — it is one sorted
 * parameter string and a SHA-1, and it keeps a Node-only dependency out of a
 * package that is otherwise the editor's own build.
 *
 * motion-back REJECTS a non-HTTPS result, so a driver that cannot produce one
 * must fail here rather than hand back something that fails validation there
 * with a less useful message.
 */
async function uploadVideo(file, jobId, container) {
  const config = cloudinaryConfig();
  if (!config) {
    throw new Error('No upload target configured. Set CLOUDINARY_URL on the render worker.');
  }
  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = `premation/automation-renders/${jobId}`;
  const toSign = `public_id=${publicId}&timestamp=${timestamp}`;
  const signature = crypto.createHash('sha1').update(toSign + config.apiSecret).digest('hex');
  const mime = CONTAINER_MIME[container] ?? 'video/mp4';
  // Cloudinary files animated GIF under `image`; everything else here is `video`.
  const resourceType = container === 'gif' ? 'image' : 'video';

  const form = new FormData();
  form.append('file', new Blob([await fs.readFile(file)], { type: mime }), `out.${container}`);
  form.append('public_id', publicId);
  form.append('timestamp', String(timestamp));
  form.append('api_key', config.apiKey);
  form.append('signature', signature);

  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${config.cloudName}/${resourceType}/upload`,
    { method: 'POST', body: form },
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Cloudinary upload failed (${response.status}): ${body?.error?.message ?? ''}`);
  }
  const url = body.secure_url;
  if (typeof url !== 'string' || !url.startsWith('https:')) {
    throw new Error('Cloudinary did not return an HTTPS URL.');
  }
  return url;
}

// ── The pipeline ──────────────────────────────────────────────────────

async function runJob(payload) {
  const startedAt = Date.now();
  const jobId = String(payload.jobId ?? crypto.randomUUID()).replace(/[^A-Za-z0-9._-]/g, '');
  const dir = path.join(os.tmpdir(), `premation-render-${jobId}-${crypto.randomUUID().slice(0, 8)}`);
  await fs.mkdir(dir, { recursive: true });
  try {
    const output = payload.output ?? {};
    // Refuse an impossible codec/container pair before spending a render on it.
    const { container, codec, quality } = resolveEncode(output);
    const spec = {
      document: payload.document,
      // `alpha` tells the renderer to keep the comp transparent and stage PNG.
      // It is derived here, once, from the codec: the renderer must not have
      // its own opinion about which containers carry alpha.
      output: { ...output, container, codec, quality, alpha: wantsAlpha(output) },
      durationSeconds: payload.durationSeconds,
    };
    const viaEngine = await renderViaEngine(spec, dir, { ffmpegPath: resolveFfmpeg() });
    if (viaEngine.kind !== 'done') {
      throw new Error(viaEngine.kind === 'failed' ? viaEngine.message : `The engine could not render this document: ${viaEngine.reason}`);
    }
    const encoded = viaEngine.file;
    const videoUrl = await uploadVideo(encoded, jobId, container);
    return { videoUrl, container, codec, mime: CONTAINER_MIME[container], renderDurationMs: Date.now() - startedAt };
  } finally {
    // Frames are large and the job is over either way; a failed render that
    // leaves 900 frames behind fills the disk long before anyone reads the log.
    // `RENDER_WORKER_KEEP_TEMP` is the escape hatch for diagnosing a render that
    // completed but looks wrong — the staged frames and the mp4 are the only
    // evidence of what actually happened, and they are gone by the time the
    // response arrives.
    if (process.env.RENDER_WORKER_KEEP_TEMP === '1') log(`kept staging dir ${dir}`);
    else await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ── Concurrency + idempotency ─────────────────────────────────────────

let active = 0;
const waiting = [];
/** Idempotency-Key → in-flight or settled promise. */
const byKey = new Map();
const MAX_KEYS = 500;

function acquire() {
  if (active < MAX_CONCURRENT) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else active -= 1;
}

async function schedule(payload) {
  await acquire();
  try {
    return await runJob(payload);
  } finally {
    release();
  }
}

/**
 * De-duplicate by Idempotency-Key.
 *
 * motion-back retries a job up to three times and sends the job id as the key,
 * so without this a transient network failure AFTER a successful render bills a
 * second full render for the same output. Failures are evicted so a genuine
 * retry can run.
 */
function scheduleIdempotent(key, payload) {
  if (!key) return schedule(payload);
  const existing = byKey.get(key);
  if (existing) return existing;
  const promise = schedule(payload).catch((err) => {
    byKey.delete(key);
    throw err;
  });
  if (byKey.size >= MAX_KEYS) byKey.delete(byKey.keys().next().value);
  byKey.set(key, promise);
  return promise;
}

// ── HTTP ──────────────────────────────────────────────────────────────

/** Constant-time bearer check — a fast string compare leaks the secret. */
function authorized(header) {
  const token = /^Bearer (.+)$/.exec(String(header ?? '').trim())?.[1] ?? '';
  const a = Buffer.from(token);
  const b = Buffer.from(SECRET);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large.'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) });
  res.end(json);
}

function createServer() {
  return http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      return send(res, 200, { ok: true, active, queued: waiting.length, maxConcurrent: MAX_CONCURRENT });
    }
    if (req.method !== 'POST' || (req.url ?? '').split('?')[0] !== '/render') {
      return send(res, 404, { message: 'Not found.' });
    }
    if (!authorized(req.headers.authorization)) {
      return send(res, 401, { message: 'Invalid render worker credentials.' });
    }
    let payload;
    try {
      payload = JSON.parse((await readBody(req)).toString('utf8'));
    } catch (err) {
      return send(res, err.statusCode ?? 400, { message: err.message ?? 'Invalid JSON body.' });
    }
    if (!payload?.document || typeof payload.document !== 'object') {
      return send(res, 400, { message: 'A `document` is required.' });
    }
    const key = String(req.headers['idempotency-key'] ?? '').trim() || null;
    try {
      const result = await scheduleIdempotent(key, payload);
      log(`job ${payload.jobId} completed in ${result.renderDurationMs}ms`);
      return send(res, 200, result);
    } catch (err) {
      log(`job ${payload.jobId} failed:`, err?.message);
      // The message reaches motion-back's logs, not an API consumer —
      // `render-consumer.ts` replaces it with a generic string before it can
      // reach a render job's public `error` field.
      return send(res, 500, { message: err?.message ?? 'Render failed.' });
    }
  });
}

app.whenReady().then(async () => {
  if (!SECRET) {
    console.error('[render-worker] RENDER_WORKER_SECRET is required. Refusing to start unauthenticated.');
    app.exit(1);
    return;
  }
  if (!resolveEngine()) {
    console.error('[render-worker] premation-engine was not found. Set PREMATION_ENGINE_PATH to the engine binary.');
    app.exit(1);
    return;
  }
  if (!cloudinaryConfig()) {
    // Warn rather than refuse: a deployment may only be smoke-testing the
    // render half, and failing at upload names the missing piece precisely.
    log('warning: CLOUDINARY_URL is not set — renders will succeed and then fail at upload.');
  }
  const server = createServer();
  // Without this, a port collision rejects an unhandled 'error' event: the
  // process stays alive with no listener, every request goes to whatever is
  // already on the port, and the log shows a clean startup. Fail loudly.
  server.on('error', (err) => {
    console.error(
      `[render-worker] could not listen on :${PORT} — ${
        err.code === 'EADDRINUSE' ? 'that port is already in use.' : err.message
      }`,
    );
    app.exit(1);
  });
  server.listen(PORT, () => log(`listening on :${PORT} (max ${MAX_CONCURRENT} concurrent)`));
});

// No windows are ever open, and that must not quit the app.
app.on('window-all-closed', () => { /* keep serving */ });
