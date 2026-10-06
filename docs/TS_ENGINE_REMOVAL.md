# Removing the TypeScript engine — one engine, C++

> **Owner decision, 2026-09-26.** Premation has ONE engine: the C++ process
> `premation-engine`. Every feature, logic and engine lives there — evaluation,
> rendering, effects, media, text, audio, export, and the analysis jobs
> (tracking, object matte / SAM, transcription, scene detect, auto-reframe,
> proxies, bakes). Electron + React are the UI only and talk to the engine only
> through `packages/engine-api` (`EngineClient`), reading through the mirror.
> This supersedes the "TypeScript fallback kept behind a flag" rule of
> `NATIVE_CORE_PLAN.md` §0 and `CLAUDE.md`; both were updated 2026-10-04.
> Work lands on `native-core` only; it is never merged into `main` or `dev`.
> Since 2026-10-06 `native-core` is the default branch and releases are tagged
> from it (RELEASING.md §7).
>
> **Confirmed 2026-09-28:** the C++ engine is the default now (viewport,
> document owner, export — f56f215f) and stays so without waiting for
> bit-identity on the 10 ceiling frames; no TypeScript fallback is preserved
> for its own sake — new work does not add page fallbacks, and phase 4 deletes
> the existing ones. Benchmarks and real-hardware testing come after the build
> is complete.

Measured on `native-core` @ ff03f0f1: about **270k production lines and 175k
test lines** of TypeScript engine go. Rough size: 5–8 months for one small team.

## Blockers found before any deletion

1. **The engine viewport exists only on Windows.** `shared_texture_ffi.cpp` is
   D3D11/NT-handle, built `if(WIN32)`; `electron/engineHost.ts` drops non-shared
   frames. No IOSurface (macOS) or dmabuf (Linux) path; route-A copy not wired.
   **2026-09-28 (platform-plumbing): closed in code, verified on Windows only.**
   Route A (pixel copy over fd 5 → `engine:pixels` → VideoFrame) runs in the
   real app on the Windows box when forced with `PREMATION_VIEWPORT_ROUTE=copy`
   (29.9 fps / p50 11.5 ms vs route C 30.0 / 10.8 on bench.json); it is what
   macOS without the host bridge and Linux without GBM get. macOS IOSurface
   (p0-platform) and Linux dmabuf (`shared_texture_ffi_linux.cpp` + the
   `pidfd_getfd` host bridge, this branch) are written and compile-gated in CI,
   never run — `docs/VERIFY_ON_TEST_MACHINE.md` "platform-plumbing".
2. **The C++ build reads TypeScript sources:** WGSL (`native/engine/shaders/extract.mjs`
   from `packages/renderer/src/shaders`), the property catalog
   (`core/generated/catalog_data.inc` from ~25 TS registries via
   `crossEngineCatalog.test.ts`), `raster/vertical_orientation.inc`, and the
   golden gate's `.pfs` inputs from the TS WebGPU pass.
3. **Release/CI never build the engine** (`release.yml`; `scripts/stageEngine.cjs`
   ships an empty folder when it is missing). **Closed:** native.yml `engine`
   (3 OSes) and release.yml `engine` (win, mac arm64, mac x64) build it through
   `.github/actions/build-engine` with a vcpkg binary cache; render-tests.yml
   `native-golden` builds it on Windows and runs the native golden gate on WARP
   (non-blocking until its first run is reviewed); `stageEngine.cjs` refuses a
   package without the engine and ignores `PREMATION_PACKAGE_WITHOUT_ENGINE`
   in CI; electron-builder ships `<resources>/engine` (signs the .exe on
   Windows through extraResources, codesigns the nested Mach-Os). None of the
   workflows has run yet (validated structurally, and every Windows script step
   run locally).

## What goes (prod / test lines)

