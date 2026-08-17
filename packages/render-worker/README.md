# @motion/render-worker

The private renderer behind motion-back's Automation API. It implements the
`POST /render` contract that `src/automation/render-consumer.ts` calls, which
had no implementation anywhere — so every automation render reached `queued` and
stayed there.

It renders through the editor's **own** `renderOffline` path (`@core/export/offlineRenderer`),
the same code a desktop export runs, so an automation MP4 and a hand-made export
are the same pixels by construction rather than by agreement.

## Pipeline

```
POST /render  ──►  offscreen BrowserWindow (one per job)
                      restoreDocument(document)
                      renderOffline(...) ──► frame_0000.jpg, frame_0001.jpg, …
                   ffmpeg  ──►  out.mp4  (h264, yuv420p, +faststart)
                   Cloudinary signed upload
              ◄──  { videoUrl, renderDurationMs }
```

**One window per job, always destroyed afterwards.** `restoreDocument` is a
MERGE — it applies only the keys a document carries — so a reused JS context
inherits the previous document's timelines, comps and motion-blur settings. A
fresh context is the only way "render exactly this document" is true.

## Running it

This package has no `node_modules` of its own — the repo is not an npm
workspace, so run both commands from **this directory** and they resolve
`vite` / `electron` from the repo root:

```bash
cd packages/render-worker
npm run build
RENDER_WORKER_SECRET=… CLOUDINARY_URL=cloudinary://… npm start
```

`node smoke.mjs` posts a keyframed test document and checks the whole pipeline.
Without `CLOUDINARY_URL` it stops at the upload step and reports that as a pass —
reaching upload proves render and mux both worked.

`npm run build` must run before `npm start`; the worker refuses to boot without
the bundle, and refuses to boot without a secret rather than listen
unauthenticated.

ffmpeg must be on `PATH` (or set `FFMPEG_PATH`).

### Environment

| Variable | Default | Notes |
|---|---|---|
| `RENDER_WORKER_SECRET` | — | **Required.** Must equal motion-back's `RENDER_WORKER_SECRET` |
| `PORT` | `4100` | |
| `CLOUDINARY_URL` | — | `cloudinary://<key>:<secret>@<cloud>`; without it renders succeed then fail at upload |
| `RENDER_WORKER_MAX_CONCURRENT` | `1` | Renders are CPU-bound under SwiftShader; raise only with cores to spare |
| `RENDER_WORKER_JOB_TIMEOUT_MS` | `900000` | Keep at or below motion-back's `RENDER_WORKER_TIMEOUT_MS` |
| `RENDER_WORKER_MAX_BODY_BYTES` | `67108864` | A document with many layers is large; this bounds it |
| `FFMPEG_PATH` | `ffmpeg` | |

### Wiring motion-back to it

On the worker node:

```
SERVICE_ROLE=worker
RENDER_WORKER_URL=http://render-worker.internal:4100
RENDER_WORKER_SECRET=<the same secret>
REDIS_URL=redis://…
```

`SERVICE_ROLE=worker` is what makes `AutomationRenderConsumer` subscribe to the
`premation-automation-render` queue. An `api` node enqueues and does not consume,
so at least one worker node must exist or jobs sit in Redis.

## Endpoints

### `POST /render`

```http
Authorization: Bearer $RENDER_WORKER_SECRET
Idempotency-Key: <automation job id>

{
  "jobId": "clx9zz110000",
  "document": { "...": "EditorDocument" },
  "durationSeconds": 6.5,
  "output": { "format": "mp4", "width": 1080, "height": 1920, "fps": 30 }
}
```

→ `200 { "videoUrl": "https://…", "renderDurationMs": 41231 }`

`durationSeconds` is the template's duration and is authoritative; without it
the worker falls back to the document's own composition. `output` overrides
size and frame rate, defaulting to the composition's.

The bearer check is constant-time. `Idempotency-Key` de-duplicates in-flight and
completed renders — motion-back retries a job up to three times, so without it a
network failure *after* a successful render would bill a second full render.
Failed jobs are evicted so a genuine retry can run.

### `GET /health`

`{ ok, active, queued, maxConcurrent }` — unauthenticated, for load balancers.

## Rendering determinism

The same SwiftShader flag set as the golden-frame harness
(`packages/render-tests`), so output does not depend on which GPU the box has.
That also means renders are **CPU-bound**: budget roughly a core per concurrent
job and expect a 1080p render to run slower than realtime.

## Known limits

- **mp4 only.** `output.format` is validated as `mp4` by motion-back before it
  reaches here.
- **No alpha.** A transparent composition is flattened onto its own background
  colour by the renderer (`deliverableComp`), which matches what the author sees
  in the editor. mp4 cannot carry alpha at all.
- **No audio.** The staged-frame path is video-only; the desktop export's
  `render:stageAudio` equivalent is not wired here yet.
- **No plugin effects.** Custom plugin layers are not installed in the worker, so
  a document depending on one renders without it rather than failing. Templates
  built from stock layers and effects are unaffected.
