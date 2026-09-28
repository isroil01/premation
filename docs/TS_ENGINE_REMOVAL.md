# Removing the TypeScript engine — one engine, C++

> **Owner decision, 2026-09-26.** Premation has ONE engine: the C++ process
> `premation-engine`. Every feature, logic and engine lives there — evaluation,
> rendering, effects, media, text, audio, export, and the analysis jobs
> (tracking, object matte / SAM, transcription, scene detect, auto-reframe,
> proxies, bakes). Electron + React are the UI only and talk to the engine only
> through `packages/engine-api` (`EngineClient`), reading through the mirror.
> This supersedes the "TypeScript fallback kept behind a flag" rule of
> `NATIVE_CORE_PLAN.md` §0 and `CLAUDE.md`; both are updated when phase 4 lands.
> Work lands on `native-core` only; it is never merged into `main` or `dev`.
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
  in the engine too. Gap: a `--data` Source Text fill does not keep the
  page's per-run styles (`keepRunsCommands`).
- *Render worker* renders only through `premation-engine --export`; its
  offscreen window, render page, preload and Vite bundle are deleted.

Still on the page (no engine job yet — **post-launch** C++ jobs): the audio
driver bake (`computeDriverEnvelope`), the Audio Waveform generator's read,
particle / physics bakes (`bakeDynamics`), the IK3D bake, environment SH
(`ensureEnvironmentSh`), Rig Logo for Animation, footage assembly, live
merge, and the page stills (`offlineRenderer.renderStillFrame`: AI filmstrip
/ render feedback, version compare). These keep the TypeScript renderer,
effects and evaluation referenced, so step 4 (deleting those packages) is
post-launch too. The `EditorTabs` strip is left for the UI cleanup.

**Phase 4 — delete, in dependency order:** flags + fallbacks; JS plugin system;
renderer + effects; media/text/audio; evaluation; parity generators + TS harness
+ native-bridge + napi; config/docs sweep (CLAUDE.md layering, eslint layering
and ratchet configs, jest/tsconfig/vite aliases, package.json scripts and deps
— mp4box, polygon-clipping, fflate, onnxruntime-web — electron-builder engine
staging and signing, release/render-tests workflows).
