# Premation engine plan — Electron UI, C++ engine

> **Final plan, 2026-09-22.** Branch `native-core`. This document replaces the
> earlier drafts (see git history for them). It records the architecture the
> product owner decided, what is already built, and the order in which the
> rest gets built. Every step ships behind a flag with today's TypeScript
> engine as the fallback, so the product keeps shipping the whole way.

---

## 0. The decision

**Electron and React are the user interface and nothing else. Everything that
makes pictures — the document, evaluation, the render graph, the GPU, colour,
decode, text, effects, audio, caching, export and plugins — lives in one C++
program, `premation-engine`.** This is how After Effects is built, and it is
what "absolute beast" requires: nothing in the hot path runs JavaScript, and
nothing the engine does can freeze the UI.

| Decision | Choice |
|---|---|
| UI | React 18 + TypeScript + Zustand + Radix + CSS modules in Electron 32. Stays. |
| Engine | `premation-engine`, a native C++20 **process** spawned and supervised by Electron main. Not an addon inside Electron, not code in the page. A crash restarts the engine, never the app. |
| GPU | Dawn native (the C++ library Chromium itself uses for WebGPU) inside the engine: the same WebGPU API and the same WGSL shaders we already have, driven from C++. D3D12 on Windows, Metal on macOS, Vulkan on Linux. |
| Colour | 32-bit float, scene-linear working space, OCIO colour management. Built into the render graph from the first pass, not retrofitted. |
| How the UI talks to the engine | A versioned command API: the UI sends commands and queries, the engine sends change events and finished frames. The UI never edits the document directly. |
| Language | C++20, Clang on every platform (clang-cl on Windows). |
| What is not changing | The UI stack, the plugin permission model, the project file format and migrations, the golden-frame test gate. |
| Not doing | A C++ UI (Qt, ImGui); a web editor; collaboration; a render farm; a public CLI product. None of these is prevented. |

---

## 1. Target architecture

```text
┌──────────────────────── Electron UI process (React) ────────────────────────┐
│  timeline · graph editor · inspector · layers · effects · dialogs · menus    │
│  read-only mirror of the document, fed by engine change events               │
│  draws gizmos and handles immediately; never renders the composition         │
└───────────────┬──────────────────────────────────────────────▲──────────────┘
                │ commands, queries (typed preload API)         │ events, frames
┌───────────────▼────────────── Electron main ─────────────────┴──────────────┐
│  window + OS services · file dialogs · updates · IPC relay                   │
│  EngineSupervisor: spawns, watches, restarts premation-engine                │
└───────────────┬──────────────────────────────────────────────▲──────────────┘
                │ versioned binary protocol over a pipe         │ frames: route
                │                                               │ chosen in C1
┌───────────────▼──────────── premation-engine (C++) ──────────┴──────────────┐
│  Document + command log + undo                                               │
│  Evaluation: keyframes, interpolation, expressions, parenting, time remap   │
│  Render graph ── Dawn ── D3D12 / Metal / Vulkan                              │
│  Colour: float linear + OCIO    Cache: RAM + disk frames                     │
│  Media: ffmpeg + NVDEC / D3D11VA / VideoToolbox → GPU textures               │
│  Text + vector: Skia (Graphite on Dawn) + HarfBuzz                           │
│  Effects: WGSL on the GPU, SIMD kernels on all cores                         │
│  Audio: decode, mix, playback; owns the clock                                │
│  Export: frames → ffmpeg, multi-frame across threads                         │
│  Plugin host: native SDK with GPU texture handoff                            │
└──────────────────────────────────────────────────────────────────────────────┘
```

The same engine binary does preview, export and automation. Export is the
engine rendering with no viewport attached.

---

## 2. The engine API

This is the contract between the UI and the engine. It is designed first and
built first (phase B), because once every UI change goes through it, moving
the engine to C++ changes where commands are sent, not 277 panels.

**Commands** change the document. Each is undoable and has an inverse.

