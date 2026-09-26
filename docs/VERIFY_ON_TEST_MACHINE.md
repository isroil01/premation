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

### f2-ownership (C++ syntax-checked only; TS linted; no jest, no tsc run)
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
