# Real Video Editing in Premation (motion-editor) — Complete Technical Explanation

> **Provenance of this document.** Every statement below was derived by reading the
> TypeScript source in this repository, not from any prior documentation. Each claim
> carries a `file:line` citation so it can be verified directly. Nothing here is
> inferred from README/ROADMAP/docs prose — no `.md` file was consulted.
>
> Repo: `motion-editor` v0.4.0 (`package.json:3`), branch `dev`.

---

## 0. The one-paragraph answer

You drop an `.mp4` (or `.mov`, `.webm`, `.mxf`, `.avi`, ProRes, camera raw…) onto the
canvas, the Assets panel, or the start screen. The file is **transcoded if the browser
cannot decode it**, **probed with ffprobe** for its true frame rate / duration / pixel
aspect / alpha / audio inventory, **content-addressed into the project bundle** (or
IndexedDB, or an object URL), optionally given a **half-resolution proxy** for scrubbing,
and inserted as a `video` layer with a **clip bar** on the timeline. From then on, every
displayed frame is produced by: comp time → layer time-mapping chain → source seconds →
**presentation frame index** through a real MP4/WebM sample table → **WebCodecs
`VideoDecoder`** → canvas → GPU texture → composited quad. You add motion by keyframing
the layer's transform, by 2-D/planar/3-D **motion tracking** of the footage itself, by
**auto-reframe**, or by any of **175 effects**. Export re-runs the exact same snapshot
builder on a deterministic fixed-timestep loop, waits for every decode to actually land
(and *refuses* to write the file if one didn't), and hands the frames to **ffmpeg in a
child process** or to a **WebCodecs encoder + WebM muxer**.

---

## Table of contents

1. [Architecture at a glance](#1-architecture-at-a-glance)
2. [Stage 1 — Entry points: how a video gets in](#2-stage-1--entry-points-how-a-video-gets-in)
3. [Stage 2 — Ingest: transcoding what the browser can't decode](#3-stage-2--ingest-transcoding-what-the-browser-cant-decode)
4. [Stage 3 — Probing: the three-tier truth model](#4-stage-3--probing-the-three-tier-truth-model)
5. [Stage 4 — Storage: three byte-homes, one `src` string](#5-stage-4--storage-three-byte-homes-one-src-string)
6. [Stage 5 — Proxies: fast scrubbing, never in output](#6-stage-5--proxies-fast-scrubbing-never-in-output)
7. [Stage 6 — Placement: layer, or a whole composition](#7-stage-6--placement-layer-or-a-whole-composition)
8. [Stage 7 — Interpret Footage: per-file reinterpretation](#8-stage-7--interpret-footage-per-file-reinterpretation)
9. [Stage 8 — The clip model: trim, slip, slide, split](#9-stage-8--the-clip-model-trim-slip-slide-split)
10. [Stage 9 — Time mapping: comp seconds → source seconds](#10-stage-9--time-mapping-comp-seconds--source-seconds)
11. [Stage 10 — Decode: the exact frame path](#11-stage-10--decode-the-exact-frame-path)
12. [Stage 11 — The decode fallback ladder](#12-stage-11--the-decode-fallback-ladder)
13. [Stage 12 — Pixels to screen: texture upload and compositing](#13-stage-12--pixels-to-screen-texture-upload-and-compositing)
14. [Stage 13 — Adding motion](#14-stage-13--adding-motion)
15. [Stage 14 — Audio](#15-stage-14--audio)
16. [Stage 15 — Export](#16-stage-15--export)
17. [Failure-mode matrix](#17-failure-mode-matrix)
18. [End-to-end trace of one MP4](#18-end-to-end-trace-of-one-mp4)
19. [Where the code proves itself (tests)](#19-where-the-code-proves-itself-tests)

---

## 1. Architecture at a glance

Premation is an **Electron desktop app** with a React/Zustand renderer process
(`package.json:16`, `main: dist-electron/main.js`). Video work is split across a hard
process boundary:

| Where | What it does | Why there |
|---|---|---|
| **Main process** (`electron/main.ts`) | `ffprobe` probing, `ffmpeg` transcode/proxy/encode as **child processes**, temp-file staging | ffmpeg must never compete with the UI thread; cancellation is a real `kill()`, not cooperative |
| **Preload bridge** (`electron/preload.ts`) | `window.motionEditor.media.*` and `.render.*` — the only IPC surface | `ipcMain.handle` is confined to one file |
| **Renderer process** (`src/`) | demux, decode, compositing, timeline, keyframes, and **the encode *arguments*** | The encode *rule* lives with the code that knows the format; main only substitutes paths it owns (`electron/main.ts:625-627`) |

The renderer never sees an ffmpeg flag it didn't author, and main never decides an
encoding policy.

**Two decode tiers exist, permanently, by design:**

- **Exact tier** — `mp4box` demux → frame index → WebCodecs `VideoDecoder`.
  Asks for *presentation frame N* and gets *frame N*.
- **Element tier** — a hidden `<video>` that is seeked. Returns "wherever the element
  landed", which is why it is the fallback.

`src/core/rendering/exactVideoFrames.ts:12-22` states the exact conditions that route a
source to the fallback: no `VideoDecoder`, bytes that don't demux, a file too large for
in-memory demux, or repeated decoder errors.

---

## 2. Stage 1 — Entry points: how a video gets in

There are six code paths that accept a video file, and **all of them funnel into
`useAssetStore.addAsset` / `addAssetsBatch`** (`src/stores/assetStore.ts:548`, `:770`):

| Gesture | Code |
|---|---|
| Drop onto the **canvas** | `src/layout/Workspace/Workspace.tsx:319-347` |
| Drop / pick in the **Assets panel** | `src/layout/EditorLayout/DemoPanels.tsx:775`, `:817` |
| **Start screen** ("open a video") | `src/layout/Start/StartScreen.tsx:208` |
| **Empty-composition view** | `src/layout/Workspace/EmptyCompositionView.tsx:139`, `:185` |
| **Top nav** File ▸ Import | `src/layout/TopNav/TopNav.tsx:229` |
| **Dashboard** bulk import | `src/pages/DashboardPage.tsx:460`, `:499` |
| **AI tool** / plugin / SFX library | `src/core/ai/toolHandlers.ts:839`, `src/core/plugins/assets.ts:370` |

### The canvas drop is the marquee gesture

`Workspace.tsx:319-347` implements "here is my video, edit it" as a single drop with two
outcomes:

```ts
// Workspace.tsx:330-331 — MIME first, extension as fallback
const media = Array.from(files).filter((f) =>
  /^(video|image|audio)\//.test(f.type) ||
  /\.(mp4|mov|webm|m4v|png|jpe?g|gif|svg|webp|exr|mp3|wav|m4a|aac|ogg|mxf|avi|wmv|flv|mts|m2ts|mpg|mpeg|vob|ts|mkv)$/i.test(f.name));
```

```ts
// Workspace.tsx:337-346
let hasContent = false;
defaultSceneGraph.traverse((n) => { if (readNodeKind(n) !== 'group') hasContent = true; });
if (!hasContent && imported.length === 1 && first?.type === 'video') {
  await createCompositionFromFootage(first);   // comp adopts the clip's shape
  return;
}
for (const asset of imported) await insertMedia(asset);  // otherwise: a layer
```

So dropping one video onto an **empty** project makes the *composition* match the
footage; dropping onto a comp that already has content adds a *layer*. Either way the
file is imported into the Assets library first, so it survives and can be re-used.

### MIME is not trusted alone

`mediaTypeOf` (`assetStore.ts:515-527`) checks `file.type` first, then falls back to
extension regexes:

```ts
// assetStore.ts:511-513
const VIDEO_EXTS = /\.(mp4|m4v|mov|webm|mkv|avi|wmv|flv|mts|m2ts|mpg|mpeg|mpe|vob|ts|mxf|r3d|braw|ari|3gp|ogv)$/i;
```

The comment at `assetStore.ts:506-510` records why: on a machine with no registered MIME
for `.mxf`/`.mts`, the file was filed as an **image** — which skipped the probe, produced
an unbounded clip, and left comp-from-footage nothing to derive from.

---

## 3. Stage 2 — Ingest: transcoding what the browser can't decode

**File:** `src/core/assets/ingest.ts`

This is the first thing that happens to the bytes (`assetStore.ts:611-613`), before any
storage decision. The problem it solves is stated at `ingest.ts:4-8`: every decode path in
the app ends at browser machinery, so a ProRes `.mov`, an MXF, or a DV AVI "probed fine
and rendered black."

### Which files get transcoded

Three sets drive the decision:

```ts
// ingest.ts:32-37 — containers no browser <video> can open, whatever the codec
const INGEST_CONTAINERS = new Set([
  'mxf','avi','wmv','flv','mts','m2ts','mpg','mpeg','vob','mpe','ts',
  'r3d','braw','ari',
]);

// ingest.ts:40-42 — camera-raw stills, decoded via ffmpeg/libraw
const CAMERA_RAW_STILLS = new Set(['dng','cr2','cr3','nef','arw','orf','rw2','raf','pef','srw','raw']);

// ingest.ts:45-49 — codecs no browser decodes, in containers it otherwise could open
const INGEST_CODECS = new Set([
  'prores','dnxhd','dnxhr','mpeg2video','cineform','ffv1','v210',
  'rawvideo','mjpeg','jpeg2000','huffyuv','qtrle',
  'xdcam','imx','dvvideo','apch','apcn','apcs','apco','ap4h',
]);
```

`needsIngest` (`ingest.ts:119-126`) is deliberately asymmetric:

```ts
if (INGEST_CONTAINERS.has(ext)) return true;        // unconditional — ffmpeg reads what ffprobe couldn't
if (!videoCodec) return false;
for (const c of INGEST_CODECS) if (codec.includes(c)) return true;
```

An **H.264 `.mov` plays natively and must not pay a re-encode** (`ingest.ts:116-117`).
`ingestCandidate` (`ingest.ts:131-140`) is a cheap pre-filter so ordinary MP4/WebM imports
never pay a probe here.

### The transcode settings, and why they are what they are

```ts
// ingest.ts:93-108 — opaque sources
'-c:v','libx264','-preset','medium','-crf','16','-pix_fmt','yuv420p',
'-g','15','-keyint_min','15','-sc_threshold','0',
'-c:a','aac','-b:a','192k',
'-movflags','+faststart',
```

CRF 16 is visually transparent for editing. **`-g 15` is the interesting one**
(`ingest.ts:97-100`): x264's default keyint of 250 meant a random access could decode
*hundreds* of frames to show one — precisely the quadratic cost the decoder fights. Half-
second GOPs cost a little size and buy every seek. `+faststart` makes the demuxer's index
read one seek.

Alpha sources take a different route:

```ts
// ingest.ts:82-91
'-c:v','libvpx-vp9','-pix_fmt','yuva420p','-crf','20','-b:v','0','-row-mt','1','-g','15',
'-c:a','libopus',   // → .webm
```

with the documented consequence at `ingest.ts:19-21`: the exact-decoder column is MP4-only,
so **alpha ingests ride the element fallback tier** — a stated trade, "better than losing
the alpha."

### Formats decoded in-process (no ffmpeg)

`maybeIngestForImport` handles four formats before it ever touches the bridge
(`ingest.ts:151-180`):

- **EXR** → `convertExrToPngFile`, with linear float planes attached after the asset is
  added (`assetStore.ts:642-647`, `:757-762`) so the first paint can sample float textures.
- **PSD** → expands to one PNG asset *per layer* (`assetStore.ts:583-604`) — an
  "Import as Composition lite."
- **DPX** → `convertDpxToPngFile`.
- **TGA and any plugin-claimed format** → `decodeWithPlugin`, checked *first* of all
  (`assetStore.ts:550-581`), because every branch below assumes the bytes are legible.

### Ingest never fails an import

`maybeIngestForImport` returns `null` on browser edition, missing ffmpeg, or a failed
encode (`ingest.ts:143-146`), and the caller does:

```ts
// assetStore.ts:612-613
file = (await maybeIngestForImport(file, …)) ?? file;
```

Worst case, you import the original bytes exactly as before.

---

## 4. Stage 3 — Probing: the three-tier truth model

**Files:** `src/core/assets/mediaProbe.ts` (renderer), `electron/mediaProbeParse.ts`
(parsing), `electron/main.ts:565-588` (ffprobe spawn).

The browser genuinely cannot tell you two things (`mediaProbe.ts:5-15`):

1. **The real frame rate.** Nothing reports a `<video>`'s rate. Without it, frame blending
   bracketed on the *composition's* rate — so a 24 fps source in a 30 fps comp had both
   bracket times resolve to the same decoded frame and the blend silently collapsed, for
   exactly the case frame blending exists to fix.
2. **Whether there is an audio track at all.** `decodeAudioData` answers only by throwing,
   at playback time, long after import.

### The tiers

`mediaProbe.ts:22-27` defines them as a contract every caller must handle:

| Tier | When | What is known |
|---|---|---|
| `probed` | desktop + ffprobe present | rate, duration, PAR, codec, alpha, audio stream inventory |
| `elementOnly` | desktop without ffprobe, or browser | size + duration from the media element; **rate unknown** |
| `none` | probe threw / file unreadable | nothing beyond the bytes |

> "An import NEVER fails or is skipped because a probe did not run."
> — `mediaProbe.ts:29-31`

### How the probe runs

`media:probe` (`electron/main.ts:565-588`) writes bytes to a temp file with the correct
extension (so ffprobe picks the right demuxer), runs:

```
ffprobe -v quiet -print_format json -show_format -show_streams <tmp>
```

and unlinks the temp file in a `finally`. Missing ffprobe → `null`, not an error.

### The parsing decisions that matter

`electron/mediaProbeParse.ts` is split out of `main.ts` precisely so it can be tested
against **real ffprobe output** without spawning Electron (`mediaProbeParse.ts:3-8`).

**NTSC rates stay rational** (`mediaProbeParse.ts:45-59`):
```ts
export function parseRational(v: unknown): number | null   // "30000/1001" → 29.97
```
Rounding 30000/1001 to 30 "would silently undo the pulldown the file is asking for."

**Which rate to believe** (`mediaProbeParse.ts:111-114`):
```ts
fps: parseRational(v.avg_frame_rate) ?? parseRational(v.r_frame_rate),
```
`avg_frame_rate` is the honest average; `r_frame_rate` reads `1000/1` on some
variable-rate phone footage, so it is only the fallback.

**Alpha needs two signals** (`mediaProbeParse.ts:68-94`). The table in the source, measured
against real files:

| Format | `pix_fmt` | container tag |
|---|---|---|
| VP9/WebM with alpha | `yuv420p` | `alpha_mode = "1"` |
| ProRes 4444 / MOV | `yuva444p12le` | none |
| PNG | `rgba` | none |
| H.264/MP4, opaque | `yuv420p` | none |

A `pix_fmt`-only test reports WebM alpha as opaque, because Matroska carries alpha as a
separate stream announced by a container tag. So `streamHasAlpha` checks both.

**Duration comes from the container first** (`mediaProbeParse.ts:103-105`) — a stream's own
duration can be shorter than the file (cover-art video stream in an MP3).

### What lands on the asset

`applyProbe` (`assetStore.ts:448-468`) merges probe facts over element facts, and makes one
deliberate distinction (`assetStore.ts:441-447`):

> The probed rate goes to `metadata.fps` — the file's own truth. It is deliberately NOT
> written to `interpret.conformFps`, which means "the user overrode the file" … writing
> both would make an untouched import indistinguishable from a hand-conformed one and
> there would be nothing to reset to.

A non-square PAR *is* written as an interpretation (`assetStore.ts:466-467`) — because that
is the container telling us how it wants to be displayed, and the user can override it.

### The element probe cannot hang the import

`probeWithTimeout` (`assetStore.ts:525-542`) races `loadedmetadata`/`error` against a 10 s
timer. Some containers open but fire neither (truncated MP4s, odd MKVs), and an unsettled
promise froze every `await addAsset(...)` caller — including comp-from-footage — with no
error and no UI feedback.

---

## 5. Stage 4 — Storage: three byte-homes, one `src` string

`addAsset` picks one of three homes, in order:

### 5.1 Local-first bundle (`assetStore.ts:614-649`)

```ts
if (isLocalFirst()) {
  const imported = await importLocalAsset(file);   // content-addressed into the .motion bundle
```

`importLocalAsset` (`src/core/assets/local/importLocalAsset.ts:28-38`) hashes the bytes,
writes them to the bundle blob store (dedup by hash), and returns a
`motion-blob:<sha256>` reference. **No network** (`importLocalAsset.ts:5-9`).

The renderer resolves that scheme lazily:

```ts
// src/core/rendering/localBlobSource.ts:44-50
export async function loadLocalBlobObjectUrl(src: string): Promise<string | null> {
  if (!resolver || !isLocalBlobRef(src)) return null;
  const bytes = await resolver(src.slice(LOCAL_BLOB_SCHEME.length));
  return bytes ? URL.createObjectURL(new Blob([bytes])) : null;
}
```

The byte source is **injected at boot** (`setLocalBlobResolver`, `localBlobSource.ts:24-26`)
so the render layer never imports app services.

### 5.2 Cloud (AI artifacts only) (`assetStore.ts:651-670`)

```ts
// assetStore.ts:646-650 (comment)
// Cloud upload is now reserved for AI-generated artifacts … USER library imports never
// take this branch — they can be gigabytes of raw footage, so they are stored on the
// user's own disk.
```

### 5.3 Object URL + IndexedDB (`assetStore.ts:672-745`)

`URL.createObjectURL(file)` for the session, plus `AssetDatabase.saveAsset` holding the
`File` itself for persistence across reloads.

Whichever home is used, the layer stores **one string** in `transform.props.src` plus
`transform.props.assetId` (`sceneInsert.ts:1575-1578`), and everything downstream reasons
about that string.

### Organisation and interpretation persist separately

Folders, folder assignments, interpretations, provenance and proxy records live in
`localStorage` under five keys (`assetStore.ts:150-167`) because "neither the cloud schema
nor the IndexedDB record carries" them, and losing an interpretation on reload "would
silently un-conform footage that had already been cut with."

---

## 6. Stage 5 — Proxies: fast scrubbing, never in output

**Files:** `src/core/assets/proxy.ts` (the rule), `src/core/assets/proxyManager.ts` (the
driver), `electron/main.ts:608-660` (the ffmpeg child).

### The measurement that justifies the feature

`proxy.ts:7-16` records real numbers from this machine (Chromium, H.264 yuv420p, GOP 60,
30 samples/cell, median ms):

|  | 4K | 1080p | 540p |
|---|---:|---:|---:|
| seek, random | 171.8 | 36.6 | 17.4 |
| seek, 1-frame step | 148.0 | 40.9 | 16.3 |
| GPU upload (WebGPU) | 4.3 | 4.4 | 3.8 |
| GPU upload (WebGL2) | 0.1 | 0.1 | 0.1 |

Two conclusions are drawn in the source (`proxy.ts:18-27`): **seek is 97.6 % of the cost at
4K**, and upload is flat across a 16× payload range — so re-uploading a full-res frame is
*not* what makes 4K slow. And since seek cost *is* decode-from-keyframe cost, a proxy wins
on resolution **and** on GOP length.

### The resolution rule

`proxyResolution` (`proxy.ts:105-124`): halve, then keep halving while the long edge is
above 1920; round to even (H.264 `yuv420p` and VP9 `yuva420p` both require it and ffmpeg
fails outright on odd). Sources at or below 1280 long-edge get **no proxy**
(`proxy.ts:76-79`) — they already seek in ~17 ms, inside a 30 fps budget.

```
3840×2160 → 1920×1080     1920×1080 → 960×540
1280×720  → null          2048×858  → 1024×430  (odd 429 → 430)
```

### The encode

```ts
// proxy.ts:157-165
const common = ['-y','-loglevel','error','-i',input,'-vf',`scale=${w}:${h}`,'-an'];
// opaque:  -c:v libx264 -preset veryfast -crf 25 -pix_fmt yuv420p -g 12
// alpha:   -c:v libvpx-vp9 -pix_fmt yuva420p -crf 34 -b:v 0 -g 12 -deadline realtime -cpu-used 5
```

`-an` drops audio because **the AudioEngine always reads the original**
(`proxy.ts:152-153`). And there is **no `-ss`, no `-t`, no `-r`** (`proxy.ts:144-149`) —
that absence is what makes "proxy and source stay time-aligned" a property of the encode
rather than something the app has to keep checking.

### The two invariants

**1. A proxy substitutes pixels only** (`proxy.ts:37-47`). `conformFps`, duration, PAR,
alpha, loop count, trim, slip, stretch, remap all keep reading the *original* asset through
`sourceOf`. There is no second record to keep in step, so a proxy cannot drift.

**2. Export always uses the original** — enforced by **polarity, not vigilance**
(`proxy.ts:29-35`):

```ts
// proxy.ts:182-187 — the ONE substitution point
export function resolveMediaSrc(asset: ProxyResolvable, useProxies: boolean): string | undefined {
  if (!useProxies) return asset.src;
  const p = asset.proxy;
  if (p?.status === 'ready' && p.src) return p.src;
  return asset.src;
}
```

`useProxies` is absent/false by default; **only the interactive viewport ever sets it true**
(`src/layout/Workspace/useViewportRenderer.ts:187`, `useWorkspace.ts:451`). Export, the
offline renderer and the render-test harness never pass it, so they cannot opt in by
forgetting something.

The strictness is deliberate: `comp.useProxies === true` (`buildSnapshot.ts:2707`) so a
config object carrying the *string* `"true"` still decodes the original.

### Lifecycle

- Auto-started on import, fire-and-forget, dynamically imported to keep the dependency edge
  lazy (`assetStore.ts:494-506`).
- Refusals are enumerated and explained rather than generic (`proxyManager.ts:26-33`,
  `:60-67`): `no-ffmpeg`, `not-video`, `too-small`, `unknown-size`, `already-running`,
  `source-unreadable`.
- Every failure path lands the asset **back at full resolution** — "slower than it could be
  is always better than wrong" (`proxyManager.ts:7-11`).
- The asset is re-read after every `await` because the user can delete or re-import a file
  while a multi-minute encode runs (`proxyManager.ts:73-75`).
- A `generating` record is **never persisted** (`proxy.ts:191-202`): its ffmpeg child dies
  with the app, so a restored job would spin forever with nothing to cancel. A `ready`
  record is persistable only when its `src` is durable — never a `blob:`/`data:` URL, which
  would restore as a dead URL and hand the decoder a black frame.
- Cancellation is real: `proxy:cancel` kills the child, and `before-quit` kills all of them
  (`electron/main.ts:648-660`).

---

## 7. Stage 6 — Placement: layer, or a whole composition

### 7.1 As a layer — `insertMedia`

**`src/core/scene/sceneInsert.ts:1486`**

The headline behaviour is **contain-fit, not native size** (`sceneInsert.ts:1473-1484`):

> This placed footage at its stored pixel size, so a 4K clip dropped into a 1080
> composition arrived at 3840×2160 — four times the frame, centred, with the visible
> quarter being whatever happened to be in the middle. The user's first action after every
> single import was to scale it down by hand.

```ts
// sceneInsert.ts:1559-1571
const par = asset.interpret?.par ?? 1;      // PAR applies BEFORE fitting
const fitted = computeFit({ width: Math.round(storedW * par), height: storedH }, frame, 'contain');
// A probe-failed source falls back to a 400×400 GUESS — a guessed box lands at its
// neutral size rather than being upscaled into a full-height square.
const width  = hasProbedSize ? fitted.width  : Math.min(fitted.width,  Math.round(storedW * par));
const height = hasProbedSize ? fitted.height : Math.min(fitted.height, storedH);
```

Then the node is created and wired:

```ts
// sceneInsert.ts:1573-1582
const node = makeNode(kind, asset.name);
transform.props.src = asset.src;
transform.props.assetId = asset.id;
placeInComp(node, { customW: width, customH: height, exactSize: true });
defaultSceneGraph.addChild(rootId, node);
useSelectionStore.getState().set([node.id]);
bumpScene();
```

Native size remains available on demand (Layer ▸ Set to Native Size) — "it is just not what
an import should guess."

### 7.2 As a composition — `createCompositionFromFootage`

**`src/core/composition/compositionOps.ts:257-280`**

```ts
const width  = meta.width  > 0 ? Math.round(meta.width * par) : defaults.width;
const height = meta.height > 0 ? meta.height                  : defaults.height;
const durationSeconds = meta.duration > 0 ? meta.duration      : defaults.durationSeconds;
const fps    = meta.fps    > 0 ? meta.fps                       : defaults.fps;
const name   = asset.name.replace(/\.[a-z0-9]+$/i, '');   // "shot_04.mp4" → "shot_04"
const id = createOrAdoptComposition({ name, width, height, durationSeconds, fps });
await insertMedia(asset);
```

The fallbacks are the **app defaults, not the active comp's settings**
(`compositionOps.ts:260-263`) — inheriting the active comp would make the result depend on
which tab happened to be focused, so an unprobed clip would mint a 23.976 comp now and a
30 fps one an hour later.

`createOrAdoptComposition` **adopts the fresh project's pristine comp** rather than leaving
a phantom "Composition 1" beside the one the footage just defined
(`compositionOps.ts:275-277`).

### 7.3 Insert at playhead, and replace source

`src/core/scene/footageWorkflow.ts` holds the gestures between "file in the library" and
"layer in the comp", in core rather than in the panel because "the panel calling scene
mutations inline is how the library-insert-invisible bug happened the first time"
(`footageWorkflow.ts:5-9`).

- **`insertMediaAtPlayhead`** (`:33-51`) — captures the playhead **before** the async
  insert (an SVG import reads its file; the transport may be running), then explicitly
  calls `controller.syncFromScene()` rather than trusting a subscription: "an insert whose
  timeline half arrives later is an insert that lands invisible."
- **`retargetLayerSource`** (`:66-79`) — AE's Alt-drag replace. Writes **only** `src` and
  `assetId`; transform, keyframes, effects, masks, stack position all survive. It is
  **kind-checked, not duck-typed** (`:61-64`): pointing a video layer at an audio file
  would error nowhere — the texture provider would simply never produce a frame and the
  layer would go black with nothing to diagnose.

---

## 8. Stage 7 — Interpret Footage: per-file reinterpretation

**Files:** `src/core/source/sourceInfo.ts`, `src/layout/Assets/InterpretFootageModal.tsx`

### The central design decision

> **Interpretation is stored on the ASSET, not the layer.** … changing it updates every
> layer using that footage at once — which is what After Effects' Interpret Footage does,
> and what makes it safe to fix a mis-tagged import after you have already cut with it.
> Per-layer overrides are deliberately absent: two layers of one file disagreeing about
> what the file *is* has no correct rendering.
> — `sourceInfo.ts:18-24`

### The six settings

`FootageInterpretation` (`sourceInfo.ts:41-105`):

| Field | Meaning |
|---|---|
| `conformFps` | Play the source as if shot at this rate (24 → 25 PAL, 30 → 24 slow-mo). Distinct from the *probed* rate. |
| `par` | Pixel aspect. Applied to **width only** — the convention every NLE uses (`sourceInfo.ts:205-207`). |
| `loopCount` | 1 = once (default), 0 = forever. |
| `alpha` | `straight` \| `premultiplied`. |
| `fields` | `upper` \| `lower` for interlaced footage; absent = progressive. |
| `pulldownPhase` | 0–4; present ⇒ inverse telecine is ON. |

### Why alpha cannot be detected

`sourceInfo.ts:63-76` is unusually explicit, and it is backed by the measurements in
`mediaProbeParse.ts`:

> Nothing in the file records it. … not one of them, in `pix_fmt`, stream tags or
> side-data, says whether RGB was premultiplied. It is a convention carried out of band.

Straight is the right default: it's what PNG mandates, what Apple's ProRes 4444 spec says,
what VP9/WebM alpha is — and it is the existing behaviour, so no project changes when the
feature lands. Premultiplied is characteristic of *rendered* elements, which is exactly the
material that carries no marker.

### Precedence rules, resolved in one place

`footageSourceOf` (`sourceInfo.ts:189-225`) produces the normalized `SourceInfo`:

```ts
const fps = i.conformFps ?? asset.metadata?.fps ?? null;   // conform WINS over probed
width: Math.round(storedWidth * i.par),                     // display size, square pixels
```

and enforces the mutual exclusion:

```ts
// sourceInfo.ts:216-223 — Remove Pulldown wins over Separate Fields
...(i.pulldownPhase !== undefined ? { pulldownPhase: i.pulldownPhase }
   : i.fields ? { fields: i.fields } : {}),
```

because "the served frames are progressive film frames, and bobbing them would halve the
vertical detail the weave restored."

`fps` is `number | null`, and **null means genuinely unknown** (`sourceInfo.ts:127-131`):
"Callers must handle null rather than substituting the comp's rate silently."

### One abstraction for footage and comps

`sourceOf` (`sourceInfo.ts:236-265`) returns the same `SourceInfo` shape for a placed
**composition** as for footage — because "a composition placed as a layer and a piece of
imported footage are the same shape of thing: both have an intrinsic size and an intrinsic
time of their own" (`sourceInfo.ts:5-8`). A comp is `alpha: 'straight'` **by construction**
— we render it into a straight-alpha target, so there is no file convention to reinterpret.

### Looping

```ts
// sourceInfo.ts:275-283
export function applyLoop(sourceSec, durationSec, loopCount) {
  if (!durationSec || loopCount === 1 || sourceSec < durationSec) return sourceSec;
  const pass = Math.floor(sourceSec / durationSec);
  if (loopCount !== 0 && pass >= loopCount) return durationSec - 1e-6;  // hold last frame
  return sourceSec - pass * durationSec;
}
```

Exhausted loops **hold the final frame rather than snapping back to black**, "which is what
makes a looped background usable as a backdrop."

### 3:2 pulldown detection

`src/core/video/pulldownDetect.ts:1-25` derives the detector from first principles: film at
24 fps dealt onto 29.97i fields produces the cycle `A/A, B/B, B/C, C/D, D/D`. Across the
five frame transitions of one cycle, **the top field repeats exactly once and the bottom
field repeats exactly once, at fixed and different phases**. Progressive video repeats
neither; true interlaced repeats neither; a still repeats everything. "Two same-parity
repeats per five transitions, one per parity, each locked to its phase mod 5 — that
signature IS telecine, and finding it is the entire detector."

The modal shows AE's `WWSSW` phase notation
(`InterpretFootageModal.tsx:34-43`) and only ever sets `pulldownPhase` from an explicit
**Detect** button — never a guess (`sourceInfo.ts:95-97`).

---

## 9. Stage 8 — The clip model: trim, slip, slide, split

**File:** `packages/timeline/src/clips/Clip.ts`

A clip is four numbers, all in **frames**:

```ts
// Clip.ts:14-23
start: number;              // timeline start
duration: number;           // length on the timeline
sourceIn: number;           // offset into the source media where playback begins
sourceDuration: number|null // total source length, or null for generative/infinite sources
```

The whole mapping is one line:

```ts
// Clip.ts:57-59
sourceFrameAt(frame: number): number {
  return this.sourceIn + (frame - this.start);
}
```

### The five operations

| Op | Code | What moves |
|---|---|---|
| **trimStart** | `Clip.ts:69-81` | Head moves, tail fixed; `sourceIn` advances by the same delta **so the media stays in sync**. Bounded sources can't pull `sourceIn` below 0. |
| **trimEnd** | `Clip.ts:87-94` | Tail moves, head fixed; clamped to remaining source length. |
| **shift** | `Clip.ts:97-99` | Whole clip slides; source mapping unchanged. |
| **slip** | `Clip.ts:106-115` | `start`/`duration` fixed, **only `sourceIn` moves** — different footage under the same bar. |
| **split** | `Clip.ts:123-136` | Left shrinks to `[start, frame)`; right gets `sourceIn = sourceFrameAt(frame)`. Refuses if either side would be under `minDuration`. |

`slideClip` (`TimelineController.ts:670-673`) moves the bar and trims abutting neighbours
so the cut stays closed.

**Unbounded sources** (`sourceDuration === null` — shapes, text) may extend their head
freely, "the source mapping stays consistent because `sourceIn` shifts with `start`"
(`Clip.ts:64-67`).

### Why library inserts trim rather than set start/duration

`src/core/library/clipWindow.ts:17-24` explains a subtlety that applies to any pre-authored
content: keyframes are authored at **absolute composition times**, so anything that moved
the bar without compensating would slide the animation out from under them. `trimStart`
advances `sourceIn` by the same delta, keeping `sourceFrameAt` the identity it was.

And a detail that reads like a bug until you see the reasoning (`clipWindow.ts:31-37`): clip
spans are **end-exclusive**, and a choreography's final keyframe sits at exactly its
duration — so the window runs **one frame past** the duration, or the settled pose the whole
animation was travelling toward never renders.

---

## 10. Stage 9 — Time mapping: comp seconds → source seconds

This is the composition function `buildSnapshot` builds per layer per frame
(`src/core/rendering/buildSnapshot.ts:~820-910`). Reading it outward-in:

```
comp time t
  └─▶ precomp ancestor chain remaps (A ▸ B ▸ C, outermost → innermost)   :887-908
        └─▶ clip mapping  sourceIn + (frame − start)                      Clip.ts:57
              └─▶ applyLoop(…, durationSec, loopCount)                     :840
                    └─▶ Posterize Time  floor(t·fps)/fps                   :851-853
                          └─▶ layer time: stretch / reverse / freeze       :862-882
                                └─▶ SOURCE SECONDS
```

Several ordering decisions are load-bearing:

- **Posterize Time is applied before stretch/reverse** (`buildSnapshot.ts:849-850`) "so the
  steps land on the posterized grid rather than being smeared by a subsequent time warp."
  It lives in the temporal chain, not the pixel chain, because it changes *when* the layer
  is sampled — and therefore affects its transform, masks and effect params together.
- **The remap anchor** (`buildSnapshot.ts:857-878`) is the keyframe span when the layer has
  one; otherwise the **clip's source range**; otherwise the footage duration. The old
  `{start: 0, end: 1}` fallback anchored a plain video's reverse/stretch on a fictitious
  one-second span, so Reverse played one second backwards and froze on frame 0 for the rest
  of the bar.
- **Nested precomp remaps compose** (`buildSnapshot.ts:884-908`): the full ancestor chain
  folds outermost → innermost, excluding the node itself so a precomp group's own remap
  isn't double-counted for its own children.

The result lands on the render layer as `sourceTime` (`buildSnapshot.ts:2526-2530`).

### The one keyframe axis

`compToKeyframeTime` / `keyframeToCompTime` are **the only axis keyframes may be written
on**. `TimelineController.ts:678-690` carries an explicit prohibition on the naive helper:

> **NEVER use this for keyframes** — reading, writing, moving or displaying them. Keyframes
> live on the axis the renderer samples, which this is not: it is a naive "subtract the
> first clip's start" that ignores `sourceIn`, the active clip, stretch/reverse/freeze and
> precomp time remaps.

`toLayerTime` exists **only** for bar-anchored geometry such as layer markers.

---

## 11. Stage 10 — Decode: the exact frame path

This is the heart of the feature. Four files, each with one job.

### 11.1 Demux — `src/core/video/mp4Demuxer.ts`

`demuxMp4` (`:110`) uses **mp4box.js** — pure JavaScript, no WASM, so it runs under Node
and its behaviour is pinned by jest tests against real ffmpeg-encoded fixtures "instead of
by faith" (`mp4Demuxer.ts:5-9`).

Out comes exactly what `VideoDecoder.configure` + `decode` need
(`mp4Demuxer.ts:41-60`):

- the WebCodecs codec string (`avc1.4d400a`),
- the codec-private description — **avcC/hvcC/vpcC with the 8-byte box header stripped**,
  because `configure` wants the box *contents*, not the box (`mp4Demuxer.ts:91-102`),
- the sample table in **decode order** with `dts`, `cts`, `isKey`, `duration`,
- **container display rotation** from the tkhd matrix (`:78-89`), because
  `VideoDecoder` output is **unrotated** while `HTMLVideoElement` rotates automatically —
  without this, phone-shot portrait footage rendered sideways on the exact tier only.

An **incomplete demux fails loudly** (`mp4Demuxer.ts:174-177`) — "an index built over half
a sample table produces frame numbers that lie."

Known limits are stated, not hidden (`mp4Demuxer.ts:17-27`): whole file in memory, first
video track wins, edit lists not applied beyond cts normalization.

`webmDemuxer.ts` provides the same `DemuxedVideo` contract for VP8/VP9 over an EBML subset
(`webmDemuxer.ts:1-11`), including alpha-plane side data (`BlockAdditional`, `AddID=1`).

### 11.2 Index — `src/core/video/frameIndex.ts`

Pure integer arithmetic, no decoder anywhere near it. It answers three questions
(`frameIndex.ts:6-22`):

1. **Which sample is presentation frame 7?** Sort by `cts`, ties broken by decode order for
   determinism (`:79-80`). Normalize so frame 0 is at 0 µs whatever the container says —
   ffmpeg parks the B-frame delay in an edit list (`:82`, `:98`).
2. **Where must decoding start?** The latest sync sample at-or-before the frame's decode
   position — its GOP keyframe (`:70-75`). "Feeding a decoder anything else is undefined
   behaviour wearing a timestamp."
3. **How far must decoding run?** Through the **running max** of decode index over the GOP's
   presentation frames so far (`:84-95`) — a B-frame needs the future reference it was
   predicted from, which sits *earlier* in decode order than the B-frame's own presentation
   slot.

The fixture this is tested against decodes `I P B B…` while presenting `I B B P…`.

`frameAtTime` (`:112-123`) is a binary search for the last frame starting at or before a
time — the half-open `[start, start+duration)` every player uses.

### 11.3 Decoder session — `src/core/video/exactVideoSource.ts`

**`ExactVideoSource` (`:197`) — random access.** Per request:

```ts
// exactVideoSource.ts:303-314
for (let d = entry.keyDecodeIndex; d <= entry.feedThroughDecodeIndex; d++) {
  this.decoder.decode(this.io.createChunk({
    type: s.isKey ? 'key' : 'delta',
    timestamp: this.timeUsOfDecodeIndex[d],
    durationUs: Math.round((s.duration * 1e6) / this.demuxed.timescale),
    data: s.data,
  }));
}
await this.decoder.flush();
```

`flush()` does **two** jobs (`exactVideoSource.ts:11-16`): it forces the decoder to emit
everything buffered (without it a conservative decoder holds the target frame hostage
waiting for input that never comes), **and** it resets the decoder to needing a key chunk
next — which is exactly what the next random access will feed. "Random access and
flush-per-request are the same design, not a coincidence."

That makes naive step-forward quadratic in GOP length, so **every frame the flush emits is
cached, not just the target** (`:17-23`). Decoding frame 7 yields frames 0–7, so the next
step is a cache hit.

**The hardware-pool hazard, and the fix.** `DecoderIO.retain` (`:86-97`):

> Hardware decoders own a fixed pool of output buffers, and every unclosed `VideoFrame`
> pins one. Hold ~10 and the decoder's `flush()` stalls **FOREVER** — which surfaced as
> Track Motion "freezing at 2–4 %".

So the session **never caches raw `VideoFrame`s**. `webCodecsIO.retain` (`:134-158`) draws
the frame into a plain canvas, closes the original, and grafts the routing fields onto the
canvas — pool-free, still a `CanvasImageSource`.

Frames outside the retain window are closed **immediately, before flush resolves**
(`:348-357`), because eviction after the fact cannot fix a mid-flush pile-up.

**Requests are serialized** (`:246-253`) — "a decoder is one machine, not a pool" — and the
stored chain absorbs rejections so one failed seek does not poison every later one.

**`SequentialFrameReader` (`:413`) — streaming.** For consumers that walk forward
(playback, export, tracking), random access is the wrong shape: each step re-decodes an
ever-longer prefix. This reader feeds the stream **once**, in presentation order, with a
bounded pipeline:

```ts
// exactVideoSource.ts:396-403
const WALK_FEED_AHEAD = 24;   // compressed chunks in flight — must exceed B-pyramid reorder depth
const WALK_QUEUE_MAX  = 4;    // decoded frames waiting — each pins a hardware pool slot
```

Requests must be **non-decreasing** (`:456-462`); repeating an index returns the same frame
(freeze frames, slow stretch); skipped indices are decoded and discarded.

`close()` explicitly wakes a parked `frameAt` (`:495-503`) — without it, a caller awaiting
the next frame when the reader is killed (every loop wrap, every seek) waits forever, the
leaked promise sits in the cache's `inflight` set, and **one prior scrub deadlocked every
later export**.

The routing tables (`buildFrameIndex` + two lookup maps) are cached in a `WeakMap` keyed on
the demux (`:166-195`) because a `SequentialFrameReader` used to rebuild an O(n log n) sort
over every sample on **every construction — i.e. every loop wrap of every playing clip**.

### 11.4 Render-facing cache — `src/core/rendering/exactVideoFrames.ts`

This tier gives the renderer a **synchronous** contract (`exactVideoFrames.ts:5-11`):
`get()` never blocks; a miss queues a decode and `AnimationChanged` repaints when it lands.

```ts
// exactVideoFrames.ts:271
get(src: string, timeSec: number, pulldownPhase?: number): ExactFrameResult
```

Returns one of three states (`:118-127`): `frame` (with `exact: true|false`), `pending`, or
`unavailable`.

**The +1 µs rule** (`:281-290`) — a genuinely subtle bug worth quoting:

> Frame boundaries in the index are **fractional microseconds** (`cts/timescale × 1e6` —
> e.g. 33333.33 µs for frame 1 at 30 fps), while the rounded query is an integer. Without
> the bias, `t = 1/30` rounds to 33333 µs, lands "at-or-before" 33333.33, and resolves the
> **previous** frame — off by one on every exact frame boundary, which is exactly where the
> timeline puts the playhead.

```ts
const presIdx = entry.source.frameIndexAt(Math.max(0, Math.round(timeSec * 1e6) + 1));
```

**Streaming mode.** Random access is right for scrubbing and hopeless for playback
(`:360-371`): at 30 fps the decode debt grows every frame, the picture freezes while the
playhead runs, and catches up when you pause — "that was the reported bug, verbatim." So
when misses arrive as an ascending run, the source switches to a `SequentialFrameReader`:

```ts
// exactVideoFrames.ts:65-77
const STREAM_AFTER_SEQ   = 1;   // consecutive ascending misses before streaming
const STREAM_AHEAD       = 25;  // ~1/3 s at 30fps of lookahead
const STREAM_PLAY_WINDOW = 45;  // forward gap that still reads as playback, not a seek
```

Cache **hits** also advance the stream target (`advanceStream`, `:441-448`) — hits are the
steady state of playback, and a stream that only advanced on misses would stall the moment
it caught up.

**Loop-wrap detection** (`isLoopWrap`, `:378-393`) recognises three shapes: a full clip loop
(near end → near start), a comp/work-area loop (any backward jump ≥ 15 frames back to near
start), and a **repeat of the last wrap destination** — because a work-area loop over a clip
trimmed deep into the file lands on the same mid-clip index every pass, which a near-zero
window could never see. On a wrap the stream **restarts** rather than falling back to
per-frame random access.

**Budgets and lifetimes:**

| Constant | Value | Code |
|---|---|---|
| Frame cache per source | 512 MB (~65 1080p frames) | `:49-50` |
| Max in-memory demux | 1.5 GB — beyond this, use a proxy | `:52-55` |
| Decode failures before sticky `unavailable` | 3 | `:57-58` |
| Idle source eviction | 90 s (decoder + frames + file bytes) | `:207-211` |
| Canvas recycle pool | 8 | `:685` |

Idle eviction matters: deleted layers and closed comps otherwise pinned up to 512 MB of
frames **plus the whole file** per source for the rest of the session.

**Pulldown removal** happens here (`:263-270`, `:307-330`). `pulldownFrameFor` maps a video
frame index to either a whole film frame or a **weave** of two; `weaveCanvas` (`:531-556`)
rebuilds one progressive film frame from even rows of `top` and odd rows of `bottom`. Woven
results are cached under a **fractional index no real presentation index can collide with**.

**Alpha WebM is deliberately refused** by the exact loader (`:154-160`): the exact path
decodes only the primary bitstream, and the alpha plane rides in `BlockAdditional` side data
it never feeds — so opaque frames here would *lose* the transparency the ingest transcode
exists to keep. It falls to the element tier, which composites alpha correctly.

**Export integration.** `waits()` (`:568-570`) exposes every in-flight load/decode. Those
promises are `catch`-wrapped so they never reject — "as a WAIT the settled promise must
never reject, or one bad decode would abort a whole export" (`:573-575`).

---

## 12. Stage 11 — The decode fallback ladder

`MotionRendererBackend.feedVideoFrame` (`src/core/rendering/MotionRendererBackend.ts:1178`)
is the ladder, in order:

**Rung 0 — Playback mode.** During playback the browser's own media pipeline decodes forward
in hardware; per-frame WebCodecs + canvas upload cannot keep real-time at 1080p/4K
(`:1180-1182`). So `setVideoPlayback` keeps a `<video>` *running*.

An **anchor is recorded in every mode**, not just playback (`:1185-1189`): pressing play with
the playhead inside a fully-cached span serves blits immediately, and without an anchor from
the last paused render nothing supervised the element — the first cache miss then paid a
cold mid-GOP hard seek, "a seconds-long freeze exactly where the green bar ended."

`setVideoPlayback` (`AppTextureProvider.ts:1469-1489`) additionally supports:
- `syncOnly` — keep the element in sync **without touching the GPU texture**, used while the
  viewport serves frames from the RAM preview cache;
- `prepareSourceSec` — **park** the element, paused and pre-seeked to the exact frame the
  first cache miss will need, so a decoder that cannot sustain realtime plays only through
  the gaps.

**Rung 1 — Exact frame** (`:1203-1215`). Signature is the presentation index, so a repeated
render of the same frame skips the re-upload and a landed decode re-uploads:

```ts
this.feedScaledFrame(key, exact.canvas, `xv:${exact.presIndex}:f${fields ?? ''}`, fields);
```

**Rung 2 — Legacy seek cache** (`:1224-1230`), used for frame blending. `videoFrameCache.ts`
exists because **frame blending needs two decoded frames at once and an
`HTMLVideoElement` holds exactly one** (`videoFrameCache.ts:3-11`) — that is why `frameBlend`
sat in the model and UI for years as a documented no-op: "the flag was never the missing
part; a second frame was."

**Rung 3 — Live element seek** (`:1239`). Failure to settle sets `frameMediaExact = false`.

### Resolution bucketing

`feedScaledFrame` (`:1148-1175`) downsamples the decoded frame to a zoom bucket before
upload, with the reasoning at `:1140-1147`: uploading a 4K RGBA canvas per frame is ~33 MB a
tick; at fit zoom the quarter bucket uploads ~2 MB for pixels the screen could never show.
A high-quality 2D-canvas downscale **is the missing mip level**. Interlaced sources skip it —
field weaving needs original row parity. **Export renders at view scale 1 → bucket 1 → always
source resolution.**

---

## 13. Stage 12 — Pixels to screen: texture upload and compositing

**File:** `src/core/rendering/AppTextureProvider.ts` (2717 lines)

The renderer's passes call `get(key)` **synchronously mid-frame**, but decode is async, so
the flow is (`AppTextureProvider.ts:7-17`):

1. Each frame, `MotionRendererBackend` feeds current sources via `setImage`/`setFrame`/
   `setVideo`.
2. `get` returns the decoded texture once ready, else a shared **1×1 transparent**
   placeholder — an undecoded layer draws nothing rather than a box. (It used to be opaque
   white, which made every layer whose clip starts partway into the timeline flash a white
   rectangle on its first frame.)
3. A decode that **fails** is different: **colour bars** are installed (AE's Media Offline)
   and export refuses via `media-unavailable`.
4. On completion, `onChange` fires and the app re-renders.

### The alpha invariant

`AppTextureProvider.ts:95-111` states it plainly: **textures hold premultiplied alpha**, and
this is where the file's own alpha mode is consumed — **once per file, not once per draw**:

| File's alpha | `premultiplyAlpha` | Effect |
|---|---|---|
| straight | `'premultiply'` | browser multiplies at decode |
| premultiplied | `'none'` | raw bytes; already multiplied |

Either way the bitmap that comes out is premultiplied, so the upload passes every bitmap
through untouched.

### Deinterlacing

`deinterlace.ts` reconstructs a clean frame by keeping one field's rows and rebuilding the
other as the average of vertical neighbours — single-field "bob" at the source frame rate
(`deinterlace.ts:4-9`). Scope is stated honestly (`:10-13`): it removes combing — "the
visible 95 % of the feature" — but does **not** double the frame rate (AE's Preserve Edges)
and does not itself detect 3:2 pulldown.

The pixel loop is pure and in-place (`deinterlaceData`) so it is testable without a canvas;
`deinterlaceInto` is the canvas wrapper with **one `getImageData`/`putImageData` pair per
frame, no allocation after the first** (`:20-23`).

### Media-offline reporting

`offlineMediaReports()` (`AppTextureProvider.ts:713-734`) enumerates every key showing colour
bars, which `MotionRendererBackend` turns into `media-unavailable` diagnostics. **Preview
warns; export refuses.**

---

## 14. Stage 13 — Adding motion

This is where the video stops being a clip and becomes motion design.

### 14.1 Transform keyframes — the AE keyframing contract

**`src/core/scene/transformWrite.ts`** is "the one place that knows how to write a transform
property", and the contract is a **correctness requirement, not a style preference**
(`transformWrite.ts:4-13`):

> A property with a lit stopwatch (an existing track) **ALWAYS** keyframes on direct
> manipulation. The global Auto-Keyframe mode only decides whether *un-animated* properties
> start recording. … the renderer reads animated values FIRST
> (`av.get(prop) ?? transform.prop`), so writing a static value to a tracked property is
> **silently discarded**. The edit appears to work — the store changes — and nothing moves
> on screen.

`transformWrite.ts:16-30` lists the three features that broke before this module existed:
anchor-point pan-behind compensation, Align & Distribute, and Fit to Comp / Fill / Native
Size — "in a motion-design tool an animated layer is the NORMAL case, so all three were
broken most of the time."

`TRACK_GROUPS` (`:43-50`) makes `x` and `y` keyframe **together**, so a diagonal move reads
as one motion rather than two.

Keyframes are written on the node's own time axis via `getRemappedTime` — `transformWrite.ts:75`
calls it "the ONLY axis keyframes may be written on."

### 14.2 Interpolation

`packages/animation/src/interpolate.ts` is the single source of sampling math. Easing kinds
(`:32-52`): `linear`, `ease`, `easeIn`, `easeOut`, `easeInOut`, `step`, `autoBezier`,
`continuousBezier`, plus arbitrary cubic-bezier handles solved by Newton's method matching
CSS `cubic-bezier` semantics (`:8-29`).

**Spatial tangents** produce true curved motion paths (`:64-72`): when a segment carries
`a.so`/`b.si` the value follows a 1-D cubic bezier through them, and "the shared eased
parameter makes x+y trace a true 2D bezier."

### 14.3 Motion tracking — tracking the footage itself

**`src/core/tracking/trackVideoLayer.ts`** owns the seam between three clocks
(`trackVideoLayer.ts:4-16`):

```
comp frame → compToKeyframeTime(videoNode) → media seconds
           → ExactVideoSource.frameIndexAt  → presentation frame index
```

`compToKeyframeTime` is **the same axis every keyframe write in the app uses**, so "the frame
the tracker matched is the frame the renderer shows at that comp time — the whole point of
tracking on the exact decoder rather than a seeked `<video>` element."

Two efficiencies are called out (`:17-25`): a comp range can hit each source frame more than
once (freeze frames, slow stretch), so the walk runs over the **distinct source-frame span
once**; and luma extraction goes through **one reused canvas**.

The tracker asks for `hardwareAcceleration: 'prefer-software'` (`exactVideoSource.ts:68-76`)
with measured justification: per-frame `copyTo` readback of a **hardware** 4K frame costs
~60 ms of GPU sync, while a **software** frame is already in CPU memory and copies in ~2 ms —
the decode is slower but the total is ~3× faster, with spec-identical pixels.

**What tracking produces** — `src/core/tracking/applyTrack.ts` has ten application modes:

| Function | Result |
|---|---|
| `applyTrackToLayer` (`:93`) | Position keyframes on any target layer |
| `applyStabilizeToLayer` (`:153`) | Inverse motion → stabilization |
| `applyTransformTrack` (`:243`) | Position + rotation + scale |
| `applySmoothStabilize` (`:356`) | Smoothed camera path |
| `applyCornerPinTrack` (`:456`) | Planar / screen-replacement |
| `applyTrackToCamera` (`:571`) | Drive a 3-D camera |
| `applyCameraSolveTrack` (`:622`) | 3-D camera solve (SfM) |
| `applyMeshWarpTrack` (`:675`) | Subspace mesh warp |
| `createNullAndApplyTrack` (`:816`) | AE's "create null and parent" |

The space chain is documented frame-by-frame (`applyTrack.ts:5-21`):

```
source px → video-layer local (content is CENTRED on the local origin)
          → comp px  (layerSpaceAt(video).toComp — parent chain, animation, 3D included)
          → target PARENT space  (comp space when unparented)
```

The parent-space step goes through the **parent's** `layerSpaceAt`, not the target's —
converting through the target's own space would fold its current transform into the answer
and the applied motion would be offset by wherever the target happened to be.

**Coasted samples** (occlusion predictions) are written too (`applyTrack.ts:24-27`): dropping
them would leave a hole the interpolator fills with a straight line anyway, "and the
prediction IS the best straight line available. They are honest data with a flag, not
fabrications."

Also in `src/core/tracking/`: `rotoBrush.ts`, `samSegment.ts` (SAM via onnxruntime-web),
`maskTrack.ts`, `sceneEditDetect.ts` (automatic cut detection), `planarFit.ts`,
`sfmCamera.ts`, `triangulate.ts`, `bundleAdjust.ts`.

### 14.4 Auto-reframe — 16:9 → 9:16 / 1:1 / 4:5

**`src/core/reframe/autoReframe.ts`**

The design decision is stated first (`autoReframe.ts:9-16`):

> **A new composition, never an edit of the old one.** … a 16:9 cut retargeted to 9:16, 1:1
> and 4:5 is four deliverables from one edit, and every one of them has to update when the
> edit changes. As a comp INSTANCE it does — re-cut the master and all four follow. Baking
> the crop into the original would have produced one file and destroyed the thing it came
> from.

And why it renders rather than reading the footage (`:18-25`):

> a composition is titles, graphics, effects and cuts as well as footage, and a reframe that
> ignores the lower third can crop it off. So the analysis pass is the real renderer at a
> small size … through the same deterministic offline loop the exporter uses.

Analysis runs at **160 px wide** (`:46-53` — "a centroid does not get more accurate above
about this") and **12 samples/second** (`:55-60` — comfortably above the rate a considered
camera move changes direction, and a quarter to a fifth of typical frame rate). `saliency.ts`
decides where to look; `reframePath.ts` decides how the frame moves; both are pure.

Cuts are detected via luma-histogram distance (`cutsFromDistances`, `histogramDistance`,
`lumaHistogram`) so the pan doesn't smear across a hard cut.

### 14.5 Frame blending and Pixel Motion

Set on a layer, resolved in `buildSnapshot` because **only `buildSnapshot` knows the comp's
frame rate** (`buildSnapshot.ts:2531-2536`):

```ts
// buildSnapshot.ts:2554-2557
const sourceFps = footageSourceOf(node)?.fps ?? fps;   // SOURCE rate when known
const bracket = bracketFrames(st, sourceFps);
return bracket.weight > 1e-3 ? { ...bracket, mode: fbMode } : undefined;
```

Two modes:
- **`mix`** — cross-dissolve between the two bracket frames.
- **`pixelMotion`** — optical-flow motion compensation (`feedPixelMotion`,
  `MotionRendererBackend.ts:1256-1287`; flow in `src/core/rendering/pixelMotionFlow.ts`).
  Needs **both** bracket frames from the exact decoder; while either is decoding, the ordinary
  ladder feeds the *nearest* bracket under the same key — "nearest-frame, never a hole, and
  never a half-warped guess" (`:1251-1255`). The warp is memoized on the frame pair + weight,
  since one comp frame re-requests it dozens of times (`:1265-1268`).

Only emitted for `layerKind === 'video'` (`buildSnapshot.ts:2540`) — "blending a shape would
mean nothing, its frames are continuous keyframes."

### 14.6 Effects

**175 effects** are registered in `EFFECT_DEFS` (`src/core/effects/effects.ts:593`, verified
by counting `type:` entries — 175). The `EffectType` union (`effects.ts:14+`) includes
`keylight` (chroma key), `levels`, `curves`, `channel-mixer`, `hue-saturation`,
`displacement-map`, `turbulent-displace`, `wave-warp`, `echo`, `directional-blur`,
`compound-blur`, `motion-tile`, `fractal-noise`, `curl-noise`, `bevel-alpha`, `sphere`,
`cylinder`, `spotlight`, `beam`, `gradient-ramp`, `four-color-gradient`, and more.

Effects are sampled **at the layer's own time** (`buildSnapshot.ts:~930-960`), so a Timecode
burn-in on a remapped or stretched layer reads the frame the layer is actually showing.
Layer styles are compiled into the same chain with stable ids
(`layerstyle:dropShadow`), which is what makes their parameters keyframeable through the
ordinary `effect.<id>.<key>` path — before that, "a drop shadow's distance, an overlay's
colour and a stroke's width simply could not be keyframed, while the identical parameter on
the equivalent EFFECT could" (`buildSnapshot.ts:~925-935`).

Additional video-specific machinery: `contentAwareFillVideo.ts` (temporal content-aware
fill), `pluginEffectBridge.ts` (third-party GPU effects), `cubeLut.ts` (.cube LUTs).

---

## 15. Stage 14 — Audio

### The design: a video's sound is an audio layer

`src/core/audio/audioScene.ts:20-27`:

> the `<video>` elements the renderer scrubs for frames are hard-muted … the audio track of
> an mp4/webm container [rides] the same pipeline as imported audio, instead of needing a
> parallel pipeline.

`readVideoAudioVoices` (`audioScene.ts:~290-310`) emits **one voice per clip bar**, so
retiming the video's bar retimes its sound with the picture:

```ts
// audioScene.ts:148-152 — the same clip geometry the picture uses
startSec: l.clip.start / fps,
inSec:    l.clip.sourceIn / fps,
outSec:  (l.clip.sourceIn + l.clip.duration) / fps,
```

Video layers carry **namespaced** audio props (`audioScene.ts:190-192`) rather than reusing
the audio component's `__level`/`__muted`. A hidden video is silent, matching how a hidden
audio layer behaves (`:254`). `videoHasAudioTrack` (`:206`) returns `boolean | null` —
`null` genuinely meaning "nobody looked", which the UI must distinguish from `false`.

Soloing works across both kinds (`:363-388`) — before that, "soloing a layer left every other
layer audible."

### Export mixdown

`src/core/audio/audioMixdown.ts:1-13`:

> Every MP4 and WebM this app produced was SILENT — the AudioEngine, audio import and
> per-layer audio all existed, but nothing carried the sound into an export.

It mixes over the export range into a single WAV via **`OfflineAudioContext`** — no
wall-clock, deterministic — at **48 kHz** (`:21`, "what AAC/most containers expect"). Gain
and scheduling mirror the live AudioEngine exactly (linear `level/100`, buffer offset
`inSec + (compTime − startSec)`) "so an export sounds like preview" (`:11-12`).

`audibleWindow` (`:36-59`) is exported specifically for testing, because "this scheduling
math (trim × range overlap) is where an off-by-one desyncs the whole export." It handles
playback rate correctly: bar length is wall seconds, source consumed is `barLen × rate`.

The WAV is staged to the job dir (`electron/main.ts:686-692`) and muxed by ffmpeg with
`-shortest`.

---

## 16. Stage 15 — Export

### 16.1 The deterministic loop

**`src/core/export/offlineRenderer.ts:135` — `renderOffline`**

```ts
// offlineRenderer.ts:1-13 (header)
// Replaces realtime MediaRecorder sampling (which drops frames and is non-reproducible)
// with a fixed-timestep loop: every frame's time is `index / fps` exactly, so the same
// project always renders byte-identical frames regardless of machine speed.
```

```ts
// offlineRenderer.ts:168-181
for (let i = start; i <= end; i++) {
  if (signal?.aborted) throw new DOMException('Render cancelled', 'AbortError');
  const t = frameTimeAt(i, params.fps);                       // exactly i / fps
  const snap = buildSnapshot(defaultSceneGraph, defaultAnimation, t, …,
    exportView(params.width, params.height, params.comp),      // 1:1 comp→frame, no preview inset
    params.motionBlur,
    exportComp(params.comp));                                  // forExport: true → drop guide layers
  backend.renderFrame(snap);
```

Two guards precede the loop:

- **`readyPromise`** is awaited (`:150-152`).
- **`initFailed` throws** (`:154-164`): a backend that failed to initialise still accepts
  `renderFrame` and draws nothing, so every frame reads back as an untouched canvas and the
  export completes "successfully" with a uniformly black file — "the single worst failure
  this pipeline can have, because nothing anywhere reports it."

`exportComp` (`:66-77`) is a deliberate sibling of `exportView`, and
`exportPathsMarkForExport.test.ts` **reads this directory's source, finds every
`buildSnapshot(` call, and asserts each is paired with it** — derived from code rather than
from a maintained list, so a fifth export path is caught the day it appears. `exportPreview`
counts as an export path on purpose: "it shows what the file will contain, so a guide layer
visible there would be a preview that lies."

### 16.2 Media convergence — the part that makes video export correct

```ts
// offlineRenderer.ts:186-196
for (let pass = 0; pass < 4; pass++) {
  const waits = backend.takeMediaWaits?.();
  if (!waits || waits.length === 0) break;
  await Promise.race([Promise.all(waits), new Promise(r => capTimer = setTimeout(r, 15_000))]);
  backend.renderFrame(snap);
}
```

`takeMediaWaits` merges the element-tier seek waits with `exactVideoFrames.waits()`
(`MotionRendererBackend.ts:1077-1085`) "so the export convergence loop also settles onto exact
frames — an exported frame must never be the `exact: false` nearest-neighbour a live repaint
would have corrected a tick later."

### 16.3 The exactness gate — export *refuses*

```ts
// offlineRenderer.ts:210-216
if (backend.lastFrameMediaExact?.() === false) {
  throw new Error(
    `Export stopped at frame ${i}: the video decode for this frame did not finish in time, `
    + 'so the frame would contain stale footage pixels. …');
}
```

The reasoning at `:201-209`:

> the renderer KNOWS when a frame holds stand-in video pixels … but only the RAM preview
> cache ever read it. The DELIVERABLE accepted the stale frame … The rule is the opposite —
> **wrong pixels on screen are recoverable; wrong pixels in a file are not** — so a frame
> that never converged REFUSES.

The same rule applies to compositing diagnostics (`:218-234`), thrown **before `onFrame`**,
"so a frame known to be wrong is never handed to the sink. A refused export beats a
half-written file that looks finished."

### 16.4 The sinks

`createVideoSink` (`videoSink.ts:762-772`) routes:

```ts
if (isPluginFormat(params.format)) return new PluginSink(params);   // checked FIRST
if (canEncodeLocally())            return new FfmpegSink(params);
if (params.format === 'webm' && canEncodeWithWebCodecs()) return new WebCodecsSink(params);
return null;                                                        // caller must message clearly
```

Plugin formats are checked first and unconditionally (`:763-765`) because reaching the ffmpeg
branch "would silently produce an MP4 under the plugin's extension."

#### `FfmpegSink` — desktop (`videoSink.ts:288`)

Each frame is snapshotted into a pooled canvas and encoded **in the background with several
in flight** (`:297-305`), so the GPU renders frame N+1 while frames N−k…N are still being
encoded. Staged files are named by index, so completion order doesn't matter to ffmpeg.

`FramePipeline` (`src/core/export/framePipeline.ts`) is the bounded queue. Its header
(`:1-22`) explains the win precisely:

> the per-frame render stays serial (one GPU, one scene graph), but the encode-and-stage of
> frame N overlaps the render of N+1 … N+k, and the browser's image encoder runs `toBlob`
> calls on its own thread pool, so k encodes in flight use k cores.

Concurrency defaults to cores − 1, clamped to 2..6 (`framePipeline.ts:30-33`). `push` waits
for **any** job (`Promise.race`) rather than the oldest, "so a slow frame must not hold a free
slot hostage" (`:59-63`). The first failure wins and is rethrown by the next `push` or by
`drain`, "so a failed frame cannot be silently skipped into a file with a hole in it."

**Staging format** (`videoSink.ts:292-313`): PNG for transparent / HDR / **MOV** — the MOV
case is called out because "the preset promises lossless ProRes 4444, and an opaque comp used
to stage through JPEG 0.95 — paying 4444's file size for JPEG-degraded, chroma-subsampled
pixels." JPEG otherwise.

**Zero frames throws** (`:387-390`) — never a header-only file.

#### `WebCodecsSink` — browser (`videoSink.ts:627`)

`VideoEncoder` configured `vp09.00.10.08` (`:663-670`), chunks collected with their
`decoderConfig.description` copied for CodecPrivate, muxed by `webmMuxer.ts`.

#### What both replaced

`videoSink.ts:17-24`:

> `MediaRecorder` on a `captureStream` canvas. That path paced the render at wall-clock speed
> (a 60-second comp took 60 seconds of `sleep`), could not report how many frames it had
> captured, and when it captured none — which happens routinely for an off-screen canvas — it
> still resolved successfully with a header-only file. **Users got a black video and a green
> "Export complete" toast.**

### 16.5 The ffmpeg encode (main process)

`electron/main.ts:698-866`. Shared setup:

```ts
const input = path.join(dir, `frame_%04d.${staged.ext}`);
const evenScale = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';   // yuv420p requires even dims
const crf = quality === 'draft' ? '28' : quality === 'medium' ? '23' : '18';
const base = ['-y','-framerate', ffmpegRate(fps), '-i', input, ...(hasAudio ? ['-i', audio] : [])];
```

| Format | Codec & flags | Notes |
|---|---|---|
| **MP4** (`:852-871`) | `libx264`, `-crf`, `-pix_fmt yuv420p`, `-movflags +faststart`, AAC 192k | H.264 carries **no alpha** — a transparent comp stages as RGBA PNG and this **flattens over black**. That is ffmpeg's own behaviour, "relied on deliberately rather than stumbled into, and now stated in the composition settings dialog so nobody first discovers it in a delivered file." `+faststart` because otherwise the moov atom lands at the end and browsers refuse to play until fully downloaded. |
| **WebM** (`:798-814`) | `libvpx-vp9`, `-row-mt 1 -threads 0`, `yuva420p` + `-auto-alt-ref 0` when PNG-staged, Opus 160k | VP9 is the only mainstream codec with an alpha channel; **alt-ref frames must be off for alpha** or the channel is discarded. |
| **MOV** (`:829-850`) | `prores_ks`, profile 0–4, `yuv422p10le` / `yuva444p10le`, PCM audio | Profile map: proxy=0, lt=1, 422=2, hq=3, **4444=4** (the only one with alpha). |
| **GIF** (`:815-828`) | `palettegen=stats_mode=diff` + `paletteuse=dither=bayer` in one `filter_complex` | Two passes in one graph — "a single-pass GIF quantises per frame and visibly bands and flickers." |
| **HDR10 / HLG** (`:740-795`) | `libx265` 10-bit with full `master-display` + `max-cll`; falls back to `libx264 -profile:v high10` with the same tags | `probeLibx265()` runs **once** so a missing binary doesn't cost a failed spawn. |

**HDR is measured, not fabricated** (`videoSink.ts:335-365`): the sink prefers a **float
linear readback** from the backend so PQ/HLG quantises once; the 8-bit fallback reconstructs
linear from display-sRGB bytes, "which is where HDR10 exports banded in shadows." And
MaxCLL/MaxFALL are accumulated through a 2-D scratch context because `getContext('2d')` on the
GPU-owned render canvas returns `null` — which silently skipped the stats, so "**every HDR10
file shipped fabricated max-cll=1,1 mastering metadata that display tone-mappers actually
read**."

### 16.6 Delivery

`moveOutput` (`electron/main.ts:893`) **renames** the encoded file to the user's chosen
path (falling back to a copy across volumes). The alternative — reading the file back into the
renderer as a Blob and triggering a browser download — "copies the entire output through the
renderer heap and drops it in the default download folder. For a desktop app exporting
multi-gigabyte video, both halves of that are wrong."

### 16.7 Pause / resume

`createResumableVideoRender` (`exportManager.ts:595`) is cheap because of how the desktop sink
already works (`:597-604`): every frame lands as an image in a per-job temp dir and ffmpeg
encodes **once** at the end from `frame_%04d`, so "a paused render is nothing more exotic than
'the loop stopped after frame N and the files for 0..N are still there'." `run` treats the
abort signal as **pause**, resolving with the next offset instead of throwing, and
deliberately does **not** dispose the sink — disposal deletes the staging dir.

### 16.8 Other export paths

`exportManager.ts` also provides: `renderSequenceZip` (PNG/JPEG sequence, `:245`),
`renderExrSequenceZip` (`:440`), `renderGifBlob` (`:734`), `renderThumbnailBlob` (`:134`),
plus NLE interchange — `exportEdl.ts`, `exportFcpxml.ts`, `exportOtio.ts`, `exportAle.ts`,
`exportMogrt.ts` — all of which read the same `layer.clip.sourceIn` / `duration` geometry
(e.g. `exportEdl.ts:71-80` converting to timecode).

### 16.9 Headless CLI

`src/core/cli/headlessRender.ts` is the renderer half of `premation render`
(`:2-7`). It runs **in the renderer process on purpose** (`:7`): "the render pipeline is a DOM
pipeline — 20+ render-path modules touch `document`." It can auto-reframe before rendering
(`:91-98`) and burn in captions, and it deliberately does **not** wait for footage to pop in
late (`:325`) — a render cannot.

---

## 17. Failure-mode matrix

Every one of these is an explicit, cited decision — not an accident:

| Situation | Behaviour | Code |
|---|---|---|
| No ffprobe on the host | `elementOnly` tier; import proceeds, `fps` stays `undefined` | `mediaProbe.ts:22-31` |
| Probe throws | `none` tier; import proceeds | `mediaProbe.ts:94-96` |
| Container opens but never fires `loadedmetadata` or `error` | 10 s timeout, import continues | `assetStore.ts:525-542` |
| Ingest transcode fails | Import the original bytes unchanged | `ingest.ts:143-146`, `assetStore.ts:612` |
| Camera-raw decode fails | Named error naming the likely cause (host ffmpeg lacks libraw) | `ingest.ts:199-204` |
| Plugin decode throws | Error surfaced as the plugin's problem, rethrown — never a silent "unsupported file" | `assetStore.ts:565-577` |
| No WebCodecs | Sticky `unavailable`; element tier | `exactVideoFrames.ts:583-587` |
| Bytes don't demux | Sticky `unavailable`; element tier | `exactVideoFrames.ts:614-621` |
| File > 1.5 GB | Refused for in-memory demux; message says "generate a proxy" | `exactVideoFrames.ts:174-176` |
| Alpha WebM | Refused by exact tier **to preserve transparency** | `exactVideoFrames.ts:154-160` |
| Decoder errors 3× | Sticky `unavailable` | `exactVideoFrames.ts:56-58`, `:652-655` |
| Decode in flight | Nearest cached neighbour, `exact: false`, repaint follows | `exactVideoFrames.ts:504-521` |
| Source untouched 90 s | Decoder + frames + file bytes fully released | `exactVideoFrames.ts:207-222` |
| Proxy generating / failed / missing | Full resolution — never black, never an error | `proxy.ts:176-187` |
| Proxy record with a `blob:` src | Not persisted (would restore dead) | `proxy.ts:191-206` |
| Image decode fails | AE-style colour bars + `media-unavailable` diagnostic | `AppTextureProvider.ts:11-14`, `:713-734` |
| Layer undecoded this tick | 1×1 **transparent** placeholder (never white) | `AppTextureProvider.ts:9-13` |
| Export frame never converged | **Export refuses** with an actionable message | `offlineRenderer.ts:210-216` |
| Export frame has compositing diagnostics | **Export refuses** before `onFrame` | `offlineRenderer.ts:218-234` |
| Backend failed to init | **Export throws** rather than writing a black file | `offlineRenderer.ts:154-164` |
| Zero frames staged | **Throws** — never a header-only file | `videoSink.ts:387-390`, `main.ts:723-725` |
| Odd comp dimensions | `scale=trunc(iw/2)*2:trunc(ih/2)*2` | `main.ts:730-732` |
| Transparent comp → MP4 | Flattened over black, **stated in the comp settings dialog** | `main.ts:860-864` |
| Format unencodable here | `createVideoSink` returns `null`; caller must message — never silently writes a different format | `videoSink.ts:757-761` |
| App quits mid-proxy | Every ffmpeg child killed | `main.ts:658-660` |

---

## 18. End-to-end trace of one MP4

**Scenario:** user drags `shot_04.mp4` (3840×2160, H.264, 23.976 fps, 12 s, with audio) onto
an empty composition, trims it, keyframes a push-in, tracks a highlight, and exports MP4.

```
1.  DROP          Workspace.tsx:319         onDropCanvas — file drag detected
2.  FILTER        Workspace.tsx:330         MIME video/mp4 → accepted
3.  IMPORT        assetStore.ts:770         addAssetsBatch → addAsset per file
4.  PLUGIN CHECK  assetStore.ts:550-581     decodeWithPlugin → null (not a plugin format)
5.  INGEST?       ingest.ts:209             ingestCandidate('shot_04.mp4') → false → null
                                            (no re-encode: H.264 MP4 plays natively)
6.  BYTES HOME    assetStore.ts:614         local-first? → importLocalAsset → motion-blob:<sha256>
                  importLocalAsset.ts:33                    content-addressed into the bundle
7.  ELEMENT PROBE assetStore.ts:706-729     <video> → 3840×2160, duration ≈ 12.0
8.  FFPROBE       assetStore.ts:448 → mediaProbe.ts:86 → IPC 'media:probe'
                  main.ts:571-577           ffprobe -show_format -show_streams
                  mediaProbeParse.ts:114    avg_frame_rate "24000/1001" → 23.976
                  mediaProbeParse.ts:87     streamHasAlpha → false
                  mediaProbeParse.ts:105    container duration 12.012 (exact) overrides element's
                  assetStore.ts:452-464     metadata = {w,h,duration:12.012,fps:23.976,hasAudioTrack:true}
9.  AUTO-PROXY    assetStore.ts:500         triggerAutoProxy → proxyManager.maybeAutoGenerateProxy
                  proxy.ts:105              proxyResolution(3840,2160) → 1920×1080
                  proxy.ts:157-165          ffmpeg -vf scale=1920:1080 -c:v libx264 -crf 25 -g 12 -an
                  main.ts:608               spawned as a CHILD PROCESS, cancellable
10. EMPTY COMP?   Workspace.tsx:339-343     no content layers → comp-from-footage
11. COMP          compositionOps.ts:266-277 3840×2160, 12.012 s, 23.976 fps, named "shot_04"
12. LAYER         sceneInsert.ts:1486       insertMedia
                  sceneInsert.ts:1564       computeFit contain → 3840×2160 (comp matches, 1:1)
                  sceneInsert.ts:1576-1577  transform.props.src = "motion-blob:…"; .assetId = "…"
13. CLIP BAR      TimelineController.syncFromScene → Clip{start:0, duration:288, sourceIn:0,
                                                          sourceDuration:288}
14. TRIM          Clip.ts:69                trimStart(24) → start 24, duration 264, sourceIn 24
                                            (media stays in sync — sourceIn moved with start)
15. KEYFRAME      transformWrite.ts:114-123 scale 100 @ t0, scale 118 @ t1  (writesAsKeyframe →
                                            stopwatch lit, so it keyframes regardless of auto-key)
16. TRACK         trackVideoLayer.ts:315    comp frame → compToKeyframeTime → media seconds
                                            → ExactVideoSource.frameIndexAt → presentation index
                  exactVideoSource.ts:413   SequentialFrameReader, prefer-software (3× faster readback)
                  applyTrack.ts:93          samples → position keyframes on a target layer
────────────────────────  PLAYBACK / SCRUB, per displayed frame  ────────────────────────
17. SNAPSHOT      buildSnapshot.ts          t → precomp chain → clip map → loop → posterize
                                            → stretch/reverse → sourceTime
                  buildSnapshot.ts:2707     resolveMediaSrc(asset, comp.useProxies) → PROXY src
                                            (viewport only)
18. FEED          MotionRendererBackend.ts:1178  feedVideoFrame
19. DECODE        exactVideoFrames.ts:271   get(src, sourceTime)
                  exactVideoFrames.ts:290   frameIndexAt(round(t·1e6) + 1)   ← the +1µs rule
                  ├ cache hit  → advanceStream, return {exact:true}
                  └ miss       → noteMiss → ascending run → startStream
                                 exactVideoSource.ts:511  pump: feed ≤24 chunks, ≤4 queued
                                 exactVideoSource.ts:566  onOutput → route by timestamp
                                 exactVideoFrames.ts:666  capture → apply rotation → canvas → LRU
20. UPLOAD        MotionRendererBackend.ts:1148  feedScaledFrame → zoom bucket downscale
                  AppTextureProvider.ts     premultiplied-alpha texture
21. COMPOSITE     GPU: transform matrix, effects chain, blend mode, masks, mattes
────────────────────────────────────  EXPORT  ────────────────────────────────────────
22. AUDIO         audioMixdown.ts           OfflineAudioContext @48kHz → WAV
                  main.ts:686               staged as audio.wav in the job dir
23. LOOP          offlineRenderer.ts:168    t = i / 23.976, exactly
                  offlineRenderer.ts:172    buildSnapshot with exportComp (forExport → no guides)
                                            and NO useProxies → decodes the ORIGINAL 4K
24. CONVERGE      offlineRenderer.ts:186    ≤4 passes, 15 s cap, awaiting takeMediaWaits()
25. GATE          offlineRenderer.ts:210    lastFrameMediaExact() === false → THROW, no file written
26. STAGE         videoSink.ts:374          FramePipeline: k encodes in flight → frame_%04d.jpg
27. ENCODE        main.ts:852-871           ffmpeg -framerate 24000/1001 -i frame_%04d.jpg
                                            -c:v libx264 -crf 18 -pix_fmt yuv420p
                                            -movflags +faststart -c:a aac -b:a 192k -shortest
28. DELIVER       main.ts:893              rename() to the user's chosen path (copy across volumes)
```

---

## 19. Where the code proves itself (tests)

The video pipeline is unusually well pinned, and the *reason* each seam is testable is
documented at the seam:

| Test | Proves |
|---|---|
| `src/core/video/mp4Demuxer.test.ts` | Real ffmpeg-encoded MP4 fixtures demux in Node — mp4box is pure JS, no WASM (`mp4Demuxer.ts:5-9`) |
| `src/core/video/frameIndex.test.ts` | GOP start, feed-through, and B-frame reorder on a fixture that decodes `I P B B…` / presents `I B B P…` |
| `src/core/video/exactVideoSource.test.ts` | The **entire feeding discipline** — key-first, decode order, right range, flush, cache, eviction, error paths — against a fake `DecoderIO`, because jsdom has no WebCodecs (`exactVideoSource.ts:25-34`) |
| `src/core/video/pulldownDetect.test.ts` | The 3:2 cadence signature on synthetic telecine |
| `src/core/rendering/exactVideoFrames.test.ts` | Cache states, streaming transitions, loop-wrap detection, LRU |
| `src/core/rendering/proxyExport.test.ts` | Three independent proofs that export never uses a proxy: behavioural, structural (default false), and **static — no file on an output path even mentions `useProxies`** (`:11-13`, `:141-142`) |
| `src/core/export/exportPathsMarkForExport.test.ts` | Reads the export directory's **source**, finds every `buildSnapshot(` call, asserts each is paired with `exportComp` |
| `src/core/export/frameContract.test.ts`, `exportRefusesBadFrame.test.ts` | The refusal gates actually fire |
| `src/core/export/framePipeline.test.ts` | Ordering + back-pressure with fake timers (pure, DOM-free by design) |
| `src/core/assets/proxyEncode.integration.test.ts` | End-to-end proxy encode |
| `electron/mediaProbeParse.test.ts`, `mediaProbeAlpha.test.ts` | ffprobe JSON parsing against **real** output, without Electron |
| `src/core/audio/audioMixdown*.test.ts`, `videoAudio.test.ts` | Mixdown scheduling math (`audibleWindow` is exported solely for this) |
| `src/core/rendering/deinterlace.test.ts`, `frameBlendSourceRate.test.ts` | Field reconstruction; blending brackets on the **source** rate |
| `packages/render-tests/` (`npm run render-tests`) | Pixel-level golden-image regression through the real GPU backend |
| `e2e/` + `playwright.config.ts` | Full-app flows |

A recurring pattern across the codebase is worth naming: **hard-to-test dependencies are
replaced by injectable seams so the decidable part can be tested exhaustively.** `DecoderIO`
for WebCodecs (`exactVideoSource.ts:79-98`), `ExactSourceLoader` / `SequentialReaderLike` /
`makeReader` for the cache (`exactVideoFrames.ts:224-236`), `LocalBlobResolver` for bundle
bytes (`localBlobSource.ts:24-26`), `CompSourceLookup` for comp facts (`sourceInfo.ts:145-149`),
`VideoFactory` for elements (`videoFrameCache.ts:99`). Byte-level decode correctness needs a
real Chromium; "everything decidable above the codec is decided here."

---

## Appendix A — File map

```
IMPORT
  src/core/assets/ingest.ts ............... transcode-on-import (ffmpeg args as data)
  src/core/assets/mediaProbe.ts ........... renderer-side probe, 3-tier degradation
  electron/mediaProbeParse.ts ............. ffprobe JSON → facts (pure, testable)
  src/core/assets/decodeWithPlugin.ts ..... plugin-claimed formats
  src/core/media/{exr,dpx,psd,floatExr}.ts  in-process decoders
  src/stores/assetStore.ts ................ the import funnel + asset record

STORAGE
  src/core/assets/local/importLocalAsset.ts  content-addressed bundle import
  src/core/rendering/localBlobSource.ts ..... motion-blob: resolution
  src/core/services/AssetDatabase.ts ........ IndexedDB tier

PROXIES
  src/core/assets/proxy.ts ................ the rule + the invariant
  src/core/assets/proxyManager.ts ......... the driver
  electron/main.ts:608 .................... the ffmpeg child

INTERPRETATION
  src/core/source/sourceInfo.ts ........... FootageInterpretation, SourceInfo, applyLoop
  src/core/video/pulldownDetect.ts ........ 3:2 cadence detection + inverse telecine
  src/layout/Assets/InterpretFootageModal.tsx

TIMELINE
  packages/timeline/src/clips/Clip.ts ..... trim / slip / slide / split geometry
  packages/timeline/src/core/Timeline.ts .. the timeline model
  src/core/timeline/TimelineController.ts . app-facing verbs + the keyframe time axis
  src/core/library/clipWindow.ts .......... insert-time clip windows

DECODE
  src/core/video/mp4Demuxer.ts ............ mp4box demux
  src/core/video/webmDemuxer.ts ........... EBML/Matroska subset
  src/core/video/frameIndex.ts ............ presentation order, GOP start, feed-through
  src/core/video/exactVideoSource.ts ...... ExactVideoSource + SequentialFrameReader
  src/core/rendering/exactVideoFrames.ts .. render-facing cache, streaming, pulldown weave
  src/core/rendering/videoFrameCache.ts ... element-seek fallback tier
  src/core/rendering/deinterlace.ts ....... field separation

RENDER
  src/core/rendering/buildSnapshot.ts ..... scene + time → RenderLayer[]
  src/core/rendering/MotionRendererBackend.ts  the decode ladder
  src/core/rendering/AppTextureProvider.ts  textureKey → GPU texture, alpha invariant
  src/core/rendering/frameCache.ts ........ RAM preview (rendered frames)
  src/core/rendering/pixelMotion*.ts ...... optical-flow frame interpolation

MOTION
  src/core/scene/transformWrite.ts ........ the AE keyframing contract
  packages/animation/src/interpolate.ts ... easing + spatial tangents
  src/core/tracking/*.ts .................. 2D / planar / 3D tracking, roto, SAM, cut detect
  src/core/reframe/*.ts ................... auto-reframe
  src/core/effects/effects.ts ............. 175 effect definitions

AUDIO
  src/core/audio/audioScene.ts ............ video audio as audio layers
  src/core/audio/audioMixdown.ts .......... deterministic export mixdown

EXPORT
  src/core/export/offlineRenderer.ts ...... deterministic loop + convergence + gates
  src/core/export/videoSink.ts ............ FfmpegSink / WebCodecsSink / PluginSink
  src/core/export/framePipeline.ts ........ overlapped encode-and-stage
  src/core/export/exportManager.ts ........ orchestration, resumable renders
  src/core/export/export{Edl,Fcpxml,Otio,Ale,Mogrt}.ts  NLE interchange
  electron/main.ts:663-910 ................ staging + ffmpeg encode + delivery
  src/core/cli/headlessRender.ts .......... `premation render`
```

## Appendix B — Constants worth knowing

| Constant | Value | File |
|---|---|---|
| Ingest CRF (opaque) / GOP | 16 / 15 | `ingest.ts:96-101` |
| Ingest alpha CRF / GOP | 20 / 15 | `ingest.ts:84-85` |
| Proxy target long edge | 1920 | `proxy.ts:80` |
| Proxy min source long edge | 1280 (below → no proxy) | `proxy.ts:78` |
| Proxy CRF / GOP | 25 (x264) / 34 (VP9), `-g 12` | `proxy.ts:160-163` |
| Exact frame cache per source | 512 MB | `exactVideoFrames.ts:49-50` |
| Max in-memory demux | 1.5 GB | `exactVideoFrames.ts:52-55` |
| Decode failures → unavailable | 3 | `exactVideoFrames.ts:57-58` |
| Stream lookahead / play window | 25 / 45 frames | `exactVideoFrames.ts:70-77` |
| Idle source eviction | 90 s | `exactVideoFrames.ts:212` |
| Canvas pool | 8 | `exactVideoFrames.ts:685` |
| `ExactVideoSource` frame cache | 12 (min 4) | `exactVideoSource.ts:164`, `:217` |
| Sequential feed-ahead / queue | 24 chunks / 4 frames | `exactVideoSource.ts:400-403` |
| Element seek queue depth | 8 | `videoFrameCache.ts:89-92` |
| Export convergence | 4 passes, 15 s cap | `offlineRenderer.ts:186-193` |
| Export pipeline concurrency | cores − 1, clamped 2..6 | `framePipeline.ts:30-33` |
| Export CRF (high/med/draft) | 18 / 23 / 28 | `main.ts:733` |
| Audio export sample rate | 48 kHz | `audioMixdown.ts:21` |
| Element metadata probe timeout | 10 s | `assetStore.ts:529` |
| Registered effects | 175 | `effects.ts:593` |