```text
createLayer · deleteLayer · reorderLayers · setParent · precompose
setProperty(layer, path, value) · setKeyframe · deleteKeyframe · setEasing
addEffect · removeEffect · setEffectParam · addMask · setMaskPath
setClip(trim/move/split) · setComposition · importAsset · relinkAsset
beginGesture(label) … endGesture()   ← a drag becomes ONE undo entry
undo · redo
```

**Transport** is owned by the engine: `play`, `pause`, `seek(time)`,
`setLoop`, `setPreviewQuality`. The UI never calls a per-frame render; the
engine runs the clock, keeps audio and video in sync, and pushes frames.

**Queries** read without changing anything: layer tree, property values at a
time, keyframes in a range, waveform peaks, font list, asset metadata.

**Events** tell the UI what changed, in batches, with a revision number:
`layerAdded`, `propertyChanged`, `keyframesChanged`, `clipChanged`,
`historyChanged`, `renderStats`, `engineError`. The UI updates its read-only
mirror from these and nothing else.

**Frames** go to the viewport by the route phase C1 picks.

Rules: the API is versioned from day one; the schema is written once and
generates both the TypeScript and C++ types; every command is loggable, so a
recorded session can be replayed against either engine (§6). AI tools,
scripts and plugins use exactly the same API, which makes it the automation
API for free.

Interaction latency: a local pipe round trip is well under a millisecond, so
60 property updates a second during a drag are cheap. The UI moves the gizmo
immediately; the engine's rendered frame follows within a frame.

---

## 3. What is already built (on `native-core`, pushed)

| Done | What it gives | Verified |
|---|---|---|
| **Boundaries** `da34c90e` | Lint stops engine code importing React or UI; 10 misplaced files moved | Lint + full suite |
| **Measurement** `da34c90e` | GPU frame time and VRAM in the HUD; benchmark ratchet in CI | Tests, benchmarks |
| **Safe saves** `affdf26a` | Every persisted file written temp-then-rename; a crash can't corrupt a project | Tests |
| **One undo history** `71792a8c` | Scene and timeline undo stay coherent; stable clip ids | 3 real bugs pinned as tests |
| **C++ toolchain + first library** `16009f5b` + CI fixes | `native/` workspace, C ABI, `motion_eval` ported from TypeScript | **CI: bit-exact golden table on macOS, Linux, ASan, TSan, WASM**; Windows link fix in flight |
| **Raw pixel pipe** `65a7cf30` | Export streams raw frames to ffmpeg, byte-identical output, NVENC | Real ffmpeg; 121 vs 33 fps |
| **Isolated export process** `3c73ba9c`, `e18b9583` | Renders run in their own process; crashes on either side are contained; Render Queue uses it | **Real Electron app**: crash, retry, editor-killed-mid-render all pass |
| **Path raster key memo** `1c15904b` | 2–3× faster cache keys for animated paths in the TS fallback | A/B benchmark |

These carry straight into the new architecture: the export supervisor becomes
the engine supervisor, the raw pipe is what the engine writes to, the undo
work defines the command semantics, and `motion_eval` is the engine's first
library.

---

## 4. Ground rules for the C++ engine

**Toolchain.** C++20; Clang everywhere (clang-cl on Windows); CMake presets;
vcpkg manifest with a committed baseline; Ninja. The engine is a native
executable; the WASM build of shared libraries is kept only as a test target.

**Safety gates, blocking in CI.** ASan + UBSan run the whole suite; TSan runs
everything threaded; clang-tidy (cppcoreguidelines, bugprone, performance,
modernize) with warnings as errors; `-Wall -Wextra -Wpedantic -Werror -Wshadow
-Wconversion`; clang-format once the tree has had its first formatting pass.

**Code.** No raw `new`/`delete`; RAII everywhere; `unique_ptr` by default,
`shared_ptr` only with a written reason; plain structs, `span` and
`string_view` at boundaries; no exceptions across the protocol or any C ABI;
FFI to ffmpeg, Skia and OS APIs only in `*_ffi.cpp` files.