| Group | Paths | Prod | Tests |
|---|---|--:|--:|
| Document + evaluation | `src/core/{engine (engine half), scene, animation, timeline, composition, rig, particles, simulation, geometry, textExpr, motion}`, `packages/{scene, animation, timeline}` | ~89k | ~57k |
| Renderer + effects | `packages/renderer`, `src/core/{rendering, effects, paint, svg}` | ~98k | ~55k |
| Media, text, audio | `src/core/{video, media, audio, text, fonts}` | ~26k | ~16k |
| Hidden-window export | `src/core/export` (render half), `electron/cliRender.ts`, `src/pages/RenderPage.tsx`, `packages/render-worker`, TS benches | ~9k | ~3k |
| JS plugin system (G2) | `src/core/plugins`, `electron/plugin*.ts`, `packages/plugin-native-sdk`, `examples/plugins` | ~33k | ~21k |
| Analysis in the page | `src/core/{tracking, reframe}`, SAM/onnx, content-aware-fill bake | ~10k | ~3k |
| Fallback / replica plumbing | `ownedEngineClient`, `engineOwnership`, `legacyRefresh`, processEngine fallback, historyStore debounce recorder, `windowSync`, `compositeEdit`/`documentSwap`/`headlessRender`, page project IO, TS migrations, `persistence` | ~6k | ~5k |
| Native odds | `packages/native-bridge` (0 users), `native/bindings/napi` | small | |
| Parity generators | 26 `*CrossEngine.test.ts`, d1/undo parity, corpus/harness helpers, `packages/render-tests` harness | | ~15k |

## What stays

`packages/engine-api` + codegen; `ProcessEngineClient`, `idMap`; the mirror
(`src/core/mirror`, `src/stores/documentMirror.ts`, `useMirror*`); editor-state
stores; `design-system`, `ai-tools`, `caster`, `technique-library`,
`product-motion`; `src/core/{commands (palette/shortcuts), config, i18n, api,
auth, services, settings, theme, dnd, logging, analytics, localIndex, sync,
library, scripting, automation}`; the interaction layer (`packages/workspace`,
`src/core/workspace`) with a mirror-backed `SceneGraphPort`. A ~1.5k-line
client slice of `src/core/engine` (`uiEdits`, `engineInstance`, `engineTransport`,
`time`, `displayTime`) moves to `src/engine-client/`.

Data decisions:
- **Migrations → C++ only** (`docio.cpp migrate_document`); freeze the TS
  migration inputs/outputs under `native/engine/tests/data/migrations/`.
- **Parity fixtures → frozen data**; each C++ parity test gains a re-bless mode
  (`PARITY_REBLESS=1`, reviewed diff). Generators deleted.
- **Catalog → `native/engine/catalog/*.json`** (C++-owned); `engine-api:gen`
  emits `generated/catalog.ts` for the UI's synchronous effect/property metadata.
- **WGSL → `native/engine/shaders/wgsl/*.wgsl`** + `materials.json`, embedded by CMake.
- **Golden gate → native vs the 359 reference folders**, scenes exported once to
  `packages/render-tests/scenes/*.json`.
- **Importers** (AEP, Lottie, SVG, templates/mogrt) become command-batch clients or are ported.

## Gaps to close in C++ before cutting the UI over

- Queries: `getLayerBounds` / `getTextLayout` answer in both engines since
  b4-round2 (the C++ text answer needs the full engine's fonts: `unsupported`
  headless; viewport-space bounds and `includeEffects` stay `unsupported` —
  the overlay geometry push carries screen geometry). `evaluateExpression`
  takes a `member` and previews Source Text since b4-round3; `getSearchFacts`
  and `LayerInfo.pluginSchemaVersion` since b4-round4. Still missing for the
  UI's last reads: rig pins / bones and 3D view projection in the overlay push,
  `TextLayout.glyphs`, an `ItemInfo` media URL + proxy record, and the other
  fields listed in B4_MIRROR.md "b4-round4".
  (`listFonts` answers from the OS font catalogue since
  p0-platform; `getWaveform`, `getThumbnail`, `hitTest`, `readPixels` answer
  from the C++ engine since d2w-round2.)
- Commands answering `unsupported` (2026-09-28, `convert-round2`): none of the
  conversions. The C++ engine answers every `convertLayer` (shapes / masks from
  text with the font's own Béziers, shapes from vector, editable text,
  uncompose, bake transform), `separateLayer`, the `autoTrace` command,
  `collectFiles`, `.aep` / `.mogrt.zip` `importProject`. The Layer menu's
  Shapes / Masks from Text and a static SVG's Convert to Editable Shapes ask
  the engine first; the editor macros stay for the TypeScript engine (and an
  animated / clipped SVG) and go with it in phase 4.
