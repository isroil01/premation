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
- [ ] Apple clang: `engine_effects`, `engine_export`, `engine_scene` build without `-fexperimental-library` (d2w-round2 replaced `std::jthread` with `core/joining_thread.hpp`).

## Parity fixtures to generate, then run their C++ tests

Each new C++ parity test prints WARN and skips while its fixture is missing.

- [ ] `GEN_NATIVE_WRITEON=1 npx jest writeOnTrailCrossEngine` → `test_write_on_trail_parity`
- [ ] `GEN_NATIVE_DEFORM=1` (glTF morph/skin), `GEN_NATIVE_PIXMO=1` (Pixel Motion / deinterlace), `GEN_NATIVE_EXTFACES=1` (extrusion faces), `GEN_NATIVE_ALPHAMESH=1` (image-layer rigs), `GEN_NATIVE_CJKWRAP=1 npx jest cjkWrapCrossEngine` (CJK wrap → `cjk_wrap_parity.json`)
- [ ] Per-character 3D text has no fixture (glyph widths depend on fonts): check visually and against the golden 3D text scenes.

## Branch by branch

### cleanup-dead-code, f2-motion-bundles (verified here)
- tsc 0 errors, related jest green, `bundleCrossEngine` 6/6 on the headless C++ engine.

### d2w-cpp-ports (syntax-checked only)
- [ ] Headless: `engine_scene_core_tests` and the new tests link and pass.
- [ ] Full engine: `threed_port`, `snapshot_build`, `effect_handoff`, `per_char3d`, `rig_coverage` link; render-tests native gate: write-on brush, glTF morph/skin models, extrusion slice-stack / geometric faces, image-layer rigs now render natively (fewer `unported` reasons).
- [ ] `getLayerTransforms` returns world 4×4 for 3D layers/cameras/lights in both engines.
- Not wired yet: Pixel Motion / deinterlace kernels (need the GPU media feed).

### d2w-round2 (syntax-checked only)
- [ ] Builds: `engine_scene_core` now links zlib (`zlib_inflate_ffi.cpp`); `engine_frames` links `engine_export_core` (PNG thumbnails). Windows (clang-cl) and Linux presets too.
- [ ] Tests link and pass: `engine_tests` (`test_engine_queries.cpp`), `engine_scene_core_tests` (`test_frame_hit`, `test_exr_read`, the CJK case in `test_raster_text_core` after the fixture), `engine_scene_tests` (`test_rig_coverage`, the footage case in `test_bake_chain`, the soft-break case in `test_text_port_parity`), `engine_media_tests` / GPU (`test_media_gpu`: `#u`/`#l` hashes, the deinterlace pass, `convert_frame`), `engine_effects` (ThreadPool shutdown under TSan).
- [ ] Queries in the real app (engine owner on): `getWaveform` on an audio layer and a footage item (busy while conforming, then peaks); `getThumbnail` of a comp, a layer (alone), a still and a video item (PNG, ≤ maxSize); `hitTest` clicks select the layer under the pointer (rotated, corner-pinned, collapsed precomp → the precomp layer, locked skipped); `readPixels` in the Info panel / eyedropper matches the viewport colour (working space, straight alpha).
- [ ] Render-tests native gate: fewer `unported` reasons — CJK paragraphs, Fit Text to Box, Pixel Motion, interlaced / pulldown footage, EXR skies (needs an .exr on disk), SVG / relative-path image rigs, footage with Canvas2D-only styles. Compare visually against the TS where there is no fixture (Fit Text to Box, Pixel Motion's CPU warp vs the TS GPU warp, footage bakes).
- [ ] Viewport: a project opened from disk resolves relative footage / image paths (the texture feed now gets `mediaBase` in the viewport, not only in export).
- [ ] Perf: Pixel Motion playback (two readbacks + CPU warp per new weight) and footage bakes (baked on the render thread, one frame at a time) — note the HUD cost; a GPU warp / pooled bake is follow-up.