**Determinism.** No wall-clock reads in rendering, no unseeded randomness, no
fast-math, `-ffp-contract=off`. Same document + frame + settings ⇒ same pixels
on every platform. The golden gate checks this.

**Isolation.** Engine code runs only in `premation-engine`. Plugins, decoders
and effects fail per layer without taking the frame down; the engine process
failing costs a restart, never the user's project.

**Flags.** Every step ships behind a flag with the TypeScript path intact and
flips default only on golden parity. Nothing waits for "the engine to be
complete".

---

## 5. Phases

Sizes are for one small team working with AI assistance. Phases B and C run
in parallel.

### Phase A — Foundations · **done**, except A5

| | | |
|---|---|---|
| A1 | Boundaries, measurement | done |
| A2 | Safe saves, one undo history | done |
| A3 | Isolated export process + raw pipe | done, verified in the real app |
| A4 | C++ toolchain, C ABI, `motion_eval` | done; bit-exact on 5 of 6 CI targets |
| A5 | Windows CI green; C++ toolchain on the dev machine | **done** — all six CI targets green (Windows clang-cl, macOS, Linux, ASan/UBSan, TSan, WASM); local build + tests + N-API smoke pass |

### Phase B — The seam: every UI change goes through the engine API (TypeScript, no C++ needed)

| Step | What | Exit | Size |
|---|---|---|---|
| B1 | Write the API schema (§2) and generate TS + C++ types; pick the wire format (FlatBuffers or a small custom codec) with a measured decision | Schema reviewed; codegen in CI | 2 wk |
| B2 | `EngineClient` in TypeScript implementing the API on top of today's engine. The existing command system and AI tool layer already cover much of it | Every command has an inverse and a test | 3 wk |
| B3 | Route every UI write through `EngineClient`; lint forbids panels from writing the scene graph or animation stores directly | Lint green with zero exceptions | 4–6 wk |
| B4 | The UI reads through a mirror fed by change events | Inspector/timeline render from the mirror only | 3 wk |
| B5 | AI tools, scripts and plugins call the same API; command logs can be recorded and replayed | Replay of recorded sessions reproduces documents exactly | 2 wk |

### Phase C — The engine process and the viewport