- **Jobs (2026-09-28, `engine-jobs3`, built and run on the Windows box):**
  transcribe runs in the engine (the owner's decision: the engine calls the
  user's speech provider with a key Electron main writes into the job request
  per job — never persisted or logged by the engine); auto-trace reads a solo
  render (`rendered`); roto brush, content-aware fill and auto-reframe run end
  to end from their UI callers; job results are in main's command log
  (`logRecord`), so a crash replay writes them without re-running the job;
  footage jobs follow Time Remap / Speed %. The page paths stay only as the
  TypeScript engine's fallback (`unsupported`) and go with it in phase 4.
- **Jobs (2026-09-27, branch `engine-jobs`, written and syntax-checked, not
  built or run):** the C++ engine runs `startJob` for trackMotion (position,
  rotation/scale, corner pin, stabilize-by-point), stabilize (similarity),
  autoTrace, sceneDetect, objectMatte (ONNX Runtime, child process),
  audioAnalysis (beats, amplitude track, silence detect/remove), audioDuck,
  audioGate, proxy, render and prerender (child `--export`); `getJobs` lists
  them (ENGINE_API.md §4.9). UI callers ask the engine first
  (`src/core/engine/engineJobs.ts`) and fall back to the page path on
  `unsupported`. Still page-only: mask / planar tracks, Create Null & Apply,
  mesh warp / camera solve / roto brush / content-aware fill, the smooth
  stabilizer's subspace and rolling-shutter variants, auto-reframe (saliency
  + a path — no job kind yet), and **transcribe** — the page sends the comp's
  mixdown to the user's speech provider through Electron main, which holds
  the key; no local model ships, so the engine refuses the job. Decision
  needed: a bundled local model (whisper.cpp) or the engine calling the
  provider with a key main hands over. Portable DEFLATE zips open in the
  engine (2026-09-27).
- **Frame-synchronous overlay geometry push** (world matrices, bounds, motion
  paths, pins/bones, text boxes on `FrameReady`) — replaces ~75 per-frame reads.
- B4 exit fields (media type, proxy, playable URL, mographId, svg, essentialProps,
  multicam angle, freeze / stretch / roll limits, Lift, capturePreset,
  evaluateExpression{member}, rig-track sampler, per-member keys).
- AI `LEGACY_GAPS` + `scene.apply` abort-on-failure (92 sites).
- Pop-out windows as second mirrors; command log in main; multiple viewports;
  session `blob:` footage written to a cache file then `importFiles`.
  **2026-09-28 (platform-plumbing):** the command log was already in main
  (`electron/engineCommandLog.ts`) and pop-outs already mirrors (events relayed
  to every window). New: **multiple viewports** — every `setViewport` id is its
  own engine surface (Session keeps a map; the render thread one ring per
  viewport, generations unique across them, viewports served round-robin);
  main routes each viewport's frames to the window that set it up, receivers
  and route-A copies are per window; a pop-out's EngineSurface uses its own id
  block (`engine:viewportBase`, webContents id × 256), so a popped-out Viewport
  is a second live engine surface (real app: editor + pop-out both at ~30 fps,
  route C and route A). **Session footage**: the engine has an import port on
  disk (`FilePorts`: `importFiles` probes with ffmpeg, `importBytes` writes a
  content-addressed cache file under `<userData>/session-footage` first), and
  wherever it reads an asset's media (footage, sprites, sky, height map, audio)
  it takes the record's file `path` when `src` is a `blob:` / `http:` URL
  (`doc::asset_media_src`), so the page's cache-file relink
  (`sessionFootage.ts`) reaches the renderer. Decision: the page RELINKS the
  existing item to the cache file (`relinkItem`) rather than re-importing it —
  the item id and every layer on it stay; a new import of bytes goes through
  `importBytes` and never leaves a `blob:` in the engine's document.

## Features that exist only in TypeScript today

