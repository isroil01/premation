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

Measured on `native-core` @ ff03f0f1: about **270k production lines and 175k
test lines** of TypeScript engine go. Rough size: 5–8 months for one small team.

## Blockers found before any deletion

1. **The engine viewport exists only on Windows.** `shared_texture_ffi.cpp` is
   D3D11/NT-handle, built `if(WIN32)`; `electron/engineHost.ts` drops non-shared
   frames. No IOSurface (macOS) or dmabuf (Linux) path; route-A copy not wired.
2. **The C++ build reads TypeScript sources:** WGSL (`native/engine/shaders/extract.mjs`
   from `packages/renderer/src/shaders`), the property catalog
   (`core/generated/catalog_data.inc` from ~25 TS registries via
   `crossEngineCatalog.test.ts`), `raster/vertical_orientation.inc`, and the
   golden gate's `.pfs` inputs from the TS WebGPU pass.
3. **Release/CI never build the engine** (`release.yml`; `scripts/stageEngine.cjs`
   ships an empty folder when it is missing).

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

- Queries answering `unsupported`: `getLayerBounds`, `getTextLayout` (B4);
  `listFonts` and `getJobs` empty. (`getWaveform`, `getThumbnail`, `hitTest`,
  `readPixels` answer from the C++ engine since d2w-round2.)
- Commands answering `unsupported`: `startJob` (trackMotion, stabilize,
  autoTrace, sceneDetect, objectMatte, transcribe, audioAnalysis, render,
  prerender), `convertLayer`, `separateLayer`, `autoTrace`, `collectFiles`,
  `.aep` `importProject`, portable-zip open.
- **Frame-synchronous overlay geometry push** (world matrices, bounds, motion
  paths, pins/bones, text boxes on `FrameReady`) — replaces ~75 per-frame reads.
- B4 exit fields (media type, proxy, playable URL, mographId, svg, essentialProps,
  multicam angle, freeze / stretch / roll limits, Lift, capturePreset,
  evaluateExpression{member}, rig-track sampler, per-member keys).
- AI `LEGACY_GAPS` + `scene.apply` abort-on-failure (92 sites).
- Pop-out windows as second mirrors; command log in main; multiple viewports;
  session `blob:` footage written to a cache file then `importFiles`.

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

**Phase 2 — close gaps, flip defaults:** the C++ queries; the geometry push;
B4 mirror fields; engine jobs (one per kind, incl. analysis/ML); port every
"still reported" feature until the unported report is 0; pop-outs + multiple
viewports; AI LEGACY_GAPS; flip owner/viewport/export on, measure D5 + Render Queue.

**Phase 3 — cut the UI over:** `src/engine-client/`; one commit per read-ratchet
area (effects, timeline, text, layers, comps, AI/plugins/commands, inspector,
other, viewport/tools) to 0; document stores become mirror views; export /
mogrt / cloud / versions / templates via `exportDocument`/`restoreDocument`;
importers as command batches.

**Phase 4 — delete, in dependency order:** flags + fallbacks; JS plugin system;
renderer + effects; media/text/audio; evaluation; parity generators + TS harness
+ native-bridge + napi; config/docs sweep (CLAUDE.md layering, eslint layering
and ratchet configs, jest/tsconfig/vite aliases, package.json scripts and deps
— mp4box, polygon-clipping, fflate, onnxruntime-web — electron-builder engine
staging and signing, release/render-tests workflows).