| Step | What | Exit | Size |
|---|---|---|---|
| C1 | **Viewport prototype.** A native process renders a layer with Dawn; show it in the Electron viewport three ways — frames copied into the page, a native child window over the viewport, a shared GPU texture if Electron's APIs allow it (verify, don't assume). Measure latency, CPU, 1080p and 4K throughput, resize and menu overlap | A written choice with numbers; losing routes deleted | 3 wk |
| C2 | `premation-engine` executable, the protocol transport, and `EngineSupervisor` in Electron main (the export supervisor's pattern) | Engine crash → automatic restart, UI shows a notice, nothing lost; protocol fuzz-tested | 4 wk |
| C3 | `EngineClient` gains a second backend that speaks to the process; flag selects TS or C++ | Same command replay passes against both | 2 wk |
| C4 | **Electron 32 → 40+ upgrade** (C1's decision needs Electron's `sharedTexture` import, added in 40.0.0 and still marked experimental). Walk every major's breaking changes: preload/sandbox, `BrowserView`→`WebContentsView`, protocol handlers, IPC, GPU flags, the auto-updater, electron-builder, the render-tests harness and CLI hidden-window render | Full jest + render-tests + the real-app harness (export crash/retry/editor-killed, Render Queue) pass on Electron 40+; route C runs inside the real app | 3–4 wk |

**C1 result (2026-09-23, `docs/VIEWPORT_ROUTE.md`):** route **C, shared GPU
texture**: 59.7 fps at 1080p and 59.9 at 4K, 12.6 ms frame latency p50,
6.6–8.5 % of one CPU core, HTML menus and gizmos draw over the viewport
normally. Route A (frame copy) is kept only as a half-resolution fallback:
36 fps at 1080p, 6.7 at 4K, because the main→page copy costs ~22 ms per
1080p frame. Route B (native child window) is rejected: menus and gizmos
vanish behind it, and it trails splitter drags by 15–50 ms. Consequences:
pixels never travel over the command pipe (the engine sends "frame ready in
slot N", the page releases slots; a full ring drops a frame, never blocks);
the supervisor must start the engine on Chromium's GPU (a vendor mismatch
made every transfer time out); the viewport tells the engine a preview size
and pixel ratio, not a window rectangle. Dawn comes from vcpkg's `dawn` port
behind a manifest feature `engine`: 16 min clean build, 565 MB cache.

**C3 result (2026-09-23, `docs/ENGINE_API.md` §15.5):** the C++ engine is a
second `EngineClient` backend (`ProcessEngineClient`), selected by
`PREMATION_ENGINE=process` (default off) and wired end to end: supervisor in
main, IPC through ipcGuard, shared-texture frames into an engine surface beside
today's viewport, crash → restart → command-log replay, crash loop → the TS
engine. Parity decided and enforced on both engines: one revision and one event
batch per request, events before the response, After Effects units (scale %),
centre-origin layer space. **Exit met:** the replay corpus passes against both
engines (9/9, 0 mismatches; the C2-subset session 41/41 compared). Real app:
30/30 fps, restart replays 55 requests in 29 ms with an identical document.

### Phase D — Rendering in C++

| Step | What | Exit | Size |
|---|---|---|---|
| D1 | Document, evaluation, expressions, parenting and time remap in C++, fed by commands | Replayed sessions produce identical evaluated values to the TS engine | 8 wk |
| D2 | Render graph and passes on Dawn, reusing every WGSL shader; 2D, masks, mattes, blend modes, motion blur, precomps, 3D, lights, shadows, DOF | Golden gate: all frames match the TS reference within existing ceilings | 12–16 wk |
| D3 | Float linear colour with OCIO, working-space and display transforms, 16/32-bit export | Colour test charts match OCIO reference transforms; 8-bit output unchanged | 4 wk, alongside D2 |
| D4 | RAM and disk frame cache in the engine, sized by the machine, not by Chromium's heap | Cached playback of a heavy comp holds full rate | 3 wk |
| D5 | Engine viewport default-on; the TS renderer stays behind the flag for one release | HUD frame time ≤ TS path on every bench comp | 2 wk |

**D2 progress (2026-09-23): the render graph runs in C++ on Dawn, at parity
on the whole golden suite.** Decoupled from the C++ document (still C2's
subset) through a **serialized FrameScene** — engine-api family `Render`,
`96_render.eapi`: the flat render description `snapshotToFrameScene` produces,
the viewport, the colour-pipeline state, the WGSL of any plugin shader it
names, and every sampled texture's texels (read back after upload, deduped by
content hash) so TS-produced text / vector / video rasters ride along until
E3/E1 produce them natively. The same struct is what the engine will build in
process from its own document. `native/engine/src/render_graph/`:
`graph.cpp` (passes, reads/writes/after, Kahn order with the TS tie-break,
cycle report, orphaned-target pruning, per-pass failure isolation — GPU-free,
unit-tested), `resource_pool.hpp` (keyed pools, frame-stamped GC, VRAM meter),
`device.cpp` (Dawn: transient targets pooled by name + size, textures by
content hash, pipelines by material × blend × format × samples, a per-frame
uniform arena with DYNAMIC OFFSETS so bind groups are cached across frames —
the TS path allocates one per draw), `composition_pass.cpp` + `effect_chain.cpp`
+ `threed.cpp` (CompositionPass ported branch by branch: precomps, mattes,
adjustments, glass/backdrop blur, advanced blends, motion blur, deformed meshes,
generators, plugin effects, the whole effect chain incl. every packFxBlock
table effect, 3D depth groups with lights, env reflections, extruded/glTF PBR
meshes, two shadow maps, SSAO, camera DOF gather, sealed-precomp 3D scopes).
Every shader and material is extracted verbatim from packages/renderer
(`shaders/extract.mjs`, 207 shaders, 211 materials, `--check` for drift).
Colour: rgba16float scene-linear intermediates, the TS transfer functions and
ODTs unchanged; OCIO is a hook on `ColorPipeline` (D3), output untouched.
Parity: render-tests backend `native` (`premation-render --batch` over the
FrameScenes the webgpu pass exports, compared against the webgpu frame of the
same run, ratchet `native-baseline.json`): **428/428 frames ported, 428/428
within tolerance, 421/428 bit-identical** (the other 7 are low-alpha pixels in
backdrop-combine modes, ≤ 11/255). Bench (AMD 780M, both measured as render +
submit + GPU idle): heavy 1080p comp 232 vs 295 ms (TS), 1500-layer comp
8.3 vs 26.5 ms; C++ on the RTX 4060: 64.7 / 6.0 ms. **Remaining for D2**: the
engine producing its own FrameScene from the C++ document (with D1/E*), wiring
the graph into the render thread behind the engine flag (replacing C2's
compositor), and a WebGPU-free software parity path for CI (the gate needs a
real adapter today).

