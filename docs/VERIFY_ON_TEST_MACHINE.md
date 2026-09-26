# Verify on the test machine

Code on `native-core` since 2026-09-26 was written on an 8 GB M1 that cannot
build the full engine (Dawn/Skia/ffmpeg) or run the suites in parallel. Each
item below was written but not run. Check them on a machine that can build
every preset (the Windows RTX 4060 box, or a Mac with 16 GB+ and Docker off).

## Build first

- [ ] `npm ci` on Node ≥ 22.12; `npm run engine-api:gen` leaves no diff.
- [ ] `npx tsc --noEmit` (use `NODE_OPTIONS=--max-old-space-size=8192`).
- [ ] `npm run lint`, `lint:engine-reads`, `lint:engine-writes`, `lint:automation-writes`.
- [ ] Native: `macos-clang`, `macos-clang-engine`, `windows-clang-cl-engine`, `linux-clang-engine`, the ASan/TSan presets, `native:tidy`, `native:wasm`.
- [ ] Apple clang: `engine_effects` uses `std::jthread` (`thread_pool.hpp`) — needs a fix or `-fexperimental-library` (predates this work).

## Parity fixtures to generate, then run their C++ tests

Each new C++ parity test prints WARN and skips while its fixture is missing.

- [ ] `GEN_NATIVE_WRITEON=1 npx jest writeOnTrailCrossEngine` → `test_write_on_trail_parity`
- [ ] `GEN_NATIVE_DEFORM=1` (glTF morph/skin), `GEN_NATIVE_PIXMO=1` (Pixel Motion / deinterlace), `GEN_NATIVE_EXTFACES=1` (extrusion faces), `GEN_NATIVE_ALPHAMESH=1` (image-layer rigs)
- [ ] Per-character 3D text has no fixture (glyph widths depend on fonts): check visually and against the golden 3D text scenes.

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
- Not done: motion blur / colour management engine commands, the assets store as a mirror view, Versions ▸ Compare as an engine still, Render Queue Output Module 16-bit, DEFLATE portable zips in the engine, the engine-side native-plugin host for export, running the alpha golden scenes through the CLI (needs a GPU).

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