Accepted loss: JS/WGSL plugin effects, generator and custom layer kinds (G2);
webm muxer / GIF encoder (ffmpeg covers them). **Everything else is ported**:
macOS/Linux viewport, macOS system fonts, SVG layers, Pixel Motion, Write-on
brush, footage bake chain, interlacing/pulldown, rigid-body physics, image-layer
rigs / mesh density / weight paint / paint on text+footage, glTF + height
displacement + EXR sky, text gaps (variable axes, CJK breaking, Fit to Box,
paragraph breaks), audio gaps + audio-driven expressions, F1 preflight
fallbacks, all analysis jobs, AEP import, render-worker and CLI render
(`premation-engine --export`), hardware decode measurement.

## Flags removed at the end

`PREMATION_ENGINE`, `PREMATION_ENGINE_OWNER`, `PREMATION_EXPORT_ENGINE`,
`VITE_UNIFIED_HISTORY`, `LEGACY_DEBOUNCE_RECORDER`, the TS renderer backend
choice. The supervisor always starts; a missing engine or GPU is a fatal
startup dialog; a crash loop is a blocking "engine unavailable" state with a
recovery save. `engine()` is `ProcessEngineClient`; `EngineSurface` is the only viewport.

## Order (each commit builds)

**Phase 0 — blockers:** land d2w + f2-ownership work; build `macos-clang-engine`;
macOS IOSurface shared texture; Linux dmabuf or route-A copy; CI engine builds
on 3 OSes with a vcpkg cache; release builds/signs/stages the engine; command
log in main; CoreText/fontconfig/DirectWrite `listFonts`.

**Phase 1 — freeze data the C++ build takes from TS:** WGSL; catalog; vertical
orientation table; parity re-bless modes; migration pairs; golden scenes as documents.
*Done on `p1-freeze-data` (not yet verified on the test machine — see
`docs/VERIFY_ON_TEST_MACHINE.md`):* `native/engine/shaders/wgsl/` +
`materials.json` (`embed_wgsl.cmake`); `native/engine/catalog/*.json`
(`embed_catalog.cmake`) with `engine-api:gen` emitting `generated/catalog.ts`
and `native/protocol/generated/commands.json`; `raster/vertical_orientation.inc`
hand-owned; every parity fixture frozen with `PARITY_REBLESS=1`
(`tests/parity_rebless.hpp`); 45 migration pairs + `test_migrations.cpp`;
`packages/render-tests/scenes/*.json` + `scripts/native-golden.mjs`.

**Phase 2 — close gaps, flip defaults:** the C++ queries; the geometry push;
B4 mirror fields; engine jobs (one per kind, incl. analysis/ML); port every
"still reported" feature until the unported report is 0; pop-outs + multiple
viewports; AI LEGACY_GAPS; flip owner/viewport/export on, measure D5 + Render Queue.

**Phase 3 — cut the UI over:** `src/engine-client/`; one commit per read-ratchet
area (effects, timeline, text, layers, comps, AI/plugins/commands, inspector,
other, viewport/tools) to 0; document stores become mirror views; export /
mogrt / cloud / versions / templates via `exportDocument`/`restoreDocument`;
importers as command batches.