**D2 mesh producers (2026-09-24): rigs render from the C++ document;
primitive, extrusion and rig geometry is byte-identical to the TypeScript.**
Puppet pins and skeletons no longer fall back. `snapshot_build` runs the rig
block (`rig_bridge` → `rig_mesh`) over the engine's own document and animation,
and `frame_build` emits `deformedMesh`. Image layers are the exception: they
stay reported, because the TypeScript culls their mesh with the decoded
bitmap's alpha. The GPU- and raster-free ports now form their own library,
`engine_scene_core`. Three cross-engine fixtures, each generated from the
editor's code and guarded against staleness by its jest test, pin them in
`engine_scene_core_tests`:
- rigs: 7 cases / 13 frames, `.motion` document in, every vertex, index and
  depth value equal;
- primitives: 14 specs, every type, clamped segment counts, 32-bit indices,
  rebuilt from the key alone;
- extrusions: 9 recipes × bevel profiles, caps, hole bevel, uv box, Bézier
  runs, a traced bitmap.

`primitive_mesh.cpp` is the new port of primitiveMesh.ts and primitiveLayer's
key/interleave. `premation-scene --mesh-check` is wired. **Remaining:** 3D
layers in the C++ scene builder, which is where extrusions, primitives and
models are placed.

**D2 leftovers + D3 (2026-09-23): 436/436 frames bit-identical, 32 bpc, OCIO.**
*The 7 low-alpha frames were never a renderer difference*: the C++ surface
bytes already equalled the TS surface bytes. The harness's PNG encode
(`rgbaToPngBase64`) puts already-premultiplied bytes into a 2D canvas, which
stores premultiplied 8-bit and takes putImageData input as straight — so every
webgpu (and webgl2) PNG is premultiplied twice and un-premultiplied once more
(at a = 10/255 every value < 13 stores as 0; at a = 21 only 0, 12, 24 … survive).
Skia rounds those conversions in float, ties either way, so no closed form is
exact; the webgpu pass now MEASURES the conversion (a 256² probe canvas through
the same two functions, `readback-table.png`) and premation-render applies it.
**Float intermediates**: the project bit depth picks every declared-float
target's precision — 32 = rgba32float, no MSAA (needs float32-filterable AND
float32-blendable); 16 = today; 8 = unorm (the TS no-float tier) —
`render_graph/bit_depth.hpp`. The TS WebGPU 32-bpc path was broken (it never
requested `float32-blendable`, so every blended pipeline into rgba32float was
invalid); fixed in WebGPUBackend + `intermediateFloatFormat`. **OCIO** 2.5.2
(vcpkg, `engine` feature), OCIO's built-in CG config pinned by version; AE's
model: working space (compositing always linear, in its primaries), per-footage
input interpretation (`RenderTextureRef.inputSpace`, converted once per content
into a working-space float texture), display transform on the viewer, output
transform on export — schema `RenderView.colorManagement`, absent = today's
pipeline byte for byte. OCIO's LOSSLESS-optimized processor is carried into
WGSL as an op program (matrix / exponent / moncurve / range, interpreted from a
uniform block — no per-transform pipeline) and baked to a log2-shaped lattice
only when it holds ops the program cannot express (ACES output views). Measured:
op program **0.0** max error vs OCIO's CPU processor on ACEScg → sRGB (33³
lattice 6e-2, 65³ 3e-2); GPU footage conversion 2.4e-7; same cost at 1080p
(+0.12 ms op program, +0.14 ms lattice over the 0.73 ms plain blit, 780M).
**Mips** (generated as exact 2×2 box chains, trilinear), **OverlayPass** and the
**viewer-LUT blit** ported; new fidelityOnly scenes `native-float32-*`,
`native-overlays-*`, `native-viewer-lut-*` gate them TS vs C++ (all
bit-identical). clang-tidy clean over `render_graph` (local `.clang-tidy`
states each disabled check); the render graph incl. Dawn + OCIO runs under
ASan (all unit tests + all 436 frames, byte-identical). **Remaining for D3**:
porting OCIO's fixed-function ops (ACES RRT/ODT, grading curves) into the op
program so output views stop using the lattice (1.5e-2 in gamut at 65³ today),
16/32-bit export (F*), and the C++ document producing `colorManagement` + footage
`inputSpace` (the TS producer never sets them).

