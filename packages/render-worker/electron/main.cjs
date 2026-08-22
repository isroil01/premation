/**
 * Premation render worker — the private `POST /render` service motion-back's
 * automation queue delegates to.
 *
 * This is the half of the Automation API that did not exist: motion-back
 * resolved templates, reserved quota and enqueued jobs against a renderer URL
 * that nothing implemented, so every automation render reached `queued` and
 * stopped there.
 *
 * Shape: one Electron main process that is both an HTTP server and a pixel
 * factory. A request renders in its OWN offscreen BrowserWindow through the
 * editor's real `renderOffline` path, frames are staged to a temp directory as
 * `frame_%04d.jpg|png` (the naming contract shared with the desktop export and
 * with motion-back), ffmpeg muxes them, and the result is uploaded to
 * Cloudinary. The response is the contract motion-back validates:
 *
 *   { "videoUrl": "https://…", "renderDurationMs": 1234 }
 *
 * A window per job is required, not tidy: `restoreDocument` MERGES, so a reused
 * JS context inherits the previous document's timelines and comps.
 *
 * Env:
 *   RENDER_WORKER_SECRET   required — bearer token motion-back sends
 *   PORT                   default 4100
 *   CLOUDINARY_URL         cloudinary://<key>:<secret>@<cloud>  (required to upload)
 *   RENDER_WORKER_MAX_CONCURRENT   default 1
 *   RENDER_WORKER_JOB_TIMEOUT_MS   default 900000 (15 min, matches motion-back)
 *   RENDER_WORKER_MAX_BODY_BYTES   default 67108864 (64 MB)
 *   FFMPEG_PATH            default 'ffmpeg' on PATH
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { promises: fs, existsSync } = require('node:fs');

// Deterministic software rendering, headless-safe — the same flag set the
// golden-frame harness pins, and for the same reason: output must not depend on
// which GPU the box happens to have. See packages/render-tests/electron/main.cjs
// for why the sandbox is off unconditionally rather than only under CI.
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('use-gl', 'angle');
app.commandLine.appendSwitch('use-angle', 'swiftshader');
app.disableHardwareAcceleration();

const PORT = positiveInt(process.env.PORT, 4100);
const SECRET = (process.env.RENDER_WORKER_SECRET ?? '').trim();
const MAX_CONCURRENT = positiveInt(process.env.RENDER_WORKER_MAX_CONCURRENT, 1);
const JOB_TIMEOUT_MS = positiveInt(process.env.RENDER_WORKER_JOB_TIMEOUT_MS, 15 * 60_000);
const MAX_BODY_BYTES = positiveInt(process.env.RENDER_WORKER_MAX_BODY_BYTES, 64 * 1024 * 1024);
const RENDER_HTML = path.join(__dirname, '..', 'dist-render', 'render', 'index.html');

function positiveInt(raw, fallback) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function log(...args) {
  console.log('[render-worker]', ...args);
}

// ── Job execution ─────────────────────────────────────────────────────

/**
 * In-flight renders, keyed by `webContents.id`.
 *
 * The three IPC channels are registered ONCE and dispatch through this map by
 * sender, which is what keeps concurrent jobs isolated: a renderer can only
 * ever reach its own entry, because the key is the sender's identity rather
 * than anything the page can say.
 */
const jobsByWindow = new Map();

ipcMain.handle('worker:job', (event) => job(event).spec);

ipcMain.handle('worker:frame', async (event, index, base64, ext) => {
  const { dir } = job(event);
  // Frame naming is a contract shared with the desktop export (exportManager's
  // frameFileName) and with ffmpeg's `%04d` input pattern: 4-digit zero
  // padding, which is a MINIMUM width, so renders past 9999 frames still match.
  const name = `frame_${String(index).padStart(4, '0')}.${ext === 'png' ? 'png' : 'jpg'}`;
  await fs.writeFile(path.join(dir, name), Buffer.from(base64, 'base64'));
});

ipcMain.handle('worker:done', (event, result, error) => {
  const entry = job(event);
  if (error) entry.fail(new Error(String(error).slice(0, 2000)));
  else entry.ok(result);
});

ipcMain.on('worker:progress', () => { /* advisory; motion-back polls the DB */ });

function job(event) {
  const entry = jobsByWindow.get(event.sender.id);
  if (!entry) throw new Error('This renderer has no active job.');
  return entry;
}

