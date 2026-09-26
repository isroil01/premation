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
- Not done: Versions ▸ Compare as an engine still, the engine-side native-plugin host for export, running the alpha golden scenes through the CLI (needs a GPU). (Motion blur / colour management commands, the assets store and comps as mirror views, Render Queue 16-bit, DEFLATE portable zips: done on `engine-jobs`, below.)

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