### Phase E — Media, audio, text, effects

| Step | What | Exit | Size |
|---|---|---|---|
| E1 | Hardware decode into GPU textures (NVDEC, D3D11VA, VideoToolbox, ffmpeg fallback); ProRes, DNxHR, mixed timelines | 4K ProRes scrub ≤ 50 ms; 6 × 1080p layers at full rate | 6 wk |
| E2 | Audio engine: decode, mixing, effects, playback device; the audio clock is the master clock | A/V drift ≤ 1 frame over 10 minutes | 5 wk |
| E3 | Text and vector with Skia + HarfBuzz; bidi, vertical, kinsoku parity with today | Noto text goldens match; animated-text bench ≥ 3× | 8 wk |
| E4 | Effects: GPU effects keep their WGSL; the 28 Canvas2D-only effects and 44 CPU bake sites become SIMD kernels on all cores | No effect drops the bench comp below 24 fps; golden parity | 8–10 wk |

**E3 progress (2026-09-24, uncommitted on `native-core`).** `native/engine/src/raster`
is a Canvas2D-semantics layer on Skia's CPU raster backend (Chromium's canvas is
Skia) with call-for-call ports of the TS vector, mask and text painters, HarfBuzz
shaping with Blink's font funcs, SheenBidi, and the vertical / TCY / kinsoku /
optical-kerning layout; see `native/README.md` § Text and vector rasters. The
TS side gained one export path: `rasterCapture.ts`, a hook in
`Canvas2DVectorRasterizer.rasterize`, and `RenderFrameFile.rasters` (schema
`96_render.eapi`), recorded only by the render-tests harness. Parity against
Chromium's software canvas, per raster (263 rasters, `premation-raster --mode native`):
blend 36/36, effects 77/77, masks 18/18 and "other" 47/48 ported rasters are within
1/255. Shapes, strokes and text are all within 16/255, except that text-optical-kerning
glyphs land ≈0.1 px off. In replay mode, text is 28/28 within 16/255 and
measureText 183/183 exact. Whole frames drawn with C++ rasters: 211/213 within the
scene tolerance of webgpu, and 1 ceiling in `native-raster-baseline.json`
(effect-posterize: GPU-canvas ellipse AA amplified by posterize). Bench
(`bench-raster.mjs`, RTX 4060 laptop): 200 animated text layers, TS 344.7 ms/frame
(GPU canvas draw + upload) vs C++ 95.8 ms on 1 thread (3.6×) and 26.6 ms on 16 threads
(13×). 1000 animated paths, TS 1762.9 ms/frame vs C++ 175.4 ms (10×) and 24.5 ms (72×).
Open: the GPU (Graphite) raster path, CPU-baked effect chains (E4), paint strokes,
vertical optical kerning, alias FontFace features, Intl word breaks, macOS / Linux
system fonts.

