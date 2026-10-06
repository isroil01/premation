# Verify on the test machine

Code on `native-core` since 2026-09-26 was written on an 8 GB M1 that cannot
build the full engine (Dawn/Skia/ffmpeg) or run the suites in parallel. Each
item below was written but not run. Check them on a machine that can build
every preset (the Windows RTX 4060 box, or a Mac with 16 GB+ and Docker off).

## What is still open (2026-10-05) — read this first

The sections below this one are the history of each branch. Many of their
unticked items name flags and a TypeScript engine that no longer exist
(`PREMATION_ENGINE`, `PREMATION_ENGINE_OWNER`, `PREMATION_EXPORT_ENGINE`, "both
engines", "compare with the TS renderer"): those items are closed by the
engine's own suites, which now run in CI. What a release still needs from a
real machine is this list.

Verified on the Windows RTX 4060 box, 2026-10-05: `windows-clang-cl-engine`
builds; ctest 15/15; every `*.native.test.*` suite on the full engine with
`--no-gpu` (173 suites); the native golden gate (335/345 gated, 420/420 ported
— the same numbers CI's WARP run gives, so the gate is blocking in CI);
`npm run bench:check`; tsc; lint.

**Real Mac (nothing has run on one):**
- [ ] The viewport over route C (`__premationEngineSurface.route === 'shared'`,
      IOSurface) and over route A with the host bridge removed; 50 resizes leak
      no IOSurfaces; a popped-out Viewport on both routes.
- [ ] VideoToolbox decode of H.264 / HEVC / ProRes footage (the CI runner's
      device refuses and falls back to software).
- [ ] Text in a system family (`sans-serif`, Helvetica, a variable font) renders
      with the right face (CoreText); `listFonts` lists the installed fonts.
- [ ] Image footage (PNG / JPEG / WebP / GIF / BMP) renders; a JPEG sequence
      export opens in Preview. TIFF stills are Windows-only.
- [ ] Transcribe (the engine's HTTP goes through the system libcurl).
- [ ] The signed path, once certificates exist: `codesign --verify` on
      `Contents/Resources/engine/premation-engine`, notarization of the nested
      binaries, auto-update (gated on the signature).

**Windows real app (the built installer, not the dev server):**
- [ ] Rename `premation-engine.exe` away → the "Premation cannot start" dialog,
      then quit. Kill the engine three times inside a minute → "Engine
      unavailable": Save Recovery Copy, Try Again (the document comes back),
      Quit.
- [ ] Kill the engine once mid-session → one replay, the document and both
      windows come back, no double replay; after a job applied (Scene Edit
      Detection, Track Motion Apply) the replay writes its result without
      re-running the job.
- [ ] Open a 0.8.x project with JavaScript plugin effects: it opens, one
      notice, Undo restores, Save drops them.
- [ ] Undo is one step after each kind of edit (the recorder is gone: an edit
      that wrote around the engine would have NO undo — none is known,
      `lint:engine-writes` reads 0).
- [ ] Export form and Render Queue: H.264, ProRes 16-bit, PNG / JPEG sequence,
      HDR10; a project the engine cannot render fails with its reason.
- [ ] Preview ▸ Cache Work Area Now fills the cache bar and leaves the playhead
      where it was; Space during the fill stops it. Focus Mode (enter a group,
      isolate a layer) dims the other layers in the viewport and not in an
      export. The tracker's loupe and the Clone Source Overlay show the
      viewport's pixels; the AI chat's result card shows the frame.
- [ ] The IK/FK Chain Mode switch, toggled twice quickly, keeps the limb still.

**CI, after the next push:**
- [ ] `engine` jobs green on all three OSes (the macOS decode test and the
      Windows audio-clock test were fixed 2026-10-05).
- [ ] The release dry run (`workflow_dispatch`) packages macOS (the
      "Verify the engine shipped" step used `globstar`, which macOS bash 3.2
      lacks).
- [ ] The Linux `*.native.test` step: it failed 12 suites because `--no-gpu`
      also switched the frame builder off (no text layout, no rig); the engine
      keeps it on now. When it is green, drop its `continue-on-error`.
- [ ] The bench ratchet on the runner: regenerate `bench/baseline.json` from a
      green run's `bench-results` artifact (it still lists 41 metrics of the
      deleted TypeScript engine), then drop its `continue-on-error`.
- [ ] `clang-format` is still advisory: the tree has never been formatted.

**Performance targets (NATIVE_CORE_PLAN §7)** have not been re-measured since
the TypeScript engine went: 100 layers with effects at 1080p, 4K ProRes scrub
latency, export fps against 0.8.5.

## AE parity step 1 (2026-10-06, docs/AE_PARITY_PLAN.md) — needs the GPU box

Written in a Linux cloud session with no GPU, no Dawn and no Skia: the
headless engine, its native tests, `tsc`, lint and the jest suites ran there;
the WGSL compiled with naga. Everything below did not run.

- [ ] Build `windows-clang-cl-engine`: `render_graph/threed.cpp` (the
      alpha-tested shadow / SSAO casters, `SHADOW_DEPTH_ALPHA_MATERIAL`),
      `scene/snapshot_build.cpp`, `scene/threed_port.cpp`,
      `scene/extrusion_mesh.cpp` and `jobs/kind_roto_brush.cpp` compiled only
      against stubs or not at all.
- [ ] Golden render tests (`packages/render-tests`, the native gate): the
      `discard` added to `solid3d` / `textured3d*` / `masked-textured3d*`, the
      new `shadow-depth-alpha` caster, the 3D corner-radius scale and the
      variable mask feather all change pixels. Expect diffs only in scenes with
      3D rounded rects, transparent 3D layers with shadows / SSAO, and
      per-vertex feathered masks; rebless those after looking at them.
- [ ] 3D corner radius: a 3D rounded rect pushed from z = 0 to z = −1500 and
      to z = +600 keeps the same radius relative to its size; an extruded one's
      walls meet the front face's rounded corners; a per-corner-radius
      extrusion under a spatial effect (the face-plane fallback) keeps its
      corners.
- [ ] Alpha in 3D: a PNG with transparent corners in front of another 3D layer
      no longer hides it in the corners; with a shadow-mapped light it casts
      its silhouette, not a rectangle; with SSAO on, no dark square around it.
- [ ] Variable mask feather: a mask with per-vertex feather draws a ramp that
      widens and narrows along the outline (it used to draw a hard edge and
      list "variable (per-vertex) mask feather" in layerErrors).
- [ ] Roto Brush on real footage: paint strokes, propagate 60 frames — the mask
      follows the outline with no zigzag spikes, the timeline shows ONE
      "Roto Brush" mask (the SAM outline is replaced, not duplicated), and a
      background stroke keeps its region out across the shot.
- [ ] Object Matte model: Settings ▸ Object Matte ▸ Install writes the pair to
      `<userData>/models/object-matte/`; the next Roto click uses it (rename
      the bundled `resources/models/object-matte` away to prove it); Remove
      falls back to the bundled pair with no restart.
- [ ] 3D gizmo on a layer parented to a rotated, scaled null: the gizmo sits on
      the layer, Local axes follow the parent and the layer's Orientation, and
      a drag moves the layer under the cursor along the chosen axis.
- [ ] A project with an effect from a plugin that is not installed opens with
      one "Missing plugin …" notice, renders the layer unaffected, keeps the
      effect after a save and reopen.

## AE parity step 2 (2026-10-06, docs/PLUGIN_STORE.md) — needs the GPU box and real platforms

Run in the same Linux session: the headless engine's plugin host tests
(`engine_plugins_tests`, arch keys / `--plugin-disabled` / `--revoked` /
rescan), `pluginStore.native.test.ts` on the headless engine, the SDK install
plus `examples/plugin-ci` built against it and loaded, pack → sign →
`installPackage` → `premation-plugins list`, and the motion-back unit tests
(branch `ae-parity-plugin-store`). Not run:

- [ ] Build `windows-clang-cl-engine`: `export/export_job.cpp` (the export
      job's own plugin host and `RenderGlue`) needs Dawn and was not compiled.
- [ ] Export a comp with a native plugin effect from the Render Queue and with
      `premation render`: the effect is in the frames; with the plugin disabled
      in Dashboard ▸ Plugins it passes through and the job names it.
- [ ] Store install on Windows while the engine has the plugin loaded: the new
      copy waits in `native-plugins/.pending/<id>`, the editor says it applies
      at restart, the next start swaps it in. Uninstall removes the folder at
      the next start.
- [ ] macOS: an installed plugin loads with no Gatekeeper prompt
      (`com.apple.quarantine` removed); a `macos-universal` binary loads on
      arm64 and x64.
- [ ] Install from the store with no restart: the effect appears in the
      Effects panel under Plugins, its buttons work (one undo entry each), a
      hidden / renamed param follows the plugin's `getEffectUi`.
- [ ] Revocation: add the installed id to the signed list on staging → at the
      next launch Dashboard ▸ Plugins shows it Revoked and its effects pass
      through.
- [ ] Server render of a project with a plugin effect is refused naming the
      plugin.
- [ ] motion-back on real Postgres + storage: migration
      `20261006150000_native_plugin_packages` applies; a 200 MB native package
      uploads (raw storage, 256 MB limit) and `packageUrl` downloads it within
      10 minutes; publishing public from an unverified publisher answers 403
      `publisher_not_verified`.
- [ ] `.github/workflows/release.yml`: the `premation-sdk-<platform>.zip`
      artifacts attach to the draft; `examples/plugin-ci` builds against them
      on all three runners.

## Status on the Windows RTX 4060 box (2026-09-28)

Built and run there after the `wip-stopped` merges: `windows-clang-cl-engine`
builds (two fixes: `_dupenv_s` in parity_rebless.hpp, the CJK wrap test on the
real JSON API); ctest 15/15; tsc 0; lint 0 errors (567 warnings); engine-writes
0; engine-reads 519; `engine-api:check` clean; the full jest suite re-run and
its 35 failing suites fixed (re-baselines onto the app engine / mirror, plus
real fixes: AI bezier/easing keys on separated Position, the uniform `scale`
shorthand, bare `effect.<id>` tracks, the assistant planner keying a
non-keyable combined Position). Parity fixtures re-blessed from C++ after
checking every diff (schema growth, autoTrace, 3D world matrices, 1-ulp M1
libm drift). Items below that this covers are ticked; real-app items stay open.

## Build first

- [x] `npm ci` on Node ≥ 22.12; `npm run engine-api:gen` leaves no diff.
- [x] `npx tsc --noEmit` (use `NODE_OPTIONS=--max-old-space-size=8192`).
- [x] `npm run lint`, `lint:engine-reads`, `lint:engine-writes` (`lint:automation-writes` is no longer an npm script; its ratchet is the jest test `automationWriteRatchet`).
- [ ] Native: `macos-clang`, `macos-clang-engine`, `windows-clang-cl-engine`, `linux-clang-engine`, the ASan/TSan presets, `native:tidy`, `native:wasm`.
- [ ] Apple clang: `engine_effects`, `engine_export`, `engine_scene` build without `-fexperimental-library` (d2w-round2 replaced `std::jthread` with `core/joining_thread.hpp`).

## Parity fixtures to generate, then run their C++ tests

Each new C++ parity test prints WARN and skips while its fixture is missing.

- Done on p1-freeze-data: the write-on, deform, Pixel Motion, extrusion-faces and alpha-mesh fixtures were generated once and committed as frozen data; the GEN_NATIVE_* branches are gone (see that section).
- [ ] Per-character 3D text has no fixture (glyph widths depend on fonts): check visually and against the golden 3D text scenes.

## Production readiness round (2026-10-04, after the TS engine's removal)

CI ran the engine's own suites for the first time since 2026-09-28 (the
engine had not compiled there). Fixed and pushed; what CI cannot show:

- [ ] Real Mac: image footage (PNG / JPEG / WebP / GIF / BMP) renders — stills
      now decode through Skia's codecs off Windows (`scene/image_decode_ffi.cpp`;
      vcpkg skia gains `png` / `jpeg` / `webp` on macOS and Linux). TIFF stays
      Windows-only. Re-save an image in Finder: the layer picks up the change.
- [ ] Real Mac / Linux: Export ▸ JPEG sequence writes frames (the engine's
      baseline encoder, 4:4:4; Windows keeps WIC) and they open in Preview / an
      image viewer.
- [ ] Real Mac: route C (`[shared]`): the GitHub runner's paravirtual Metal
      device refuses IOSurface BeginAccess, so the test skips there — this is
      the only place it runs. Same for VideoToolbox decode (the runner's device
      refuses H.264 and the engine falls back to software).
- [ ] Navigating into a retimed precomp / footage layer (Composition
      navigator, Tab ▸ open precomp at the playhead) lands on the source time —
      `mapLayerTime` maps footage through start / Speed / Time Remap now.
- [ ] `premation render --commands <log>` with a log recorded mid-session
      (`recordSession()` after a few viewport drags) replays with 0 refused.

## Branch by branch

### cleanup-dead-code, f2-motion-bundles (verified here)
- tsc 0 errors, related jest green, `bundleCrossEngine` 6/6 on the headless C++ engine.

### d2w-cpp-ports (syntax-checked only)
- [ ] Headless: `engine_scene_core_tests` and the new tests link and pass.
- [ ] Full engine: `threed_port`, `snapshot_build`, `effect_handoff`, `per_char3d`, `rig_coverage` link; render-tests native gate: write-on brush, glTF morph/skin models, extrusion slice-stack / geometric faces, image-layer rigs now render natively (fewer `unported` reasons).
- [ ] `getLayerTransforms` returns world 4×4 for 3D layers/cameras/lights in both engines.
- Not wired yet: Pixel Motion / deinterlace kernels (need the GPU media feed).

### f2-ownership (C++: bundle_io / engine_ctx / session / test_bundle_io pass `clang++ -fsyntax-only` with the engine's -Werror flags; TS linted; no jest, no tsc, nothing linked)
- [ ] `npx tsc --noEmit` — new async signatures (`buildMogrtPackage` / `exportMogrtZip`, `exportJSON`), `liveDocument`, `engineDocumentStores`, `replicaRefresh`, `EngineBridge.onEvents(bytes, meta)`, `Ports::Opened`.
- [ ] Headless C++: `engine_tests` `[bundle]` — sha256 vectors, portable pack → `read_portable` → Save As bundle collects the footage, refusals (junk zip, zip without a project).
- [ ] `PREMATION_ENGINE_PATH=<premation-engine-headless> npx jest bundleCrossEngine` — the new "Open portable copy" case on BOTH engines (C++: `motion-blob:<sha256>` src, untitled, not dirty; TS: `blob:` src).
- [ ] jest: `liveDocument`, `engineDocumentStores`, `exportMogrt`, `exportSupervisorClient`, `electron/engineCommandLog`, `electron/ipcRegistration` (new `export:capabilities` channel), `engineHost`, `engineTransport`, `process` (ProcessEngineClient), `undoParity`, `engineDocumentSession`, `windowSync`, `compositeEdit`/`precompose`, `swatchStore`, `materialStore`.
- [ ] Real app, `PREMATION_ENGINE=process PREMATION_ENGINE_OWNER=engine`:
  - File ▸ Open portable copy of a zip with footage: opens untitled through the engine; Save As bundle carries the footage; the zip is untouched.
  - Pop-out a panel: it shows the engine's document (not a seeded one); an edit in the pop-out appears in the editor window and vice versa (replica refresh on `foreign` batches); undo in either window.
  - Kill `premation-engine` mid-session: main replays its log once (toast shows the replayed count), both windows refetch, no double replay.
  - Swatches / materials / grid toggles: each edit is one History entry; undo restores the store; saving and reopening keeps them.
  - The title-bar dot and the discard prompt follow the engine (undo back to the saved revision clears it).
  - Cloud upload / Save Version / Export JSON / mogrt / publish template contain the engine's document.
- [ ] Real app, `PREMATION_EXPORT_ENGINE=1`: the Export form shows "Bits per channel" for mov (supervisor path), a 16-bit mov is `rgba64le` ProRes; with the flag off the control is absent.
- Not done: Versions ▸ Compare as an engine still, the engine-side native-plugin host for export, running the alpha golden scenes through the CLI (needs a GPU). (Motion blur / colour management commands, the assets store and comps as mirror views, Render Queue 16-bit, DEFLATE portable zips: done on `engine-jobs`, below.)

### b4-mirror-reads (C++: readmodel / handlers_layertime / catalog_data pass `clang++ -fsyntax-only` with the engine's -Werror flags; TS linted; no jest, no tsc, nothing linked)
- [ ] `npm run engine-api:gen` leaves no diff; `npx tsc --noEmit` — new required fields: `LayerInfo.{shapeType, managedBy, mographId}`, `ItemInfo.{mediaType, alphaProbed, audioProbed}`, `CompSettings.essentialProps`, `LayerTiming.{freeze?, bakedStretch?}`, the `liftRange` command / `TimeRangeEdit` result (any hand-built record in a fixture now needs them).
- [ ] `node scripts/lint/engineReadsReport.mjs --check` at or under the committed ratchet; `npx jest engineReadRatchet engine-api/src/generated.test` (doc names `liftRange`).
- [ ] `GEN_NATIVE_CATALOG=1 npx jest crossEngineCatalog` leaves no diff — `catalog_data.inc` was edited by hand to add the `liftRange` command row (same JSON, re-chunked). (Superseded by p1-freeze-data: the commands now come from the schema.)
- [ ] jest: `commands` (new `liftRange` row: undo parity), `timelineGaps` (rippleDeleteRange now shares `deleteRangePlan`), `mirrorEquivalence`, `layerOrdering` (the Scene tree is built from the mirror: `panelRows` awaits the engine), `ReplaceFontsDialog` (the missing-font check reads the mirror; the fixture now announces itself), `footageEdits` (pristine adoption reads `CompSettings.pristine` from the mirror), `compLayers`, the new `rollLimits` test, `layerKinds` (canBe3D / paintable now refuse any layer with a `generator`).
- [ ] Cross-engine corpus / D1 parity with the headless C++ engine: the new header fields match (`shapeType` from `shapeType`, `managedBy` = `__ownedByPlugin`, `mographId` = `__mographId`, `generator` for custom `pluginLayer:` layers, `freeze` = the held layer-axis time as flicks, `bakedStretch` = `fx.bakedStretch / 100`, `mediaType` / `alphaProbed` / `audioProbed` from the asset record, `essentialProps` from the comp root); `liftRange` returns the same `{layers, splits, deleted}` and undoes exactly in both engines.
- [ ] Real app: the Layers panel (tree, kinds, shape glyphs — star / heart / arrow keep their glyphs, plugin managed / inert marks, hidden rows dimmed, search by name / effect / expression / source, "reveal after reparent"); Character panel (range styling, kerning at the caret, Source Text keyed value at the playhead, Mask Path picker); Effects panel mask list at a moved / trimmed layer; Composition Settings (open, change nothing, Save → no history entry; change fps 29.97 / duration / background gradient / World keys); Lift / Extract Work Area toasts (counts); roll edit limits on trimmed footage; Time Stretch field / dialog on footage and on a baked shape; Freeze Frame state in the Compositing section and the clip menu; still-image pickers (sky, sprite, height map, plugin image param); Essential Properties promote / list / Pinned tab; the mograph fill-in section on a child layer; Replace Fonts / missing-font toast after opening a project.
- Not done (still direct reads, each marked `B4-gap`): text layout (`getTextLayout` — paragraph ⇄ point, box auto-size, the text box card), layer bounds (`readGeometry`), per-member key lists (keyframe assistants), layer-as-preset capture, keyframe / effect clipboards, the proxy record, the Cryptomatte set, the SVG document, the plugin schema version, thumbnails' object URLs, document-wide expression / effect-name search.

### b5-automation-writes (C++: handlers_groups / handlers_items / handlers_properties / handlers_layers / anim_json / anim pass `clang++ -fsyntax-only` with the engine's -Werror flags, handlers_groups also compiled with ninja; TS linted; no jest, no tsc, nothing linked)
- [ ] `npm run engine-api:gen` leaves no diff; `npx tsc --noEmit` — new optional fields `addEffect.id`, `setExpression.owner`, `ImportBytesFile.source`; `SceneFacade.create(kind, name, at, shape?)` (`LayerShapeSpec`); `AssistantPlan.unaddressed`; `regenerateProxyChildren` / `createCustomLayerFromMenu` are async; `StructuredPlan.commands` replaces `apply`; `uiParamValues` lost `writePluginParam` / `ensurePluginParamComponent`; `layout/Inspector/pluginParamEdits.ts` re-exports `src/core/plugins/pluginParamCommands.ts`; `props.ts` exports `shapePathValue`, `keyAxisSeconds`; `propRefs.ts` `memberWrites`.
- [ ] `npm run lint:automation-writes` at or under the committed ratchet (ai 1, plugins 1); `npx jest automationWriteRatchet engineWriteRatchet engine-api/src/generated.test`.
- [ ] Headless C++ `engine_tests` link and pass (`ExprState` gained `authored_by`: a document's `authoredBy` now round-trips through the C++ engine; `addEffect{id}`; `importBytes{source}`). Cross-engine corpus / D1 parity: a plugin-authored expression's `authoredBy` matches in both engines.
- [ ] jest, AI: `aiEngineTurn` (new B5 test: star polystar, text animator, mask, trim, repeater, path operator, drop shadow, caller-chosen effect id + its keyframe, group time remap, puppet rig all stay engine-only — `outcome.kind === 'engine'`; the snapshot test now uses `merge_paths`), `commandLog` (the legacy turn is `merge_paths`), `agent`, `toolHandlers*`, `recipes*`, `archetypes*`, `craftHandlers*`, `propWriteSurvival`, the Lottie suites (`lottieImportApply`, `lottieStroke`, `lottieTrimApply`, `lottieStrokeExport` import the context from `src/core/lottie/lottieDocumentContext.ts`).
- [ ] jest, plugins (moved onto `setupAppEngine` / `callAsync`, not run): `sceneBatch` (one gesture, abort reverts, `callAsyncWithin`), `proxySubtree`, `authoredWriteHook`, `bindByStableId`, `sceneProxyPermission`, `depthPluginEndToEnd`, `uninstalledDocumentRoundTrip`, `webgl2Tier`, `customLayerCreate` (custom layers now land INSIDE the active composition), `createCustomLayerFromMenu`, `assets`, `hostApiEngine`, `sceneAndEffectVerbs`, `structuredProps`, `pluginApiValidation`, `pluginHost`, `methodPermissionsFixture`, `exampleGradeLab`. **Not updated, expected to need it:** `structuredProps.test.ts` asserts the legacy storage of a plugin outline (`Geometry.points` on a primitive with no outline): the engine route is `setShapeOutline` there (stored as one `subpaths` run, shape type `path`; a one-vertex path is now refused), `layer/path.points` only on a layer that already has an outline — re-baseline the expectations. `paramSupervision.test.ts` builds a hand-made root (not a composition) and reads the params synchronously under fake timers — supervision writes are now an engine batch (`setProperty effects/<id>/<param>`), so the fixture needs a real composition (`setupAppEngine`) and an `await engineIdle()`.
- [ ] Behaviour to eyeball in the real app (AI panel + a plugin): a generated image / video / voice-over lands as an Import entry plus the layer, fitted as before; `import_svg` and an SVG asset from `create_media`; `set_trim_path { convertSvg: true }`; `create_layer shape: star|polygon|line|ellipse`; `update_composition fps: 29.97` (now 30000/1001); `apply_layer_style`; `text_animator` with `color`; a proxy plugin regenerating (ids of surviving children kept, one "update layers" entry); `scene.apply` of 1000 ops (one entry, undo removes all); plugin `params.set` on a point param; the Depth Image menu insert.
- Not done: `merge_paths` (still a gap, recorded wholesale); `detachSubtree` (the ownership mark cleared from the write hook inside a user's command); the legacy debounce recorder cannot be deleted yet (the AI snapshot commit and `runDocumentEdit` outside the automation clients).
### p0-platform (Phase 0 platform blockers)
Built and run here: `premation-host-bridge.node` (CMake target, linked, loaded in Node 22: `lookup` of a global IOSurface made by another process resolves; a size mismatch and a bad id are refused); the CoreText font catalogue (`font_catalog.cpp` + `font_catalog_ffi_mac.cpp`, linked in a scratch program: 526 faces, Helvetica / Times / system-ui resolve, `.ttc` indices found by name). `clang++ -fsyntax-only` with the engine's -Werror flags: `vram_ffi.cpp` (old version fails, new passes), `shared_texture_ffi_mac.cpp` (against a Dawn stub only), `engine_process.cpp` (headless), `pipe_ffi.cpp`, `session.cpp`, `queries.cpp`, `test_framing.cpp`, `test_session.cpp`, `test_font_catalog.cpp`. `tsc -p electron --noEmit` 0 errors; eslint clean on every changed TS/JS file. **Not compiled anywhere:** everything that needs Dawn/Skia/the Windows SDK — `gpu.cpp`, `render_thread.cpp`, `test_shared_texture_mac.cpp`, `fonts_ffi.cpp`, `font_catalog_ffi_win.cpp`; the fontconfig branch of `system_fonts_ffi.cpp`. No jest run.
- [ ] Build `macos-clang-engine`, `windows-clang-cl-engine`, `linux-clang-engine` (and `macos-clang-engine-x64` on Apple silicon). `engine_fuzz` is skipped with a STATUS line under Apple clang and still builds with clang-cl / upstream clang.
- [ ] `engine_gpu_tests "[shared]"` on a Mac: IOSurface slots written through BeginAccess/EndAccess (fences carried), first pixel `0xFF00FF00` read by id; the render thread announces a shared ring with 3 non-zero ids.
- [ ] `engine_tests "[pixels]"`, `"[session]"` (frame routes section); `engine_raster_tests "[fonts]"` on each OS (`[system]` checks Arial on Windows, Helvetica/Times/system-ui on macOS).
- [ ] jest: `electron/engineHost` (macOS IOSurface forwarding, route A pairing / ≤ 2 in page / page reset), `electron/sharedTextureHandles`, `electron/pixelChannel`, `electron/ipcRegistration` (new `engine:pixelsRelease`), `scripts/stageEngine`; `npx tsc --noEmit` (EngineSurface `copyRouteDpr`, `EngineFrameMeta.route`).
- [ ] Real app on a Mac, `PREMATION_ENGINE=process`: the viewport shows frames over route C (`__premationEngineSurface.route === 'shared'`, host log has no `shared_texture` warnings). If Chromium rejects the `'RGBA'` IOSurface as `pixelFormat: 'rgba'`, switch the slots to `'BGRA'`/`bgra` + BGRA8Unorm (see docs/VIEWPORT_ROUTE.md). Measure fps / frame latency as C1 did; resize the viewport (ring replaced — no leak of IOSurfaces in main over 50 resizes, Activity Monitor / `vmmap`).
- [ ] Real app with the bridge removed (or `PREMATION_HOST_BRIDGE_PATH=/nonexistent`) on the Mac, and on Linux: frames arrive over route A (`route === 'copy'`, viewport ≤ 1280×720 physical), playback does not stall when the page is hidden/reloaded, `engine:pixelsRelease` frees slots (engine `dropped` stays low).
- [ ] Windows real app: unchanged route C (`frames.sharedTexture` still negotiated when `frames.copy` is also offered).
- [ ] `listFonts` in the real app (dev tools `motionEditor.engine`, or the text panel once it reads the engine) returns the installed fonts with paths, weights, axes (variable fonts) and scripts — macOS, Windows, Linux (fontconfig). Engine text layers set to `sans-serif` / `serif` / a installed family render with the right face on macOS (CoreText resolution) — compare with the TS renderer.
- [ ] CI: the `engine` job of native.yml on all three OSes (first run fills the vcpkg binary cache — note its size vs the 10 GB repo limit; the second run should configure in minutes). Linux apt list may need additions for the vcpkg `engine` ports.
- [ ] Release dry run (`workflow_dispatch`): `engine` job builds win / mac arm64 / mac x64; `build` downloads them, `lipo -archs` checks pass, "Verify the engine shipped" finds the engine (and the bridge on macOS) inside every package; signed path: `codesign --verify` passes on `Contents/Resources/engine/premation-engine`, notarization accepts the nested binaries.
- [ ] `npm run pack` without an engine build fails with the stageEngine message; `PREMATION_PACKAGE_WITHOUT_ENGINE=1 npm run pack` packages with a warning.
- Not done: Linux dmabuf route C (needs GBM allocation in the engine and fd passing into main — docs/VIEWPORT_ROUTE.md); mach-port IOSurface transfer instead of global ids; fontconfig axis ranges; Metal/Vulkan VRAM budget query; Linux packaging target (still deliberately unsupported in electron-builder.yml / release.yml).
### p1-freeze-data (Phase 1: the C++ build reads no TypeScript; syntax-checked only)
Nothing below was compiled into a binary or run here: the Mac could only run `clang++ -fsyntax-only` on the test sources, and the embed scripts in `cmake -P` mode.
- [ ] Configure every preset: `shaders/embed_wgsl.cmake` and `catalog/embed_catalog.cmake` run at configure time (a few seconds of CMake) and write `build/<preset>/engine/generated/{shaders,catalog}/*`. Check the generated `builtin_shaders.inc`, `materials.inc` and `renderer_wgsl.hpp` against a native-core build's committed copies: identical below the header comment (verified here with `cmake -P`, not in a real configure). Check `catalog_data.inc` parses (the engine aborts at start-up if not).
- [ ] Windows checkout with `core.autocrlf=true`: the WGSL is embedded without CR (`shaders/.gitattributes` marks it `-text`; the script also strips CR).
- [ ] Full engine builds and links: `engine_render_graph`, `premation-render`, `premation-scene`, the viewport proto (they now include the generated shader headers from the build dir).
- [ ] `npm run engine-api:gen` leaves no diff; it now also writes `native/protocol/generated/commands.json` and `packages/engine-api/src/generated/catalog.ts`. `packages/engine-api` typecheck with the new exports (the file alone passed `tsc --strict` here). The catalog's `commands` part now comes from the schema: `setGuides` / `setSwatches` / `setMaterials` gain a command kind the stale `catalog_data.inc` lacked (they were refused inside a batch as "unknown command").
- [ ] Every C++ parity test passes against its frozen fixture: `engine_scene_core_tests`, `engine_scene_tests`, `engine_effects_tests`, `engine_raster_tests`, `engine_audio_tests`, `engine_d1_parity_tests`, `engine_undo_parity_tests`, `engine_tests` "[parity]".
- [ ] Re-bless round-trip: `PARITY_REBLESS=1 <each test binary> "[parity]"`, then `git status native/engine/tests/data` — a passing test must leave its fixture byte-identical. Expected exceptions: `audio_parity.bin` mixes (Chromium answers were only within tolerance, so the first re-bless rewrites them); time/comp numbers that passed within tolerance; `polygon_clipping` error strings if a case is refused.
- [ ] New `test_migrations.cpp` (in `engine_tests`): 45 frozen pairs under `tests/data/migrations/` (TS migration tests' inputs through the TS chain). Never run against `migrate_document`; a mismatch is either a C++ migration bug or a TS/C++ key-order difference — fix the C++ or re-bless with a reviewed diff.
- [ ] Golden gate: `npm run native-golden -w @motion/render-tests` (or `node packages/render-tests/scripts/native-golden.mjs`) with the engine preset's `premation-scene`. Expect `not-ported` frames and mismatches on the first run; then `--update-baseline` writes `native-golden-baseline.json` (the debt list) for review. The `alpha-*` scenes' textures were PNG-encoded by Skia, not Chromium (same pixels intended).
- [ ] TS side (still present until phase 4): the `*CrossEngine.test.ts`, `d1EvalParity`, `undoParity`, `crossEngineCatalog` now only check the TS engine against the frozen data; they pass on a tree where no fixture was re-blessed.
### d2w-round2 (syntax-checked only)
- [ ] Builds: `engine_scene_core` now links zlib (`zlib_inflate_ffi.cpp`); `engine_frames` links `engine_export_core` (PNG thumbnails). Windows (clang-cl) and Linux presets too.
- [ ] Tests link and pass: `engine_tests` (`test_engine_queries.cpp`), `engine_scene_core_tests` (`test_frame_hit`, `test_exr_read`, the CJK case in `test_raster_text_core` after the fixture), `engine_scene_tests` (`test_rig_coverage`, the footage case in `test_bake_chain`, the soft-break case in `test_text_port_parity`), `engine_media_tests` / GPU (`test_media_gpu`: `#u`/`#l` hashes, the deinterlace pass, `convert_frame`), `engine_effects` (ThreadPool shutdown under TSan).
- [ ] Queries in the real app (engine owner on): `getWaveform` on an audio layer and a footage item (busy while conforming, then peaks); `getThumbnail` of a comp, a layer (alone), a still and a video item (PNG, ≤ maxSize); `hitTest` clicks select the layer under the pointer (rotated, corner-pinned, collapsed precomp → the precomp layer, locked skipped); `readPixels` in the Info panel / eyedropper matches the viewport colour (working space, straight alpha).
- [ ] Render-tests native gate: fewer `unported` reasons — CJK paragraphs, Fit Text to Box, Pixel Motion, interlaced / pulldown footage, EXR skies (needs an .exr on disk), SVG / relative-path image rigs, footage with Canvas2D-only styles. Compare visually against the TS where there is no fixture (Fit Text to Box, Pixel Motion's CPU warp vs the TS GPU warp, footage bakes).
- [ ] Viewport: a project opened from disk resolves relative footage / image paths (the texture feed now gets `mediaBase` in the viewport, not only in export).
- [ ] Perf: Pixel Motion playback (two readbacks + CPU warp per new weight) and footage bakes (baked on the render thread, one frame at a time) — note the HUD cost; a GPU warp / pooled bake is follow-up.


### engine-jobs (C++: every new / changed .cpp passes `clang++ -fsyntax-only` with the engine's -Werror flags — ffmpeg files against Homebrew's headers, `sam_ort_ffi.cpp` only in its no-runtime branch (no ORT headers here); TS linted; nothing built, linked or run)
- [ ] `npm run engine-api:gen` leaves no diff; `npx tsc --noEmit` (new: `engineJobs.ts`, `engineItemsView.ts`, the job specs' fields, `JobInfo.result/applied`, `MotionBlurPatch` / `ColorManagementSettings`).
- [ ] CMake: `engine_core` now links ZLIB and Threads (`core/deflate_ffi.cpp`, the job runner) — configure every preset incl. the ASan/TSan ones and the fuzzer (`engine_fuzz` links ZLIB::ZLIB under the static CRT on Windows: check LNK4098); `engine_jobs_core`, `engine_jobs` (needs ffmpeg + `engine_audio`), `engine_jobs_tests`; `premation-engine` defines `PREMATION_HAVE_JOBS`.
- [ ] vcpkg `engine` feature now includes `onnxruntime`: `find_package(onnxruntime CONFIG)` must find it and define `PREMATION_HAVE_ONNXRUNTIME` (a missing header is then an `#error`); compile `jobs/sam_ort_ffi.cpp` against the real API (Ort::Env / SessionOptions / Session(path) / MemoryInfo::CreateCpu / Value::CreateTensor / Run; tensors `pixel_values` → `image_embeddings`, `image_positional_embeddings`; `input_points`, `input_labels` → `iou_scores`, `pred_masks`).
- [ ] Unit tests: `engine_tests` `[f2]` (motion blur / colour management undo, clamps), `[bundle]` (DEFLATE portable, inflate bounds), `[jobs]` (runner + Session with a fake kind: one entry, apply=false + applyJobResult, cancel, failing apply changes nothing, new project drops jobs); `engine_jobs_tests` (`[jobs][audio]`, `[jobs][scene]`, `[jobs][render]` encode args equal to the TS lists, `[jobs][trace]`, `[jobs][sam]`, tracking — the tolerances are estimates: 0.2 px/frame sub-pixel track, 0.35 px per stabilize pair, 0.6 px stabilized).
- [ ] jest: `engineDocumentStores` (motion blur / colour management binding), `engineItemsView`, `commands.test` (setMotionBlur / setColorManagement cases), `electron/engineHost` (spawn env now carries PREMATION_FFMPEG / PREMATION_SAM_DIR).
- [ ] Parity against the TS on the same file (the ports keep float32 storage / double arithmetic / V8 math, so numbers should match; decode differs: the page decodes audio at the AudioContext rate, the engine at the file's): silence ranges, the amplitude track, the beat grid, duck / gate keys, scene cuts, a tracked point, auto-trace rings — run each once through both paths and diff the summaries / keys.
- [ ] Real app, `PREMATION_ENGINE=process PREMATION_ENGINE_OWNER=engine`, each ONE undo entry that undo removes:
  - Composition Settings ▸ motion blur switch / shutter and colour management (working space, display transform, bit depth): the store follows the engine, an edit is one History entry.
  - Import footage, rename / label / move to folder in the Project panel: the Assets panel follows the engine (thumbnails kept); a second window's import appears.
  - File ▸ Open portable copy of a zip repacked by another tool (DEFLATE entries).
  - Render Queue ▸ Add Comp ▸ ProRes MOV with `PREMATION_EXPORT_ENGINE=1`: "Bits per Channel" appears; 16 gives an rgba64le ProRes.
  - Jobs: Convert Audio to Keyframes; Markers on Beats; Animate In on Beats; Remove Silence (readout, then Apply on a take with a detached sound layer); Duck / Gate dialogs (preview numbers, Apply); Scene Edit Detection (markers and split); Create Proxy (file under `Proxies/` beside the project, attached; does the viewport play a path as the proxy src?); Track Motion (follow / transform / corner, then Apply), smooth stabilize (similarity); SAM segment with the model under `<resources>/models/object-matte` (electron-builder now copies it out of app.asar); Layer ▸ Auto-trace (frame and range). Each shows progress, Cancel stops it with nothing applied, a job on a deleted layer fails cleanly.
  - Kill the `--job` child mid-segment: the job fails, the engine keeps running. Render queue render / prerender through the engine job (a child `--export` per item; an unported comp fails with the preflight reason).
- Known limits: a job's applied result is not in main's command log (not a request), so an engine-crash replay does not reproduce it; jobs read footage, not a solo render of the layer; retimed layers are refused; transcribe stays in the page (provider key in main — decision needed); auto-reframe, mask / planar tracks, roto brush, content-aware fill, camera solve are page-only.

### render-completeness (2026-09-28 — built and run on the Windows RTX 4060 box; numbers in NATIVE_CORE_PLAN D4 / D5 / E3 / E4 / F1)
- [x] E4 bench with `--gpu-effects` (393 cases incl. `--active`): all under 41.7 ms, 0 CPU-baked — the e4-gpu-effects bench item below is verified.
- [x] Native golden gate green: 423/436 ported (only G2 plugin frames left), 338/348 gated match. `ctest --preset windows-clang-cl-engine` 15/15.
- [x] Real app (built Electron, CDP): D5 HUD table, D4 cache-first playback 29.7 fps, Render Queue mp4 + 16-bit ProRes through the engine, and the flipped defaults with no flags (engine owner + viewport + export).
- [ ] macOS / Linux: the defaults flipped for every OS; re-run `scripts/realapp/defaultFlags.cjs`-style checks there (route A / IOSurface) before a release — a platform where the engine cannot start falls back to the TS path, but a slow route would now be the default.
- [ ] Opt-out paths still work: `PREMATION_ENGINE=ts`, `PREMATION_ENGINE_OWNER=ui`, `PREMATION_EXPORT_ENGINE=0` (unit-tested in `electron/engineHost.test.ts` / `exportProcess.test.ts`; not driven in the real app).

### e4-gpu-effects (C++: every new / changed .cpp passes `clang++ -fsyntax-only` with the engine's -Werror flags; the render-graph files only against a STUB `webgpu_cpp.h` (no Dawn here) — nothing built, linked or run; the WGSL was never compiled)
- [ ] Builds: `engine_render_graph` gains `fx_distance.cpp`; `engine_contours` gains `contour_texture.cpp`; `materials.json` gains 8 materials / shaders (`sdf-seed`, `sdf-flood`, `sdf-resolve`, `sdf-dilate`, `stroke-sdf`, `style-fill`, `fx-effect-scope`, `vegas-gpu`) — configure re-embeds them. Dawn must accept every new WGSL (Tint errors surface as `FrameStats.gpuError` on the first frame that uses one): `vegas-gpu` reads a texture in the VERTEX stage (binding 3 is vertex|fragment) and uses `@interpolate(flat)`; the SDF passes `textureLoad` rgba16float.
- [ ] Tests: `engine_scene_tests "[e4]"` (route decisions, chain entries, contour texture), `engine_gpu_tests "E4:*"` (field stroke + field reuse, fill opacity 0 with a full-strength stroke). The existing `engine_gpu_tests`, `engine_scene_tests`, `engine_effects_tests` stay green (the CPU chain and the TS-parity extraction are unchanged: `extract_spatial_effects` only moved its per-effect body into `effect_entries`).
- [ ] Parity gate unchanged: `premation-scene --batch` WITHOUT `--gpu-effects` must give the same report and PNGs as native-core (the route and the field passes are off there). Then run it WITH `--gpu-effects` and review the diff of the baked scenes (fill-opacity-*, interior-*, stroke-*, effect-opacity / scoped-mask scenes, vegas): GPU vs Skia CPU — expect small edge / blur-kernel differences, no missing or doubled styles. Known semantic choices to eyeball: drop shadow / glow under fill opacity read the FADED contents (as the CPU chain's CSS filter does); the field stroke is a true disc dilation (the CPU stroke stamps 32 offset copies).
- [ ] Bench, the E4 exit (RTX 4060 or the test machine's GPU):
  ```
  premation-scene --gen-effect-bench /tmp/fxbench
  premation-scene --bench /tmp/fxbench --fonts <fonts.json> --frames 30                 # CPU bake (before)
  premation-scene --bench /tmp/fxbench --fonts <fonts.json> --frames 30 --gpu-effects   # GPU route (after)
  ```
  Budget: **every case `totalP50Ms` ≤ 41.7 ms (24 fps) with `--gpu-effects`**, in particular deep-glow (was ≈ 1.05 s), inner-shadow (1027 ms), stroke (814), inner-glow (478), vegas (279), drop-shadow, glow, bevel, satin, gaussian-blur / fast-box-blur at radius 60 (96–109), directional / radial / camera-lens blur. Check per case: `bakeMs` ≈ 0 and `gpuEffectsPerFrame` ≥ 1 for every routed effect; stroke / spread cases show `sdfBuilt` once then `sdfReused` every frame (the content does not change; only fill opacity animates); vegas makes its contours once (`rasterMissesPerFrame` → 0 after warm-up). Cases that still bake (canvas-only effects other than Vegas: numbers, timecode, audio-*, lightning, plexus, path-stroke, scribble; LUT / colour-matrix effects under fill opacity) are expected over budget where they were before — list them.
- [ ] Real app (engine owner on): a shape with Fill Opacity 30 % + Stroke / Inner Shadow / Bevel plays at full rate; scrubbing Stroke Size is smooth (field reuse); an effect with Compositing ▸ Opacity 50 % and a scoped mask looks as with `PREMATION_CPU_BAKE=1`; Vegas on a shape animates Rotation without a CPU spike; exports match the viewport.
- Known limits: Vegas' mask / path modes, Vegas after another effect or under a layer mask, and a LUT / colour grade interleaved in a baked stack keep the CPU bake. The field cache holds 4 fields (16 MB each at 1080p) and keys a moving layer per frame (rebuilt, ~10 cheap passes). Lower-precision CPU twins were not written: the GPU route replaces them wherever a device exists.

### b4-round2 (C++ passes `clang++ -fsyntax-only` with the engine's -Werror flags; TS linted; no jest, no tsc, nothing linked)
- [ ] `npm run engine-api:gen` leaves no diff; `npx tsc --noEmit`; `node scripts/lint/engineReadsReport.mjs --check` at or under the committed ratchet.
- [ ] capturePreset (query 1888): jest `queries` (the new capturePreset case: units, rebase, fx renumbering, empty, notFound; `QUERIES` count); C++ `engine_tests "[b4r2]"` (`tests/test_b4_round2.cpp`, new in `engine_tests`; `core/presets_capture.cpp` new in ENGINE_DOC_SOURCES). Real app: Motion Presets ▸ Save on a keyed layer (and on one with only an effect) lands in User Presets and applies back identically on another layer / comp size; "Nothing to save" on a bare layer.
- [ ] getTextLayout / getLayerBounds: jest `queries` (both answered now: getTextLayout where the jest canvas has metrics — `hasCanvas` — else `unsupported`; the new getLayerBounds case), `paragraphTextCommands` (no visual jump over the engine's `getTextLayout`; the enabled test awaits the mirror; the text-on-path case now asserts only the refusal), `textDirectionCommands`, `inspectorViaEngine` (align is async). C++ `engine_tests "[b4r2]"` (bounds on a keyed shape; text `unsupported` headless). Full engine: `scene/text_query.cpp` is new in the scene sources, `core/layer_geometry.cpp` in ENGINE_DOC_SOURCES; `engine_frames.cpp` (EngineFrameBuilder is now also the `TextQueries`) was NOT syntax-checked (needs Dawn / media headers). Cross-engine: `getTextLayout` / `getLayerBounds` on the corpus's point / paragraph / anchored auto-height text and on groups — equal within 1 px.
- [ ] Real app: Character ▸ Text Box — Point ⇄ Paragraph on rotated / scaled / right-aligned / RTL text holds the lines still; Auto Height ⇄ Off ⇄ Fit; the box H field on auto height and the Overflow mark; Align / Distribute on rotated layers, groups and parented layers (now by the drawn box); stroke gradient Start / End defaults on text and shapes; SAM segment mask on a text layer; Auto-Rig sizes to a text layer.
- [ ] copyKeyframes / copyEffects (1889 / 1890): jest `queries` (both cases; `QUERIES` count 38), `keyframeClipboard` (rewritten over the engine: tangents / spatial mode / continuity round-trip, Copy Keyframe at the playhead), `keyframeEdits` (copy awaits), `effectsViaEngine` (copy through `copyEffectsEdit`; the "still as copied" test now compares engine captures), `effectClipboard` (legacy module functions kept). C++ `engine_tests "[b4r2][clipboard]"`. Real app: Ctrl+C / Ctrl+V of keys (Position with bent paths, a Scale X diamond copies the whole Scale key, text Source Text keys, mask Path keys) onto another layer; the property row's Copy Keyframe; the key menu's Copy; Effects ▸ Copy / Copy Stack / Paste (live source → one `copyPropertyGroups` entry; edited or deleted source → the snapshot); Save Preset.
- [ ] LayerInfo.svg / getSvgDocument / getCryptomatte (1891 / 1892): `npx tsc` (new required `LayerInfo.svg` — hand-built LayerInfo fixtures need it; `compLayers.test` updated); jest `queries` (count 40), `svgLayer*` / `svgConvert*` suites, `CompositingSection` if any. C++ `engine_tests "[b4r2][svg]"`; cross-engine: `svg` role equal on an imported SVG, a converted group, a reverted one. Real app: SVG layer Inspector (file, size, paths, playback), Convert to Editable Shapes (confirm text), the canvas / tree context menus (Convert on an SVG layer, Revert on a converted group), the group section's Revert row; an EXR with Cryptomatte: Track Matte ▸ ID matte entries appear once it decoded (even when the layer was selected first).
- [ ] getMemberKeyframes (1893): jest `queries` (count 41), `assistantPreview` (the preview takes the engine's member lists), Smoother / Wiggler dialog suites, `MotionEditorPanel`. C++ `engine_tests "[b4r2][members]"`. Real app: The Smoother / The Wiggler menu enablement right after keying (the predicate reads the cached lists — fetched on first ask), their live preview + Cancel restores exactly + OK is one entry; the Motion editor's property picker lists `y` alone when only Y is keyed.
- [ ] Overlay geometry push (setOverlayGeometry 1771, FrameGeometry): `native/protocol/generated/commands.json` lists the `setOverlayGeometry` control (1771, from the schema). jest `controls` (32 non-edit commands), the new `overlayGeometry` test, `engineHost` / `engineFraming` suites (the new `geometry` frame message; `FrameForwarder` attaches it to the frame meta), `EngineSurface` if any. C++ `engine_tests "[b4r2][overlay]"` (frames preceded by their geometry; the packer under 4096 bytes); `render/render_thread.cpp` (the FrameGeometry send) was NOT syntax-checked — no Dawn headers here. Real app: the motion path (curve, tangent handles, frame dots, key dots, the playhead marker) and its drag / hover on 2D, parented and 3D layers — with the page renderer, and with `PREMATION_ENGINE_OWNER=engine` + the engine viewport (the path follows the engine's frame during playback).
- [ ] App shell (Providers / App): jest suites for U / Shift+U reveal (now asks `getMemberKeyframes`; Shift+U reads the list warmed on selection), Time-Reverse / Easy Ease All enablement (member lists, last known), Auto-Rig preset commands (`fetchLayerBox`). Real app: select a keyed layer → U reveals its keyed rows (and a generator's `force` reveal after it writes keys), Shift+U adds them; the palette's Time-Reverse / Easy Ease All are enabled on a keyed layer right after keying.
### b5-round2 (C++ syntax-checked only; TS linted; no jest, no tsc, nothing built)
- [ ] `layer/booleanOperand` (new fields.json row, after `layer/precompose`): `crossEngineCatalog` passes (TS registry == engine JSON); the C++ engine builds its catalog with it (`embed_catalog.cmake`). Property-tree parity fixtures that list a shape layer's properties gain the row — re-bless with a reviewed diff (`PARITY_REBLESS=1`, d1 / undo parity) if they fail on exactly that.
- [ ] Live Merge Paths (Workspace / Scene menu ▸ Merge Paths ▸ Live Union…, palette "Path Operation: …", AI `merge_paths`): one undo entry; the result is selected and re-evaluates when an operand moves; the operands are hidden and flagged; undo restores them visible and unflagged. Same in the C++ engine owner mode. jest: `mergePaths.test.ts`, `aiEngineTurn.test.ts` (new merge_paths case; the snapshot case now uses a named gap), `commandLog.test.ts` (writes-around case now uses a direct scene-graph write).
- [ ] Proxy ownership rule (C++ `session.cpp` `detach_proxy_ownership`, TS `proxyOwnership.ts`): in both engine modes, a Depth-Image-style proxy layer's generated child renamed / moved by the user → every child loses the managed badge in the Layers tree (`LayerInfo.managedBy` ''), one undo entry, undo brings the badge back; the plugin's next regeneration is refused ('detached'); a plugin's own `setProxyChildren` never detaches. jest: `proxySubtree.test.ts`, `authoredWriteHook.test.ts` (re-baselined onto engine commands). C++: `engine_tests` `test_proxy_ownership.cpp` (new, syntax-checked only; its fragment edit inserts the mark after the Transform component's `"props":{` — adjust if copyLayers serializes components differently).
- [ ] Moved to engine commands (one undo entry each, both engine modes): Layer ▸ Transform ▸ Flip Horizontal / Vertical on a static and on a scale-keyed layer (every key flips; a layer keyed only on the uniform `scale` shorthand is refused with a toast); Numpad +/- rotate, Alt+Numpad scale (each press one entry — the 700 ms burst coalescing is gone); palette Reset Transform; Inspector / context menu "Revert to Original SVG" (the SVG layer comes back at the group's slot, nested groups too); Physics ▸ Bake and Particles ▸ Bake (dialog and palette). Layers panel: clicking a composition root row's eye/lock/solo shows a note and changes nothing. jest: `layerTransformEdits.test.ts` (new), `layerTransformOps.test.ts`, `layerFlags.test.ts`, `layerSettings.test.ts`, `svgHybridImport.test.ts`, `layerSwitchEdits.test.ts`, `deleteLayerFromTimeline.test.ts`, `splitLayerIndependence.test.ts` re-baselined; `renameLayer.test.ts` / `toggleSelectionFlag.test.ts` deleted with their legacy functions (the engine's rename repair is covered by `b3zLastWrites.test.ts`).
- [ ] Recorder deleted: full `npx tsc` (nothing imports `useHistoryStore`, `attachHistoryRecording`, `batchHistory`, `runDocumentEdit`, `setUnifiedHistory` any more — grep found none, tsc not run here). jest re-baselined: `snapshotSharing.test.ts` (entries pushed by a local snapshot helper instead of the store), `snapshotCommand.test.ts` (new — the clip-restore cases moved from `historyStore.test.ts`), `historyStore.test.ts` (the route only), `unifiedHistoryBars.test.ts`, `multiSelection.test.ts`, `sectionPresets.test.ts`, `inspectorHistoryGranularity.test.tsx` (the "recorder is live" control is now "an uncommanded write records nothing"), `modifierStack.test.ts`, `mirrorEquivalence.test.ts`, `ownerMode.test.ts`, the three engine test helpers; deleted: `historyBaseline*`, `historyGranularity`, `unifiedHistory.test.ts`, the history bench (and its `history/record-2000-with-clips` rows in bench/baseline.json). In the app: Ctrl+Z after every kind of edit is one step; opening a project / recovering / New Project leaves nothing to undo behind the load; Versions ▸ Compare and pop-out sync leave no entry.
- [ ] Regressions to look for now that the recorder is gone: any edit that still writes around the engine (the B3 `lint:engine-writes` ratchet's remaining sites) has NO undo. Walk the areas that ratchet still counts and note which user-visible edits lost undo.
- [ ] Plugin tests re-baselined onto the app engine: `structuredProps.test.ts` (layers from `createLayer`, successful writes awaited — each is an engine command now; refusals still throw synchronously before anything is sent) and `paramSupervision.test.ts` (the layer is a composition layer, real timers, the answer applied by an engine batch, undo through the engine, a layer deleted mid-answer adds no entry). The fixture's plugin effect instance is written directly (`writeNodeEffects`, the engine resyncs) — if the TS engine's resync drops the plugin effect, add it with `addEffect` instead.

### platform-plumbing (2026-09-28 — built and run on the Windows RTX 4060 box where marked)
- [x] Windows: `windows-clang-cl-engine` builds; `ctest --preset windows-clang-cl-engine` 15/15 (new `[session][frames][viewports]`, `[collect][import]`). tsc 0; lint 0 errors / 567 warnings; engine-writes 0.
- [x] Real app (built Electron, CDP): route A forced with `PREMATION_VIEWPORT_ROUTE=copy` plays bench.json at 29.9 fps (route C 30.0); a popped-out Viewport window is a second engine surface (viewport 513) at ~30 fps beside the editor's, on both routes.
- [x] `node packages/render-tests/scripts/native-golden.mjs` runs as the new CI step does (`NATIVE_SCENE_EXE`). The 2 failures first seen (`model-maps#0` 24 % over its 9.877 % ceiling, `model-maps-off#0` 26 %) came from a STALE binary: that run used the main checkout's build dir, which lacked 54eaa1da ("glTF image leaves are textured without a session src" — the 24 % is exactly the pre-fix number in the baseline's `_why`). On this branch's own build, merged with native-core @ 33378d33: both scenes pass, full gate green, 338/348 gated match, 423/436 ported. Lesson: the gate must run against a build of the tree under test (CI builds its own).
- [ ] CI, never run: render-tests.yml `native-golden` on windows-latest — does Dawn take the WARP adapter (else the gate exits 2)? Review its report against the GPU run before removing `continue-on-error`.
- [ ] Linux (UNVERIFIED, compile-gated only): `linux-clang-engine` with `libgbm-dev` compiles `shared_texture_ffi_linux.cpp` (PREMATION_DMABUF) and the Linux `premation-host-bridge.node` (`dmabuf_bridge_ffi.cpp`). Real app on a Linux GPU box: `__premationEngineSurface.route === 'shared'`; if Chromium rejects the pixmap, check the modifier (LINEAR = '0'), the ABGR8888 / `rgba` mapping, `supportsZeroCopyWebGpuImport`, and whether `pidfd_getfd` is refused (Yama `ptrace_scope` ≥ 2, kernel < 5.6) — the log says `pidfd_getfd(pid, fd) failed` and frames are dropped; then the fallback must be route A (not yet automatic: remove the bridge or set `PREMATION_VIEWPORT_ROUTE=copy`). Leak check: fds in main (`ls /proc/<main>/fd | wc -l`) stay flat over 50 resizes.
- [ ] macOS: a popped-out Viewport on IOSurface (per-window rings) and on route A.
- [ ] Real app (2026-10-01, per-viewport views): View ▸ 3D View Top / Front / a camera view / Custom View 1 changes the ENGINE's frame of the main viewport (not only the chrome); orbiting a custom view re-renders live. 2 Views and 4 Views: each pane is its own engine viewport (`EnginePaneSurface`, ids base + 2…) showing its own view and framing (wheel zoom / middle-drag pan move the pane's pixels and its gizmo together); switching a pane's view re-renders it; closing the layout closes its viewports (`closeViewport`, no stray rings in main — `__premationEngineSurface` is the main viewport's only); the Quality = Wireframe boxes still paint in a pane; frames keep flowing to the main viewport while panes mount and unmount (one bridge consumer, `engineFrameHub.ts`).
- [ ] Real app (2026-10-01, Layer panel on the engine): double-click a placed, rotated, scaled, half-opaque layer with an effect and a mask — the panel shows it alone, upright, full-size, opaque, contain-fitted at its source size; Render off drops the mask / effects; a collapsed precomp shows as its card; a soloed sibling or the layer's own eye off does not hide it; scrub the panel's ruler — the picture follows the layer time while the comp playhead stays; In/Out trims still land on the comp's clip; the mask editor and paint strokes still line up with the engine's picture (same contain fit, `paneViewTransform`); closing the panel closes its viewport.
- [ ] Real app (2026-10-01, presentation mode on the engine): Presentation Mode shows the engine's frames contain-fitted, plays and scrubs; the Download Frame button saves the engine's still (`engineCompStill`) of the current frame at comp size; Quality = Wireframe boxes paint over the stage; leaving closes its viewport and the main viewport keeps its frames.
- [ ] Real app (2026-10-01, scopes / compare on the engine frame): the Scopes panel's waveform / parade / vectorscope / histogram follow the engine's picture at ~10 Hz while playing and paused, cropped to the comp (no pasteboard in the plots at any zoom / pan); the click-to-probe pixel matches; Snapshot (compare) captures the engine's frame and the A/B / wipe / difference modes line up with the live picture.
- [x] Real app, engine owner: `importFiles` of a PNG (512×512 still) and an MP4 (640×360, 1 s video) and `importBytes` of a PNG (cached as `<userData>/session-footage/<sha256>.png`) all answer with probed facts; before this branch both commands answered `unsupported` ("no media import port") with the engine as owner. An image layer on the bytes-imported item renders.
- [ ] Session footage in the real app, UI paths: import a clip by drag-and-drop (importBytes → a file under `<userData>/session-footage`, the viewport plays it); open a project whose footage is `blob:` (a template / AI media) → the page relinks it to a cache file and the engine viewport shows it (no `footage that is not a file on disk` in layerErrors); a sky image picked this session lights the scene; a height map from a picked image displaces.
- Known limits: a failed dmabuf import does not fall back to route A by itself; the pop-out's overlays compute their own geometry (the frame-synchronous push subscribes the editor's viewport 1 only); a pop-out opened with the engine off keeps the TS canvas.
- Merged with native-core @ 33378d33: the jobs branch had its own importFiles-by-path (`FilePorts::MediaProbe` = `jobs::probe_media`, `src` a `local-file://` URL). One design now: that probe and `local-file://` src (the page's importer, `electron/localFileUrl.ts`, the scene's `file_url_path` and jobs' `resolve_footage_path` all read it) for both importFiles and importBytes; importBytes writes the content-addressed cache file first; the facts-returning probe of this branch was dropped. [x] Re-run on the merge build: ctest 15/15; `engine_tests "[import]"` (the probe is the constructor's MediaProbe, src is `local_file_url`); real app importFiles PNG 512×512 / MP4 640×360 1 s, importBytes cached PNG, an image layer on it renders; editor + popped-out viewport both ~30 fps; jest engineJobsNative 5/5 against the real engine.

### b4-round3 (2026-09-28, run HERE on the Windows RTX 4060 box: `windows-clang-cl-engine` engine_tests / d1 / undo parity built and run; tsc; jest suites named below)
- Done and run: `engine_tests` all green (new `tests/test_b4_round3.cpp`: evaluateExpression `member`, Source Text preview), `engine_d1_parity_tests` green, `engine_undo_parity_tests` green after `PARITY_REBLESS=1` (3 getDocument probes of the layer-styles session: a switched-off style now keeps its properties — both catalogs changed the same way, the TS `undoParity` agrees with the re-blessed fixture). jest: `queries`, `expressionToggle`, `layerStyles` (mirror), `overlayGeometry` (store), `textBoxReflow`, `precomposeTool`, `aiEngineTurn` (B5 case), effects / text-expression suites.
- AI (coordinator report): `add_path_operator` no longer re-sends the type's defaults (a Pucker & Bloat was refused for wiggles/second, which it has no property for); `set_time_remap` enables Time Remapping through `setTimeRemap` (the property exists only then) and removes the boundary keys the call did not name. `precomposeTool.test` now runs on the app engine.
- Pre-existing failures seen here, not from this branch: `EffectsPanelBrowser.test` (4), `controls.test` (2, the deleted recorder), `commands.test` (edit command count 118 vs 121), `d1EvalParity.test` (the TS engine drifted from `d1_eval_parity.bin` — same digest with this branch's catalog change reverted), `aiEngineTurn` rig-turn bezier and merge_paths ids (fixed on the main checkout per the coordinator).
- [ ] Real app: expression editor on Position Y of an unseparated Position (the value shown is Y's), on Source Text (text + "n style overrides"), with the engine owner on; Layer Styles section with a style switched off in the timeline (values still shown); paragraph text box handles (Type tool / editing) follow the layer during playback and on a rotated / scaled layer, the reflow drag keeps the opposite edge, one undo entry.

### b4-round4 (2026-09-28, run HERE on the Windows box: all 15 ctest suites green; tsc clean; lint 0 errors; `lint:engine-writes` 0; read ratchet 519 → 381)
- Re-blessed from C++ after checking the diffs are exactly the catalog change: `d1_eval_parity.bin`, `undo_parity.bin` (layer-style / shape-operator sessions: a switched-off style keeps its properties, Roughen / Wiggle Transform list Wiggles/Second and Correlation).
- jest over layout / providers / stores / components / pages / hooks / core mirror, animation, timeline, library, automation, scene: failures all also fail on f4f02fe3 (NewCompositionDialog, TimeStretchDialog, EffectsPanelBrowser, CustomLayerSection asset picker, LightSection.env, idMatteEdits, motionEditorPanel, ScenePanel scope / shy, ReplaceFontsDialog, transformWriteRouting, compInstanceOverrides, docPropagatedCounts, CloudAutosave, commandLog) — `docFeatureCounts` Stores is 77 here (76 there: `stores/trackValues.ts` added; main re-baselines the doc counts). crossEngine generated seeds report `autoTrace` ts=unsupported vs c++=outOfRange (not from this branch).
- [ ] Real app: Layers panel Effects / Expressions search; tree drag reorder / reparent; Custom Layer section (needs-migration / downgrade banners); the mograph fill-in section; 3D Cube / Sphere / Text / Primitive dialog insert one undo entry each; inline AI prompt card anchors on the selection (a 3D layer anchors on its unprojected footprint); Convert Expression to Keyframes / Exponential Scale menu enablement; onboarding tour's keyframe step.

### b4-round5 (2026-09-28, run HERE on the Windows box: all 15 ctest suites green after the re-bless; tsc clean; lint 0 errors; `lint:engine-writes` 0; read ratchet 371 → 146)
- [ ] REVIEW the re-bless of `d1_eval_parity.bin` / `undo_parity.bin` (commit 5f2a2b4a): every outcome and revision step matched; the differing records were probe VALUES only (d1: getDocument 826, getPropertyTree 966, getPropertyValues 9; undo: getDocument / getPropertyTree / getHistory). They are explained by the new optional fields (PropertyInfo.stored, TextLayout.glyphs, ItemInfo.mediaUrl, LayerInfo.caption / multicamAngle, model/targetNames) and the named value fixes (rgba colours, grapheme styleRuns, legacy strokeOverFill order), but the fixtures are hashed so probes were not diffed one by one — record a full fixture (UNDO_FIXTURE) and check. A precompose outcome difference (the command reading its own `comp` instead of the active tab's) was REVERTED to keep the corpus answer; `checkPrecompose` asks the command's comp.
- [ ] jest failures seen here, all also on native-core: EffectsPanelBrowser, NewCompositionDialog, TimeStretchDialog, CustomLayerSection asset picker, LightSection.env, idMatteEdits, motionEditorPanel, ScenePanel scope / shy, ReplaceFontsDialog. The TS d1 / undo parity suites only warn on drift (the TS engine no longer matches the frozen corpus on native-core either).
- [ ] Real app: Puppet / Bone overlays (pins, mesh, bend pins on a skeleton, IK goals, weight painting) with the C++ engine drawing; 3D view chrome in Active / ortho / custom views and 2-/4-up panes; in-place text editing on a rotated / parented text layer; document colours strip; captions / transcript; multicam cut; Pre-compose dialog on a deformed layer; component library insert; Save Frame / Copy Frame / Presentation / Export at a non-default comp.

### b4-round6 (2026-09-28, run HERE on the Windows box: all 15 ctest suites green after the re-bless; tsc clean; read ratchet 146 → 117)
- Re-blessed `d1_eval_parity.bin` / `undo_parity.bin` for the paint-group change (ENGINE_API §15.15). Before the re-bless the only differing sessions were the two paint ones — d1: G2 paint stroke normalisation (3 values) and B3 paint strokes (5); undo: the same two (145 / 81 values). Every other session identical; no outcome or step differed. The round-5 re-bless review item above is still open (a probe-by-probe diff needs a full fixture recorded from both binaries; not done).
- [ ] Real app: Paint panel — stroke list names (Brush / Eraser / Clone n), hide / show, animate path, Paint on Transparent, delete + undo; Composition Navigator crumbs and Shift+Esc across a placed comp that starts late (the playhead lands mapped a moment after the tab switch); Mini-Flowchart up / downstream on a comp used twice; Pre-compose with Open New Composition; audio preview with the page mix (engine audio off) after trimming a bar while paused.

### wip-stopped (2026-09-27 — work stopped mid-task at the owner's request)
These branches were merged as they stood; each ends in a `wip(...)` commit that may not compile yet.
- `engine-jobs2`: done — mask/planar tracks + Create Null & Apply, the subspace / rolling-shutter stabilizers and mesh warp apply, the 3D Camera Tracker. Unfinished (wip commit): roto matte job, stabilizer edits; roto brush UI, content-aware fill job, auto-reframe job, job results in main's command log, solo-render inputs, retimed layers.
- `importers-cli`: unfinished (wip commit): AEP import in C++ (`native/engine/src/core/aep/`), `collectFiles`, convertLayer geometry, an early `src/engine-client/`. Not started: Lottie/SVG/mogrt importers as engine clients, CLI and render-worker via `premation-engine --export`, `separateLayer`, the `autoTrace` command.
- Not started (stopped before any commit): p3-viewport-tools (viewport/tools reads 224 → 0, geometry-backed SceneGraphPort), ui-writes-zero (3 UI writes with no undo since the recorder was deleted: `keyframeEdits.ts`, `engineItemsView.ts`, `Providers.tsx` — `npm run lint:engine-writes`), e4-round2 (canvas-only / LUT / path effects on the GPU).
- [ ] Build first; fix whatever the wip commits break before running the suites above.

### engine-jobs3 (2026-09-28 — built and run on the Windows RTX 4060 box, `windows-clang-cl-engine`)
Built: `premation-engine`, `engine_tests`, `engine_jobs_tests`, `engine_export_tests` (all green). jest: `electron/engineCommandLog`, `electron/cliEngineRender`, `packages/render-worker/electron/engineRender`, `src/core/captions/transcribeEngine`, and `src/core/engine/__tests__/engineJobsNative` against the REAL engine (transcribe through a local stand-in provider, rendered auto-trace on the GPU, auto-reframe). `tsc` (root + electron), `lint` 0 errors, `lint:engine-writes` 0, read ratchet 519.
- Done here: job results in main's command log (`logRecord` for `apply:true` and for `applyJobResult`; `startJob` never replayed); transcribe runs in the engine (key from main per job); auto-trace `rendered` (solo render by a child `--export --isolateLayer`); still images (PNG/JPEG…) in jobs through the OS codec — auto-reframe's analysis frames were unreadable before (the vcpkg ffmpeg has no still decoders); `importFiles` by path in the C++ engine (`jobs::probe_media`); `premation render` and the render worker through `premation-engine --export` (opt-in `PREMATION_EXPORT_ENGINE=1` / `RENDER_WORKER_ENGINE=1`, the window path on fallback).
- [ ] macOS / Linux: the transcribe job's HTTP goes through the system libcurl (`find_package(CURL)`, `http_post_ffi_curl.cpp`, never compiled here); without libcurl the job answers with a no-HTTP error. Still images in jobs need the OS codec (`image_decode_ffi.cpp` is WIC-only), so rendered auto-trace / auto-reframe read nothing there yet.
- [ ] Real app, engine owner on: Transcript ▸ Transcribe / Captions ▸ Generate with an OpenAI key in Settings → Assistant — the request leaves from `premation-engine` (not main), the key is not in `%APPDATA%` logs, the engine log or `getLog`; a crash of the engine mid-session replays the transcript nowhere (nothing was written). Layer ▸ Auto-trace on a text / shape layer with an effect traces what is drawn.
- [ ] Kill the engine after a job applied (Scene Edit Detection, Track Motion Apply): main's replay writes the markers / keys (one entry) without re-running the analysis; a job cancelled before the crash leaves nothing.
- [ ] `premation render x.motion --out y.mp4` with `PREMATION_EXPORT_ENGINE=1`: the report ends "(engine)"; a project with an unported frame prints `Rendering in the editor: …` and still writes the file.

### convert-layer (2026-09-28 — built and run on the Windows RTX 4060 box, `windows-clang-cl-engine`)
Built: `premation-engine`, `engine_tests` (new `[convert]`, `tests/test_convert_layer.cpp`); ctest 15/15. jest: `convertLayerNative` against the REAL engine WITH the scene (no `--no-gpu`), `commands`; `tsc`, `lint` 0 errors, `lint:engine-writes` 0, read ratchet 516.
- Done: `convertLayer` `shapesFromText` / `masksFromText` / `bakeTransform` and `separateLayer` (shape runs) in the C++ engine (`core/handlers_convert.cpp`; the text is traced on the frame builder's fonts — `EngineFrameBuilder` is the `ConvertGeometry`). An engine without the scene (`--no-gpu`, headless) answers `unsupported` like the TypeScript engine so the cross-engine replay compares like with like. On this branch (cut at f4f02fe3) `crossEngine`'s generated seeds 11/23/37/41/59/67 mismatch on `autoTrace` (ts=unsupported, c++=outOfRange): native-core's layers.ts validates before refusing — re-run `crossEngine` and `undoParity` after the merge.
- [ ] Real app / automation: `convertLayer{shapesFromText}` on bold, italic, paragraph, RTL and stroked text — the traced outlines coincide with the text (the layer's anchor is copied too, which the editor macro does not); `masksFromText` on a parented / rotated text (masks follow the drawn text); `bakeTransform` on a layer under a rotating parent with a wiggle expression (the copy plays the same, the expression disabled); `separateLayer` on the result of Shapes from Text.
- Left: `shapesFromVector` (svgParser.ts not ported — `ConvertGeometry::svg_shapes` answers why), `editableText`, `uncompose`, keyed font axes (the static style is traced), the font's own Béziers (`fromFont`). The Layer menu keeps the editor's Shapes / Masks from Text macros, which use font outlines when the face can be read.

### convert-round2 (2026-09-28 — built and run on the Windows RTX 4060 box, `windows-clang-cl-engine`)
Built: `premation-engine`, `engine_tests` (`[convert]`: uncompose world positions), `engine_scene_tests` (new `[outlines]` — font outline bounds vs the painted trace within 1.25 px; `[svg][shapes]`). jest `convertLayerNative` on the real engine with the GPU: each conversion one entry, and the comp's thumbnail before / after Shapes from Text and Convert to Editable Shapes differs in < 0.3 % of bytes (the picture is kept).
- Done: the font's own glyph outlines (FontSet::glyph_path; keyed weight / width / slant / `text.axis.*` sampled at the playhead), `shapesFromVector` (the engine's SVG parser, static documents), `editableText` (SVG `<text>` → text layers, the SVG keeps its graphics), `uncompose`. Layer menu Shapes / Masks from Text and a static SVG's Convert to Editable Shapes go through `convertLayer` when the engine owns the document.
- [ ] Real app, engine owner on: Layer ▸ Create Shapes / Masks from Text on a variable font keyed on weight (the outline follows the playhead's instance), on a stroked / small-caps text (traced, "(traced)" in the name); Convert to Editable Shapes on a static icon (the picture does not move — the TS macro rescaled it to a "comfortable size"), on an animated one (the editor's macro, keyed); Convert to Editable Text on an SVG with a label; Uncompose (via automation / AI: `convertLayer{uncompose}`) on a rotated, scaled, keyed precomp that starts later than 0.
- Known limits: multi-line text outlines are centred per line with kerning (fontOutlines.ts does the same) and can sit ~3 px off the painter's glyph-by-glyph line layout; SVG text parts are boxed at 0.55 em a character until the text layer measures itself; gradient transforms and gradient strokes are approximated; uncompose moves a top-level layer's Position keys but not a Position expression.

### e4-blend-span (2026-09-28 — built and run on the Windows RTX 4060 box)
- Done: an effect with Effect Opacity or a mask scope stays on the GPU route whatever its kind: the chain blends ANY entry back over its input (not only the kinds the TS GPU chain blends — the colour grades, LUTs, transitions, distort / warp kinds used to force the CPU bake), and an effect of several chain entries carries `blendSpan` on its first: its input is kept in `fx-blend-input` and blended back once after its last entry (applyEffectChain's blend of the whole effect). `FrameStats.effects.blendSpans` counts them. No registered effect writes several entries at its defaults today; the span is exercised by `engine_gpu_tests` "E4: a faded effect of several chain entries…".
- Measured (`premation-scene --gen-effect-bench D --effect-opacity 40`, `--bench D --gpu-effects --frames 10`, 1080p): the 56 faded cases that baked before now all route; median totalP50 48.2 → 23.6 ms (e.g. brightness 75.6 → 5.0, contrast 82.6 → 10.2, curves 61.3 → 5.8, tint 51.5 → 6.1; slowest after: hue-rotate 46.9, gamma-pedestal-gain 44.1, sepia 44.3 — the colour-matrix path, timings noisy while other agents built). Parity (`--batch` without vs with `--gpu-effects`, PNG diff): the faded cases differ from the CPU bake by the same margin as an effect-free layer already does between the two paths (`none`: max 74-75, 0.05 % of bytes > 8 levels — the ellipse's edge AA; the faded grades 0.05-0.08 %, posterize / threshold-rgb as unfaded); scoped cases (`--scoped 1`) match within 4 levels.
- [ ] Real app: a shape with Brightness at Effect Opacity 40 % (and a Levels scoped to a mask) plays at full rate with the HUD showing no bake; renders match `PREMATION_CPU_BAKE=1` by eye.
### p4-remove-fallbacks (2026-09-28 — phase 4 deletions; jest / tsc / lint on the Windows box, no C++ build)
- [ ] Real app, no flags: engine status is enabled + ownsDocument; rename `premation-engine.exe` away → a "Premation cannot start" dialog, then the app quits (no TypeScript engine takes over).
- [ ] Kill the engine three times inside a minute → the "Engine unavailable" dialog: Save Recovery Copy writes the last autosave where you choose; Try Again brings the engine back with the document (main's command log replayed); Quit quits.
- [ ] Render Queue / Export form (supervisor path): every job renders in the engine; a project whose frame the engine cannot build FAILS with the engine's reason (no window render). `premation render x.motion --out y.mp4` (no flag) ends "(engine)"; `--aspect 9:16` still renders through the hidden window.
- [ ] Open a project saved with a JavaScript plugin effect and a plugin generator layer: it opens, one warning names what was removed, Undo restores it, Save drops it; a native SDK plugin's effect is untouched even with the plugin uninstalled.
- [ ] Layers panel / Effects browser / menus / Dashboard: no Plugins panel, marketplace, Plugins menu, plugin tools flyout or Plugins dashboard tab; a layout saved by an older build that listed the Plugins panel still loads.