**Phase 4 progress (2026-09-28, branch `p4-remove-fallbacks`).** Done, each its
own commit (builds and passes):
- *Flags + engine selection.* `PREMATION_ENGINE`, `PREMATION_ENGINE_OWNER`,
  `<userData>/engine.json` `backend`/`owner`, `PREMATION_EXPORT_ENGINE` are
  gone (`VITE_UNIFIED_HISTORY` / `LEGACY_DEBOUNCE_RECORDER` were already gone
  from code). The supervisor always starts; its `fallback` state is now
  `unavailable` — fatal (no executable, no usable GPU, protocol mismatch,
  spawn failure → a startup dialog, then quit) or a crash loop (a blocking
  dialog: Save Recovery Copy of the last autosave / Try Again = `retry()`, main
  replays its command log / Quit — `electron/engineUnavailable.ts`).
  `ProcessEngineClient` has no `fallback` option: unavailable = requests answer
  `busy`, one notice, ready again after the retry's restart. `engine()` is the
  `OwnedEngineClient` over the process client wherever main answers
  `engine:status`; the LocalEngine stays only as the page replica (until the UI
  reads only the mirror) and as the harness where there is no engine host
  (jest; the headless CLI's hidden window).
- *Page fallbacks for engine jobs* outside the UI-migration areas: scene edit
  detection, object mask, beat markers / beat grid, auto-reframe command,
  auto-trace, the viewport proxy transcode, transcription (the page mixdown,
  `speechAudio.ts` and main's `ai:transcribe` whisper proxy deleted). A
  harness `unsupported` becomes a user-facing error (`requireEngineJob`).
  File ▸ Open After Effects Project is engine-only.
- *Export.* `electron/exportProcess.ts` launches only `premation-engine
  --export` (the hidden-window worker path and its IPC are gone); what the
  engine cannot render fails with its reason. `premation render` renders in the
  engine by default; only `--aspect/--captions/--commands/--data`, a png still
  and HDR still open the hidden editor window (`needsEditor`).
- *JS/WGSL plugin system (G2).* `src/core/plugins` (host, sandbox worker,
  manifests, effects, kernels, generators, custom layer kinds, native addon
  tier, storage, registry/marketplace/revocation), `src/layout/Plugins`
  (manager, marketplace, publisher portal, panels, consent, detail tabs), the
  plugin menu / tools flyout / draw overlay / inspector sections, the
  dashboard Plugins tab, `pluginStore`, Electron's `pluginLoader`, `pluginNet`,
  `pluginPublish`, `pluginNative*`, `packages/plugin-native-sdk`,
  `examples/plugins`, the plugin render-test scenes (15, with references),
  `docs/PLUGINS.md`, `PLUGIN_SYSTEM_REFERENCE.md`, `PLUGIN_SYSTEM_FOR_AI.md`.
  The native SDK (`native/sdk`, `docs/PLUGIN_SDK.md`) stays. A project that
  used JS plugins still opens: its JS-plugin effects and plugin-kind layers are
  dropped after open as ONE undoable entry with one notice
  (`src/core/project/removedPluginContent.ts`; native SDK effects, loaded or
  not, are kept). The legacy `plugins` / `pluginStorage` document blocks ride
  through a save unchanged.

Measured over the branch (1f904db4 → the plugin commits): about **51k
production lines, 40k test lines and 5k doc lines deleted** (+0.9k / +0.4k
added), 506 files. The native-side read ratchet was lowered with the page job
paths (371 → 367).

**Round 2 (2026-09-28, branch `p4-round2`).**
- *Job callers in `src/layout` / `src/core/workspace` are engine-only:*
  one-click tracking, the Track Motion panel (point / mask / smooth tracks,
  roto, content-aware fill, Apply / Mesh / Solve Camera / nulls), the Gate,
  Ducking and Silence Removal dialogs, Audio to Keyframes, the Media section's
  has-audio test, the Roto Brush tool (segment = `objectMatte` with the new
  `maskName/maskMode/feather/replaceMasks` fields; propagate = `rotoBrush`).
  The page trackers, the track-apply plans (`trackApplyEdits.ts`), the page
  silence / duck / gate envelopes and the analysis-proxy tier are deleted.
- *Exports are the engine's only.* ExportForm, Add to Queue, the Render Queue
  panel's Render All (`renderQueueStore` is now a pending list handed to main's
  queue), the data-row batch (`renderAndWait`) and the assistant's export all
  queue `premation-engine --export` via the export supervisor
  (`src/layout/Export/supervisorQueue.ts`). A still PNG is a one-frame
  unzipped sequence and WAV the engine's audio-only job (electron/engineExport.ts).
  The document formats (JSON, Lottie, EDL/OTIO/FCPXML/ALE, .mogrt) stay page
  code (`runDataExport`). The export preview and project thumbnails are the
  engine's `getThumbnail`. Deleted: `runExport`, `videoSink`, the WebM
  muxer, the GIF encoder, the raw pipe, `framePipeline`, the encode worker,
  `renderJob`, `hdrTransfer`, `exportPreview`, main's page render IPC
  (staging / streaming / resume: `ffmpegStream.ts`, `renderResume.ts`). The
  HDR10 / HLG presets are back on the engine (p4-round3): the export job's
  `hdr` option encodes PQ / HLG in BT.2020 from the half-float surface
  (`hdr_convert.hpp`, the viewer transform overridden to sRGB, light levels
  measured into `stats.hdr`); main tags and encodes it (`buildHdrEncodeArgs`:
  libx265 with the ST 2086 / CLL SEI, H.264 High 10 without libx265, or a
  ProRes HDR master for a mov with `hdr`). The SEI is written before the
  first frame, so it carries the mastering display's defaults (MaxCLL 1000,
  MaxFALL 400) or the spec's `hdrMastering`, not the measured levels.