### Phase F — Export and ownership

| Step | What | Exit | Size |
|---|---|---|---|
| F1 | Export from the engine directly to ffmpeg, multi-frame across threads; the export supervisor launches engine jobs instead of hidden Chromium windows | ≥ 3× today's raw-pipe fps on 8 cores; md5-identical output at the same settings | 4 wk |
| F2 | The engine owns the document and undo; the UI holds only its mirror. The TS engine is kept behind the flag for one release, then removed | No authoritative project state in the UI process; undo parity suite green | 6 wk |

### Phase G — Ecosystem

| Step | What | Exit | Size |
|---|---|---|---|
| G1 | **After Effects-style native plugin SDK.** Modelled on the AE effect API: a single entry point dispatching command selectors (about, global setup, params setup, sequence setup/resetup/flatten, frame setup, render, smart pre-render + smart render, user-changed-param, update-params-UI, GPU device setup and GPU render); a declarative parameter model (sliders, angles, points 2D/3D, colours, popups, checkboxes, layers, paths, groups, arbitrary data) keyframeable by the engine; checkout of other layers and of input at other times; 8/16/32-bit float pixel worlds; a GPU path that hands the plugin Dawn/D3D12/Metal textures; sequence data for per-instance state. Loaded in the engine process with per-plugin crash isolation, a published versioned C ABI and headers, and a sample plugin set (a CPU effect, a GPU effect, a generator, a layer-checkout effect) | The samples load, render at 8/16/32-bit, animate their params, survive their own crash, and export identically to preview | 8–10 wk |
| G2 | **Decided (owner, 2026-09-22): today's JavaScript/WGSL plugin system is not ported.** Existing installed plugins are left untouched and may be removed; the native SDK is the plugin system of the C++ engine | — | done |
| G3 | AE-SDK compatibility shim (loading real AE `.aex`/`.plugin` binaries) — a separate product decision after G1; G1's API is shaped so it stays possible | — | later |

