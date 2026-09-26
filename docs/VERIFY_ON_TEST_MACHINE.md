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
