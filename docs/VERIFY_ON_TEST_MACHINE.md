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

- Done on p1-freeze-data: the write-on, deform, Pixel Motion, extrusion-faces and alpha-mesh fixtures were generated once and committed as frozen data; the GEN_NATIVE_* branches are gone (see that section).
- [ ] Per-character 3D text has no fixture (glyph widths depend on fonts): check visually and against the golden 3D text scenes.

## Branch by branch

### cleanup-dead-code, f2-motion-bundles (verified here)
- tsc 0 errors, related jest green, `bundleCrossEngine` 6/6 on the headless C++ engine.

### d2w-cpp-ports (syntax-checked only)
- [ ] Headless: `engine_scene_core_tests` and the new tests link and pass.
- [ ] Full engine: `threed_port`, `snapshot_build`, `effect_handoff`, `per_char3d`, `rig_coverage` link; render-tests native gate: write-on brush, glTF morph/skin models, extrusion slice-stack / geometric faces, image-layer rigs now render natively (fewer `unported` reasons).
- [ ] `getLayerTransforms` returns world 4×4 for 3D layers/cameras/lights in both engines.
- Not wired yet: Pixel Motion / deinterlace kernels (need the GPU media feed).

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