**G1 progress (2026-09-24): the host runs in the engine; every exit criterion
the engine can meet today is tested.** `docs/PLUGIN_SDK.md` is the SDK guide.
The sample bundles build with the engine (`native/sdk/CMakeLists.txt`) and
load through the manifest scan. They render at 8/16/32 bpc, and the depths
agree to within quantisation. Renders are byte-deterministic, and params drive
the render. `rings` keeps its palette in the document's sequence data: shuffle
is one undo entry, and undo renders the old palette. Layer Displace and Time
Echo check out another layer and their own layer at other times. Every fault
class the samples inject is contained in-process: access violation, divide by
zero, stack overflow, C++ exception, error return. A hang or `abort()` ends the
process, and the crash journal then quarantines the plugin. All of this is
proven in `engine_plugins_tests` (180 assertions); crash cases run in a child
process through the `premation-plugins` tool. Engine wiring: `--plugins` /
`--plugin-journal` / `PREMATION_PLUGIN_PATH` start the host in
`premation-engine`, and Electron passes `<userData>/native-plugins`. The frame
builder completes plugin entries (`finish_native_frame`). The render glue
(`render_glue.cpp`) implements the graph's `NativeEffectHost`:
SMART_RENDER_GPU on the engine's device inside an error scope, otherwise read
back → CPU render → upload. New queries: `listPlugins` and `getEffectUi`, in
both engines. **Remaining:** the GPU path and the render glue are compiled
(against the pinned Dawn's headers) but not yet run on a GPU. Editor surfaces
for native plugins wait for D5, when `engine()` becomes the C++ engine. Export
parity needs F1.

---

## 6. How we keep the product working the whole way

- **Golden gate.** Every rendering step is compared frame by frame against
  the TypeScript reference; defaults flip only on parity.
- **Command replay.** Recorded editing sessions are replayed against both
  engines; documents, evaluated values and frames must match. This is the
  main safety net for phases B–F.
- **Flags.** The TS path stays selectable until its C++ replacement has been
  default for one release.
- **Sanitizers and fuzzing.** Every protocol message type is fuzzed; ASan,
  UBSan and TSan run on every push.
- **Real-app checks.** Each phase ends with the real Electron app driven end
  to end (the harness from phase A: isolated profile, CDP, crash injection).
- **Performance ratchet.** Benchmarks in CI, compared before/after in the
  same run when the machine is noisy.

---

## 7. Performance targets

| Measure | Target |
|---|---|
| Playback, 1080p comp, 100 layers with effects | full frame rate, GPU-bound |
| Scrub latency, 4K ProRes | ≤ 50 ms |
| Interactive property drag | gizmo same frame, rendered result ≤ 1 frame later |
| Export, 8 cores | ≥ 3× today's raw-pipe fps |
| RAM preview | bounded by the machine, not Chromium |
| Crash impact | engine restart with no data loss; export and editor isolated |

---

## 8. Risks

| Risk | Containment |
|---|---|
| Showing engine frames in the Electron viewport | C1 measures three routes before any port; frame copy alone is viable at 1080p |
| Two engines diverge during the move | Golden gate + command replay against both on every change |
| Phase B touches most of the UI | Done incrementally per panel, lint-enforced, no behaviour change intended |
| Moving document ownership breaks editing | Undo parity suite from phase A, flags, UI mirror kept until F2 |
| Memory bugs in native code | Sanitizers, fuzzing, process isolation, RAII rules |
| Cross-platform build breakage | One compiler family, vcpkg lockfile, all targets on every push (already running) |
| JavaScript plugins lack a runtime in the engine | G2 decided before G1 ships; texture round-trip meanwhile |
| The plan becomes a two-year rewrite with nothing shipped | Every step is flagged and merged; the product improves at D5, E1, F1 |

---

## 9. Timeline

| Months | Work | What users feel |
|---|---|---|
| 1 | A5, B1–B2, C1 | — |
| 2–3 | B3–B5, C2–C3 | automation API available |
| 4–5 | D1 | — |
| 5–8 | D2 + D3, D4 | float colour, OCIO |
| 8 | D5 | **fully native preview** |
| 8–10 | E1, E2 | smooth 4K and ProRes scrubbing; solid A/V sync |
| 10–12 | E3, E4 | fast text, real-time effects |
| 12–13 | F1, F2 | **native multi-frame export; UI holds no engine state** |
| 13–15 | G1, G2 | native plugins with GPU access |

Honest range: **14–18 months** for one team. D2 and B3 are the largest steps,
and C1 may change the viewport route.

---

## 10. Owner decisions (2026-09-22)

1. **Toolchain:** approved and installed — Clang 23 (clang-cl), CMake 4.4,
   Ninja, VS Build Tools C++ workload, vcpkg at the pinned baseline beside the
   repo. Future toolchain installs need no confirmation.
2. **Order:** phase B starts now in parallel with C1.
3. **Target and scope:** After Effects level, everything in this plan.
4. **Plugins:** an After Effects-style native SDK (G1); the JavaScript/WGSL
   plugin system is not ported (G2).
5. **Delivery:** all phases are built without stopping; local commits only on
   `native-core`; no push and no release until the full product is ready.
6. Still open, decided by measurement: the viewport route (C1).