- *CLI on the engine; no hidden window.* `premation-engine --prepare`
  (native/engine/src/cli_prepare.cpp) drives a Session in process:
  `premation comps` (listComps), `premation reframe --aspect` (the
  autoReframe job, applied, then a saved copy that `--export` renders) and
  `premation captions` (the transcribe job, credential from main's key vault;
  SRT/VTT written by main). `--scale` and the png still are export-job options.
  `#/render`, `RenderPage`, `headlessRender.ts` and the page reframe
  analysis (`saliency`, `reframePath`) are deleted.
  p4-round3: `--commands` (main encodes the recorded requests with the
  generated codec, `--prepare` replays them), `--data` (the `--prepare` fill
  step, one render per row) and `--captions` (the `setCaptions` command) run
  in the engine too. A `--data` Source Text fill keeps the layer's per-run
  styles the way the editor does (`keepRunsCommands`): `fill_row` reads
  `text/styleRuns` first and re-sends it after the Source Text write in the
  same batch (2026-10-01).
- *Render worker* renders only through `premation-engine --export`; its
  offscreen window, render page, preload and Vite bundle are deleted.

Moved to the engine in p4-round3: the page stills (the AI filmstrip / render
feedback use `getThumbnail`, version compare the new `renderDocumentStill`
query — `offlineRenderer.renderStillFrame` and `documentSwap.ts` are
deleted); the audio driver bake (the `audioAnalysis` job's `driver`; the
Audio Waveform config is read from the mirror); Assemble from Footage (the
`sceneDetect` job; the page scene-edit detector is deleted); Rig Logo for
Animation (the `rigLogo` job: one image / shape layer rigged in place,
anything else rendered alone — several layers together, `isolateLayers` —
cropped, imported with `importBytes` and rigged; the page rasterize is
deleted); HDR10 / HLG exports; CLI `--captions` / `--data` / `--commands`.

B4 round 8 moved the last page-only jobs into the engine: the particle /
physics bakes (`kind_dynamics_bake.cpp`), the IK3D bake (`bakeIk3D`) and live
merge (`createLiveMerge`); the engine computes its own environment SH
(`env_asset.hpp`; the page's `ensureEnvironmentSh` only fills the TS renderer's
cache). What still references the TypeScript renderer, effects and evaluation
(checked 2026-10-01, ~218k production lines over src/core and packages):

- *The page renderer* (`packages/renderer`, `src/core/rendering`, the
  `src/core/effects` runtime): the secondary view panes (`SecondaryViewPane`,
  `useViewportRenderer`), the Layer panel (`useLayerViewerRenderer`),
  presentation mode, the scopes' frame tap and snapshot compare (read from the
  page canvas), the preview cache UI (`frameCache` / `frameDiskCache`: cache
   bars, actions, stats) and onion skin. The helpers the UI keeps have moved
   out (`strokeTracks` and `gradientPaintTracks` in `src/core/paint`,
   `localBlobSource` in `src/core/assets/local`, `roiGeometry`
   and the onion-skin plan in `src/core/workspace`, `videoPlaybackDiag` in
   `src/core/media`, `engineStill`, `frameTap` and `mediaRepaint` in
   `src/core/engine`, `idleCacheSpan` in `src/core/timeline`, per-kind `SIZE`
   in `src/core/scene/layerKindSize.ts`, the viewport camera `RenderView` in
   `src/core/workspace/renderView.ts`, and paint blend modes in
   `src/core/paint/paintBlend.ts`,
   canvas GPU ownership in `src/core/workspace/canvasOwnership.ts`, and the
   playback blit policy in `src/core/perf/playbackBlitPolicy.ts`; `Color` in
   `src/core/paint/color.ts`). UI effect METADATA now comes from the
  engine catalog (`src/core/inspector/effectCatalog.ts`, 2026-10-01).
