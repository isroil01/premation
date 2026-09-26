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

### b4-mirror-reads (C++: readmodel / handlers_layertime / catalog_data pass `clang++ -fsyntax-only` with the engine's -Werror flags; TS linted; no jest, no tsc, nothing linked)
- [ ] `npm run engine-api:gen` leaves no diff; `npx tsc --noEmit` — new required fields: `LayerInfo.{shapeType, managedBy, mographId}`, `ItemInfo.{mediaType, alphaProbed, audioProbed}`, `CompSettings.essentialProps`, `LayerTiming.{freeze?, bakedStretch?}`, the `liftRange` command / `TimeRangeEdit` result (any hand-built record in a fixture now needs them).
- [ ] `node scripts/lint/engineReadsReport.mjs --check` at or under the committed ratchet; `npx jest engineReadRatchet engine-api/src/generated.test` (doc names `liftRange`).
- [ ] `GEN_NATIVE_CATALOG=1 npx jest crossEngineCatalog` leaves no diff — `catalog_data.inc` was edited by hand to add the `liftRange` command row (same JSON, re-chunked).
- [ ] jest: `commands` (new `liftRange` row: undo parity), `timelineGaps` (rippleDeleteRange now shares `deleteRangePlan`), `mirrorEquivalence`, `layerOrdering` (the Scene tree is built from the mirror: `panelRows` awaits the engine), `ReplaceFontsDialog` (the missing-font check reads the mirror; the fixture now announces itself), `footageEdits` (pristine adoption reads `CompSettings.pristine` from the mirror), `compLayers`, the new `rollLimits` test, `layerKinds` (canBe3D / paintable now refuse any layer with a `generator`).
- [ ] Cross-engine corpus / D1 parity with the headless C++ engine: the new header fields match (`shapeType` from `shapeType`, `managedBy` = `__ownedByPlugin`, `mographId` = `__mographId`, `generator` for custom `pluginLayer:` layers, `freeze` = the held layer-axis time as flicks, `bakedStretch` = `fx.bakedStretch / 100`, `mediaType` / `alphaProbed` / `audioProbed` from the asset record, `essentialProps` from the comp root); `liftRange` returns the same `{layers, splits, deleted}` and undoes exactly in both engines.
- [ ] Real app: the Layers panel (tree, kinds, shape glyphs — star / heart / arrow keep their glyphs, plugin managed / inert marks, hidden rows dimmed, search by name / effect / expression / source, "reveal after reparent"); Character panel (range styling, kerning at the caret, Source Text keyed value at the playhead, Mask Path picker); Effects panel mask list at a moved / trimmed layer; Composition Settings (open, change nothing, Save → no history entry; change fps 29.97 / duration / background gradient / World keys); Lift / Extract Work Area toasts (counts); roll edit limits on trimmed footage; Time Stretch field / dialog on footage and on a baked shape; Freeze Frame state in the Compositing section and the clip menu; still-image pickers (sky, sprite, height map, plugin image param); Essential Properties promote / list / Pinned tab; the mograph fill-in section on a child layer; Replace Fonts / missing-font toast after opening a project.
- Not done (still direct reads, each marked `B4-gap`): text layout (`getTextLayout` — paragraph ⇄ point, box auto-size, the text box card), layer bounds (`readGeometry`), per-member key lists (keyframe assistants), layer-as-preset capture, keyframe / effect clipboards, the proxy record, the Cryptomatte set, the SVG document, the plugin schema version, thumbnails' object URLs, document-wide expression / effect-name search.

### b4-round2 (C++ passes `clang++ -fsyntax-only` with the engine's -Werror flags; TS linted; no jest, no tsc, nothing linked)
- [ ] `npm run engine-api:gen` leaves no diff; `npx tsc --noEmit`; `node scripts/lint/engineReadsReport.mjs --check` at or under the committed ratchet.
- [ ] capturePreset (query 1888): jest `queries` (the new capturePreset case: units, rebase, fx renumbering, empty, notFound; `QUERIES` count); C++ `engine_tests "[b4r2]"` (`tests/test_b4_round2.cpp`, new in `engine_tests`; `core/presets_capture.cpp` new in ENGINE_DOC_SOURCES). Real app: Motion Presets ▸ Save on a keyed layer (and on one with only an effect) lands in User Presets and applies back identically on another layer / comp size; "Nothing to save" on a bare layer.
- [ ] getTextLayout / getLayerBounds: jest `queries` (both answered now: getTextLayout where the jest canvas has metrics — `hasCanvas` — else `unsupported`; the new getLayerBounds case), `paragraphTextCommands` (no visual jump over the engine's `getTextLayout`; the enabled test awaits the mirror; the text-on-path case now asserts only the refusal), `textDirectionCommands`, `inspectorViaEngine` (align is async). C++ `engine_tests "[b4r2]"` (bounds on a keyed shape; text `unsupported` headless). Full engine: `scene/text_query.cpp` is new in the scene sources, `core/layer_geometry.cpp` in ENGINE_DOC_SOURCES; `engine_frames.cpp` (EngineFrameBuilder is now also the `TextQueries`) was NOT syntax-checked (needs Dawn / media headers). Cross-engine: `getTextLayout` / `getLayerBounds` on the corpus's point / paragraph / anchored auto-height text and on groups — equal within 1 px.
- [ ] Real app: Character ▸ Text Box — Point ⇄ Paragraph on rotated / scaled / right-aligned / RTL text holds the lines still; Auto Height ⇄ Off ⇄ Fit; the box H field on auto height and the Overflow mark; Align / Distribute on rotated layers, groups and parented layers (now by the drawn box); stroke gradient Start / End defaults on text and shapes; SAM segment mask on a text layer; Auto-Rig sizes to a text layer.