/**
 * Render one document to staged frames in `dir`.
 *
 * Resolves with the frame count / extension / fps the mux step needs. The
 * window is always destroyed, including on the timeout path — an orphaned
 * offscreen window holds a GL context and a copy of the document.
 */
function renderToFrames(spec, dir) {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      show: false,
      width: 16,
      height: 16,
      webPreferences: {
        offscreen: true,
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        // The document's image/video layers are fetched by the renderer, and
        // they are Cloudinary URLs on a different origin than file://.
        webSecurity: false,
        backgroundThrottling: false,
      },
    });

    const id = win.webContents.id;
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      jobsByWindow.delete(id);
      if (!win.isDestroyed()) win.destroy();
      fn(arg);
    };

    const timer = setTimeout(
      () => finish(reject, new Error(`Render exceeded ${JOB_TIMEOUT_MS}ms.`)),
      JOB_TIMEOUT_MS,
    );

    jobsByWindow.set(id, {
      spec,
      dir,
      ok: (result) => finish(resolve, result),
      fail: (err) => finish(reject, err),
    });

    win.webContents.on('render-process-gone', (_e, details) =>
      finish(reject, new Error(`Renderer process gone: ${details.reason}`)),
    );
    win.webContents.on('did-fail-load', (_e, code, desc) =>
      finish(reject, new Error(`Render page failed to load (${code}): ${desc}`)),
    );
    // Offscreen windows only produce frames while "painting"; without a
    // subscriber Chromium can idle the compositor and the render loop starves.
    win.webContents.setFrameRate(30);

    win.loadFile(RENDER_HTML).catch((err) => finish(reject, err));
  });
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

/**
 * Mux staged frames into an mp4.
 *
 * Flags mirror the desktop export's h264 branch so an automation render and a
 * hand-made export are the same file: yuv420p for universal playback, even
 * dimensions (yuv420p rejects odd ones), `+faststart` so the result streams
 * without a full download — which is what a social upload pipeline needs.
 */
function encodeMp4(dir, ext, fps) {
  const input = path.join(dir, `frame_%04d.${ext}`);
  const out = path.join(dir, 'out.mp4');
  // Frames arrive already flattened onto the comp background (see
  // `deliverableComp` in renderEntry), so there is no alpha to reconcile here
  // and no filter beyond making the dimensions even — yuv420p rejects odd ones.
  const args = [
    '-y',
    '-framerate', String(fps),
    '-i', input,
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    out,
  ];

  return new Promise((resolve, reject) => {
    const ff = spawn(resolveFfmpeg(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    ff.stderr.on('data', (d) => { stderr += d.toString(); });
    ff.on('error', (err) =>
      reject(
        err.code === 'ENOENT'
          ? new Error('ffmpeg was not found. Install it or set FFMPEG_PATH.')
          : err,
      ),
    );
    ff.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-800)}`)),
    );
  });
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
async function uploadMp4(file, jobId) {
  const config = cloudinaryConfig();
  if (!config) {
    throw new Error('No upload target configured. Set CLOUDINARY_URL on the render worker.');
  }
  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = `premation/automation-renders/${jobId}`;
  const toSign = `public_id=${publicId}&timestamp=${timestamp}`;
  const signature = crypto.createHash('sha1').update(toSign + config.apiSecret).digest('hex');

  const form = new FormData();
  form.append('file', new Blob([await fs.readFile(file)], { type: 'video/mp4' }), 'out.mp4');
  form.append('public_id', publicId);
  form.append('timestamp', String(timestamp));
  form.append('api_key', config.apiKey);
  form.append('signature', signature);

  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${config.cloudName}/video/upload`,
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
    const spec = {
      document: payload.document,
      output: payload.output ?? {},
      durationSeconds: payload.durationSeconds,
    };
    const staged = await renderToFrames(spec, dir);
    if (!staged || !staged.frames) throw new Error('The renderer staged no frames.');
    const mp4 = await encodeMp4(dir, staged.ext, staged.fps);
    const videoUrl = await uploadMp4(mp4, jobId);
    return { videoUrl, renderDurationMs: Date.now() - startedAt };
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
  if (!existsSync(RENDER_HTML)) {
    console.error(`[render-worker] Render bundle missing at ${RENDER_HTML}. Run \`npm run build\` in packages/render-worker first.`);
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

// No windows are open between jobs, and that must not quit the app.
app.on('window-all-closed', () => { /* keep serving */ });