- *The page replica* (`LocalEngine`, `src/core/engine/handlers`,
  `legacyRefresh`, `sceneStore`'s graph and the evaluation under it): 98
  non-test files still read the replica's scene graph (28 in `core/scene`, 11
  in `core/template`, 9 in the UI dirs), the off-document layer builders
  (`offDocument.ts`) run against it, the pane hit tests go through it, and
  186 jest suites use it as their harness (23 already run the C++ binary,
  `__testHelpers__/nativeEngine.ts`).

**The order (each stage leaves tsc / lint / jest green):**
1. Small, independent: the CLI `--data` style runs (done), the JS-plugin
   leftovers (done), the UI effect metadata (done).
2. The page renderer goes. Engine features first: `setViewport.view` /
   `customView` (done 2026-10-01: each viewport renders its own Active / axis /
   camera / custom view — before this the engine rendered every viewport as
   Active Camera and the view selector only moved the page's chrome); the
   secondary panes (done: `EnginePaneSurface`, one engine viewport per pane,
   `engineFrameHub.ts` routing the window's frames) and the Layer panel
   (done: `setViewport.layer` is rendered — `BuildContext::layerView`, the
   one-layer walk; `time` / `layerSourceTime` hold the panel's ruler;
   `useLayerViewerRenderer` deleted) and presentation mode (done: an
   `EnginePaneSurface`, the still through `engineCompStill`;
   `useViewportRenderer` deleted — the wireframe painter lives on in
   `wireframeOverlay.ts`); scopes / compare tapping the engine's frame
   (done: EngineSurface publishes each drawn VideoFrame to `frameTap` and
   `compareStore.captureFrom` before `release` closes it; the region callback
   maps the comp rect the same way); a cache-state query for the cache bars
   (done: `getCacheCoverage` — the bars and the Preview readout follow the
   engine's VRAM frame cache; there is no disk tier); onion skin drawn by the
   engine (done: `setViewport.onion` — ghosts are built with a transparent
   background and composited over the live frame while playback is stopped).
   **Deleted 2026-10-02:** `packages/renderer`, `src/core/rendering`, the effect
   kernels under `src/core/effects` (canvas2dEffects and the ~60 files behind
   it), the page trackers, the worker decoder, the audio mixdown / spectrum /
   waveform generators, extrusion mesh / light shading / corner pin / cloner
   expansion, live SVG raster, the TS render-test harness (Electron +
   SwiftShader) and every test that covered them — everything unreachable from
   the app's entry points once the renderer went. `useWorkspace` paints only
   the chrome; the viewport HUD shows the engine's stats; the render-tier
   store, the page RAM / disk preview cache and its preferences are gone.
   What stays in `src/core/effects` is the effect document model the replica
   still reads (effects.ts, mask, layerStyles, blendMode, …) — step 3.
   Library / template / preset thumbnails are engine stills
   (`core/engine/previewDocument.ts`, `core/library/componentThumbs.ts`):
   gallery cards show a still and play a flipbook on hover or focus, instead of
   every visible card looping.

   Engine gaps this exposed (the page renderer did them; the engine does not
   yet — each is honest in the UI, none is faked):
   - *Cache Work Area Now* — **closed 2026-10-05**: `play { cacheFirst,
     cacheOnly }` stores the span frame by frame, then stops with the playhead
     back where it was (a seek or a pause ends the fill with what is stored).
   - `setCacheBudget` is accepted and does nothing (the budget is a share of
     the adapter's VRAM at engine start); there is no disk cache tier, so the
     disk budget, the disk bar and Purge Disk Cache are gone or hidden.
   - Focus Mode ghosting — **closed 2026-10-05**: `setViewportFocus` carries the
     working set (`layout/focus/useEngineFocus.ts`); the frame builder draws
     every other layer of that viewport at 12 % of its opacity.
   - The page's content canvas is blank under the engine viewport —
     **closed 2026-10-05**: the tracker loupe and the clone-source lens read a
     full-size copy of the engine's frame kept only while one of them is open
     (`core/engine/viewportPicture.ts`); the AI chat's result thumbnail is an
     engine still (`engineCompStill`).
   - Quality = Wireframe boxes are still painted from the replica's geometry
     (`wireframeOverlay.ts`), until step 3 moves them to the overlay push.
3. The page replica goes: the remaining `sceneStore` readers move to the
   mirror / the overlay push / engine queries (`hitTest` gains a `viewport`
   so a pane's picks project through its own view), the off-document builders
   run against the mirror or become commands, the 186 harness suites move to
   the C++ binary or go with the behaviour they tested. Then delete the
   evaluation, media, text, audio, paint, svg, scene and animation runtime —
   minus the document helpers the UI keeps (relocated).
   **Done 2026-10-03 — the app keeps no replica.** Every app reader moved
   (`scripts/lint/replicaReach.cjs`: 0 reached declarations, `await import()`
   followed); keyframe assistants run on a scratch `AnimationEngine` seeded
   from `getMemberKeyframes` and send `setMemberKeyframes`
   (`core/engine/memberEdits.ts`), comp ↔ keyframe-axis times come from
   `mapLayerTime keyframeAxis` (both ways) and the overlay push (`pathNow[3]`),
   paint continues with `updatePaintStroke append`. `engineInstance` creates no
   LocalEngine when the engine owns the document; `OwnedEngineClient` forwards
   nothing; `replicaRefresh` / `animEditBridge` are deleted. Undo / redo state,
   the History panel, per-node inspector revisions and the chrome repaint read
   the mirror.
   **Done 2026-10-04 — the TypeScript engine is gone.** `LocalEngine`, its
   handlers, the page scene graph / animation / timeline singletons and the
   runtime only they reached are deleted (≈95k lines; what the app reaches
   was decided by `scripts/lint/replicaReach.cjs`-style reachability from
   `main.tsx` and the script worker, import side effects included). `engine()`
   is the C++ engine or, with no engine bridge, an inert client that answers
   `busy`. Command-log record / replay runs on the engine's `getCommandLog`
   (`core/automation/commandLog.ts`). Every suite that tested app behaviour
   runs on `premation-engine-headless` (`*.native.test.*`, the CI engine job);
   the TS-engine behaviour and parity suites went with the engine.
4. Sweep: parity generators + the TS harness, `packages/render-tests`' TS side
   (the native golden gate stays), native-bridge + napi, the eslint layering
   and ratchet configs, `EditorTabs`, deps (mp4box, polygon-clipping;
   onnxruntime-web is referenced only by config; fflate stays — recovery,
   portable .motion and the Lottie library use it), CLAUDE.md and
   NATIVE_CORE_PLAN.md (both still call the TS engine a fallback).
   **Done 2026-10-04.** `packages/render-tests` is native-only (the golden
   gate and its inspection scripts, which bundle only the engine-api codec);
   native-bridge and napi were already gone. The block-3 reachability tool
   (`replicaReach.cjs`) is deleted with its sinks; the engine-writes ratchet
   reads 0 and the engine-reads ratchet is lowered to 2 (the path verbs'
   `createSceneGraphPort` reads in `core/workspace/pathCommands.ts`). The
   types-only `TimelineController.ts`, `IdMap` (TS↔C++ log translation) and
   the process client's foreign-batch hook (it refreshed the replica) are
   gone, as is EngineSurface's C3 `'beside'` picture-in-picture mode.
   `EditorTabs` holds no engine fallback. The deps stay — each has an app
   importer: mp4box (`core/video/mp4Demuxer.ts`), polygon-clipping (path ops /
   merge paths), onnxruntime-web (object matte, `scripts/fetchObjectMatte.cjs`
   and the CSP), fflate (recovery, portable .motion, Lottie library).
   CLAUDE.md and NATIVE_CORE_PLAN.md say one engine.

**Phase 4 — delete, in dependency order:** flags + fallbacks; JS plugin system;
renderer + effects; media/text/audio; evaluation; parity generators + TS harness
+ native-bridge + napi; config/docs sweep (CLAUDE.md layering, eslint layering
and ratchet configs, jest/tsconfig/vite aliases, package.json scripts and deps
— mp4box, polygon-clipping, fflate, onnxruntime-web — electron-builder engine
staging and signing, release/render-tests workflows).
