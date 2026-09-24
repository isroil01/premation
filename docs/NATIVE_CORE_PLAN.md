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

**B4 / B5 status (2026-09-24).** **B5 exit met** for everything the API
addresses: UI edits, AI turns (one gesture, origin `ai`), user scripts (a
sandboxed Worker speaking the protocol, one gesture, origin `script`) and now
the plugin verbs (compositions, properties, effect parameters, keyframes in
layer time, subtree delete; origin `plugin`) are engine commands, and a
recorded session of them replays into a fresh engine with a byte-identical
saved project (and an equal undo stack; `src/core/automation/commandLog.test.ts`).
What still writes around the engine is a NAMED fallback, counted by a new
ratchet (`npm run lint:automation-writes`: 133 sites — AI 92, plugins 41,
scripts 0); a recording that reaches one reports `writesAroundEngine > 0`, and
an AI turn that does commits as one snapshot entry (ENGINE_API.md §15.6). **B4**: the read ratchet is at 765 (from 852;
1543 before the panel work): engine wiring left the UI shell (expression
providers, timeline upkeep, the plugin write hook), and the rule stops counting
session state and camera-tool dispatch. What remains is listed by category with
reasons in `docs/B4_MIRROR.md` §5 — per-frame viewport reads (the mirror is
asynchronous) and the page renderer's inputs stay until C/D5; the rest are
ordinary panel conversions. UI writes stay at 0.

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

**C4 result (2026-09-23, audited and finished 2026-09-24):** Electron
32.1.2 → **44.4.5** (latest stable; Chromium 152, Node 24), pinned exactly
because `sharedTexture` is still experimental; electron-builder 24 → 26.15.3
(latest). The 33–44 breaking-change notes were walked against the code:
custom-scheme URL parsing (33, `localFileUrl.ts`), `console-message` details
on the event (35, render-tests harness), no `postinstall` download and
Node ≥ 22.12 (42, CI on Node 22), dialogs defaulting to Downloads (43,
`dialogDirs.ts`), better-sqlite3 13 (N-API). `protocol.handle` and
`WebContentsView`-era APIs were already in use (no `BrowserView`, no
`protocol.register*Protocol`), every window is `sandbox: true`, and 44's
32-bit/ANGLE/clipboard/`net.request` changes touch nothing here. The one
missed site was Electron 32's removal of `File.path`: two importers still
read it, so dropped files lost their origin path; they now use
`webUtils.getPathForFile` through the preload (`motionEditor.file.pathOf`,
`src/core/assets/local/diskPathOf.ts`). **Exit met** on the owner's machine
(render-tests green ×2, real-app export crash/retry/editor-killed, Render
Queue, route C in the real window). On a Linux/SwiftShader box, jest,
lint, tsc and e2e 11/11 (CLI hidden-window render included) pass; render-tests
there flag `ext-text-depth-300` (webgpu 2.55 %) and
`fill-opacity-zero-inner-shadow` (webgpu 3.61 % vs its 3.29 % ceiling)
identically on 44.4.3 and 44.4.5, so that is a host difference, not the
upgrade. Not re-blessed from that host. **Next upgrade:** sync `safeStorage`
(three vaults) is deprecated in 45 and removed in 46; move to the async
methods first. 46 also stops `utilityProcess.kill()` escalating to SIGKILL:
check that the native plugin host's kill still ends a hung plugin child.

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

**E4 progress (2026-09-24, branches `e4-effects`, `e4-more`).** `native/engine/src/effects`
(`engine_effects`, Skia- and GPU-free) holds C++ ports of **139 of the 166 CPU
effect passes** the bake chain runs — every pure buffer kernel; the 27 left
draw through Canvas2D (`applyCanvas2dEffect`,
`src/core/effects/canvas2dEffects.ts`); see `native/README.md` § CPU effect
kernels. Each is a port of its TS kernel operation for operation, including
JavaScript's store rounding (`Uint8ClampedArray` half-to-even, `Uint8Array` /
`Uint16Array` truncation, `Float32Array` rounding), V8's `Math` (`motion::jsmath`)
and the TS hashes' double arithmetic. Rows (or column strips) are split across a
`std::jthread` pool in a way that cannot change a byte. Where the TS scans a
window per pixel, the C++ uses algorithms that give the same result: sliding
integer sums, van Herk min / max, Huang running-median histograms, lattices
computed once. Where the TS sums floats, the C++ keeps the TS's order.
**Parity:** `nativeKernelCrossEngine.test.ts` writes
`native/engine/tests/data/effect_kernel_parity.json`: 359 cases over three
synthetic inputs, one of them > 512 px for the edge-aware blurs' budget proxy.
`engine_effects_tests` matches **every FNV-1a 64 exactly, on 1 thread and on
4**, with zero tolerance. Kernels whose TS arguments are resolved lists
(packed mask paths, brush trails, spines, `.cube` tables) take them as named
numeric arrays; kernels that stamp in sequence (dabs, particles, streaks)
replay the whole stamp list per row chunk, so every pixel sees the TS's order.

The plan's "28 Canvas2D-only effects" count predates GPU-port rounds 6–14.
Today `CANVAS2D_ONLY` (no WGSL, so it forces a bake) has **9** members. 7 of
them draw through Canvas2D; the other two, `path-stroke` and `scribble`, are pure
buffer kernels over the resolved mask paths and are ported. The other 157 passes run on the CPU only when a layer is baked
for another reason (interior styles, effect masks, fill opacity, paths), where
they are the WGSL's parity twins.

**Bench** (`premation-effects --bench` vs `tests/bench_effects_ts.mjs`, same
cases in `tests/data/effect_kernel_bench.json`, 1920×1080, best of N, TS and C++
interleaved per effect). Measured on a shared 4-vCPU container running other
jobs (Linux CPU pressure 10–85 % during the runs; a pure-compute parallel loop
scaled only 1.2× on 4 threads under that load). The thread column is therefore
a floor, not a scaling measurement. Summary:

- Median over the 139 effects: C++ on **1 thread is 2.2× the TS**, and on
  **4 threads 5.1×**. The range runs from 0.5× (Vignette, whose TS memoises its
  gain map across frames) to 80× (Median, now a running histogram instead of a
  sort).
- 107 of the 139 TS kernels take more than 41.7 ms (24 fps) on a 1080p layer.
  On 4 contended threads, 91 of the C++ ports are under 41.7 ms and 48 are not.
- Optimised without changing a byte (`e4-more`, interleaved A/B against the
  previous build, same session): Radial Fast Blur 4.8× on 1 thread (source
  column / row per tap tabulated, Bright / Dark gain a table of the byte sum),
  Drizzle 4.5× (drops culled per row and pixel by |vy| − ringR and
  |vx| − ringR, which `Math.hypot` never undercuts), Turbulent Displace 2.9× and
  Curl Noise 2.3× (per-row fbm with each octave's lattice corners reused along
  the row), Hex Tile 2.3× (candidate cells tabulated per column / row), Vector
  Blur 1.6× (integer tap sums, a vectorisable `Math.round`), CC Scatterize 1.2×
  on 1 thread and 2.1× on 4 (destinations in parallel, writes replayed in scan
  order). Shared by every kernel: V8's two-argument `Math.hypot` inlined
  (checked bit for bit against `motion::js::hypot`), `remap` copying a pixel
  that maps to its own centre, and `hash2`'s ToInt32 off the `fmod` path —
  Bulge, Liquify, Magnify, Smear, Mirror, Ripple Pulse and Cell Pattern gained
  1.7–2.8× from those alone.
- The slowest now are Deep Glow (1.3 s on 4 threads at radius 60: eight
  33-tap separable Float32 passes per octave, the TS order kept) and Energy
  Beam (0.9 s: per-pixel distance to 64 spine segments plus a 4-fbm curl), then
  Light Burst, Radial Blur, Cross Blur and Vector Blur at 150–230 ms. Deep Glow
  and Beam are candidates for a lower-precision twin behind the golden gate.
  Measuring the exit criterion ("no effect drops the bench comp below 24 fps")
  needs the chain wired into the engine first.

Ported, with parity (every row byte-identical) and ms per 1080p frame:

| effect | TS kernel | TS ms | C++ 1 thr ms | C++ 4 thr ms | ×TS (1 thr) | ×TS (4 thr) |
|---|---|--:|--:|--:|--:|--:|
| `gaussian-blur` | `blurs.ts` | 249 | 112 | 56.0 | 2.2 | 4.4 |
| `fast-box-blur` | `blurs.ts` | 116 | 56.9 | 33.2 | 2.0 | 3.5 |
| `radial-blur` | `blurs.ts` | 1833 | 480 | 172 | 3.8 | 10.7 |
| `channel-blur` | `blurs.ts` | 1275 | 50.1 | 28.0 | 25.4 | 45.5 |
| `unsharp-mask` | `blurs.ts` | 282 | 129 | 64.8 | 2.2 | 4.3 |
| `sharpen` | `canvas2dEffects.ts` | 50.4 | 18.4 | 7.4 | 2.7 | 6.8 |
| `noise` | `canvas2dEffects.ts` | 54.2 | 23.4 | 8.9 | 2.3 | 6.1 |
| `add-grain` | `noiseEffects.ts` | 355 | 177 | 64.3 | 2.0 | 5.5 |
| `turbulent-noise` | `noiseEffects.ts` | 639 | 324 | 117 | 2.0 | 5.5 |
| `median` | `noiseEffects.ts` | 17022 | 212 | 72.8 | 80.3 | 233.7 |
| `minimax` | `keyingEffects.ts` | 1939 | 98.5 | 38.9 | 19.7 | 49.9 |
| `simple-choker` | `keyingEffects.ts` | 146 | 18.7 | 7.2 | 7.8 | 20.3 |
| `mosaic` | `stylize.ts` | 18.9 | 6.6 | 3.2 | 2.8 | 5.9 |
| `find-edges` | `stylize.ts` | 427 | 31.7 | 13.1 | 13.5 | 32.7 |
| `emboss` | `stylize.ts` | 87.4 | 57.0 | 23.7 | 1.5 | 3.7 |
| `vibrance` | `colorEffects.ts` | 23.1 | 21.3 | 7.7 | 1.1 | 3.0 |
| `bilateral-blur` | `aeBlurAdvanced.ts` | 159 | 82.3 | 38.1 | 1.9 | 4.2 |
| `smart-blur` | `aeBlurAdvanced.ts` | 165 | 79.7 | 34.9 | 2.1 | 4.7 |
| `camera-lens-blur` | `aeBlurAdvanced.ts` | 164 | 82.0 | 37.3 | 2.0 | 4.4 |
| `photo-filter` | `aeColor.ts` | 28.0 | 22.8 | 8.6 | 1.2 | 3.3 |
| `black-and-white` | `aeColor.ts` | 68.8 | 47.2 | 18.1 | 1.5 | 3.8 |
| `tritone` | `aeColor.ts` | 35.9 | 25.4 | 9.8 | 1.4 | 3.6 |
| `threshold` | `aeColor.ts` | 8.4 | 5.3 | 1.7 | 1.6 | 4.9 |
| `selective-color` | `toneEffects.ts` | 67.7 | 32.6 | 12.5 | 2.1 | 5.4 |
| `shadow-highlight` | `toneEffects.ts` | 183 | 134 | 63.9 | 1.4 | 2.9 |
| `colorama` | `colorEffects.ts` | 137 | 39.6 | 14.7 | 3.5 | 9.3 |
| `keylight` | `keylight.ts` | 239 | 59.4 | 24.1 | 4.0 | 9.9 |
| `linear-color-key` | `keyingEffects.ts` | 75.3 | 27.8 | 9.9 | 2.7 | 7.6 |
| `luma-key` | `keyingEffects.ts` | 30.4 | 9.7 | 3.6 | 3.1 | 8.4 |
| `shift-channels` | `keyingEffects.ts` | 39.3 | 11.2 | 4.0 | 3.5 | 9.9 |
| `color-key` | `aeKeyingAdvanced.ts` | 22.1 | 10.9 | 4.0 | 2.0 | 5.6 |
| `color-range` | `aeKeyingAdvanced.ts` | 45.3 | 15.9 | 6.1 | 2.8 | 7.5 |
| `extract` | `aeKeyingAdvanced.ts` | 24.7 | 16.4 | 6.0 | 1.5 | 4.1 |
| `spill-suppressor` | `aeKeyingAdvanced.ts` | 92.0 | 48.4 | 19.7 | 1.9 | 4.7 |
| `matte-choker` | `aeKeyingAdvanced.ts` | 656 | 96.8 | 54.8 | 6.8 | 12.0 |
| `bulge` | `distort.ts` | 290 | 95.7 | 36.8 | 3.0 | 7.9 |
| `spherize` | `distort.ts` | 342 | 130 | 46.3 | 2.6 | 7.4 |
| `twirl` | `distort.ts` | 332 | 115 | 42.9 | 2.9 | 7.7 |
| `corner-pin` | `distort.ts` | 186 | 72.2 | 27.3 | 2.6 | 6.8 |
| `polar-coordinates` | `distort.ts` | 353 | 169 | 61.9 | 2.1 | 5.7 |
| `mirror` | `distort.ts` | 210 | 64.2 | 24.9 | 3.3 | 8.4 |
| `offset` | `distort.ts` | 1323 | 200 | 76.0 | 6.6 | 17.4 |
| `optics-compensation` | `distort.ts` | 320 | 147 | 52.9 | 2.2 | 6.0 |
| `mesh-warp` | `distort.ts` | 280 | 136 | 48.5 | 2.1 | 5.8 |
| `liquify` | `distort.ts` | 283 | 90.2 | 33.3 | 3.1 | 8.5 |
| `equalize` | `aeColorAdvanced.ts` | 22.8 | 13.4 | 4.9 | 1.7 | 4.7 |
| `auto-levels` | `aeColorAdvanced.ts` | 23.8 | 13.4 | 5.0 | 1.8 | 4.7 |
| `auto-contrast` | `aeColorAdvanced.ts` | 22.3 | 13.4 | 5.1 | 1.7 | 4.4 |
| `auto-color` | `aeColorAdvanced.ts` | 24.0 | 13.4 | 4.9 | 1.8 | 4.9 |
| `change-color` | `aeColorAdvanced.ts` | 121 | 62.6 | 22.5 | 1.9 | 5.4 |
| `change-to-color` | `aeColorAdvanced.ts` | 112 | 54.5 | 19.0 | 2.1 | 5.9 |
| `leave-color` | `aeColorAdvanced.ts` | 76.3 | 42.1 | 15.6 | 1.8 | 4.9 |
| `toner` | `aeColorAdvanced.ts` | 25.8 | 22.6 | 8.5 | 1.1 | 3.0 |
| `venetian-blinds` | `transitions.ts` | 37.9 | 24.3 | 9.2 | 1.6 | 4.1 |
| `gradient-wipe` | `transitions.ts` | 31.0 | 6.0 | 4.2 | 5.2 | 7.4 |
| `card-wipe` | `transitions.ts` | 92.0 | 39.0 | 14.8 | 2.4 | 6.2 |
| `radial-wipe` | `transitions.ts` | 104 | 48.3 | 17.1 | 2.1 | 6.1 |
| `block-dissolve` | `transitions.ts` | 27.5 | 12.7 | 4.8 | 2.2 | 5.8 |
| `alpha-levels` | `aeChannel.ts` | 2.4 | 0.7 | 0.5 | 3.3 | 4.4 |
| `solid-composite` | `aeChannel.ts` | 40.5 | 26.2 | 10.3 | 1.5 | 3.9 |
| `channel-combiner` | `aeChannel.ts` | 70.2 | 30.3 | 15.2 | 2.3 | 4.6 |
| `remove-color-matting` | `aeChannel.ts` | 14.6 | 6.8 | 2.5 | 2.1 | 5.8 |
| `cartoon` | `aeStylizeAdvanced.ts` | 460 | 245 | 93.6 | 1.9 | 4.9 |
| `brush-strokes` | `aeStylizeAdvanced.ts` | 475 | 329 | 117 | 1.4 | 4.1 |
| `strobe-light` | `aeStylizeAdvanced.ts` | 15.9 | 9.0 | 3.5 | 1.8 | 4.6 |
| `color-emboss` | `aeStylizeAdvanced.ts` | 59.7 | 26.2 | 10.2 | 2.3 | 5.9 |
| `halftone` | `aeStylizeAdvanced.ts` | 237 | 87.5 | 46.9 | 2.7 | 5.1 |
| `kaleidoscope` | `aeStylizeAdvanced.ts` | 438 | 256 | 88.2 | 1.7 | 5.0 |
| `vignette` | `aeStylizeAdvanced.ts` | 12.6 | 27.3 | 10.0 | 0.5 | 1.3 |
| `burn-film` | `aeStylizeAdvanced.ts` | 187 | 100 | 36.7 | 1.9 | 5.1 |
| `iris-wipe` | `aeTransitionsAdvanced.ts` | 169 | 81.4 | 28.8 | 2.1 | 5.9 |
| `light-wipe` | `aeTransitionsAdvanced.ts` | 27.6 | 15.5 | 5.5 | 1.8 | 5.0 |
| `line-sweep` | `aeTransitionsAdvanced.ts` | 27.2 | 28.6 | 10.6 | 1.0 | 2.6 |
| `grid-wipe` | `aeTransitionsAdvanced.ts` | 56.3 | 57.3 | 20.8 | 1.0 | 2.7 |
| `dust-scratches` | `aeTransitionsAdvanced.ts` | 8867 | 140 | 52.9 | 63.2 | 167.7 |
| `noise-alpha` | `aeTransitionsAdvanced.ts` | 31.4 | 31.6 | 11.5 | 1.0 | 2.7 |
| `wave-warp` | `warp.ts` | 178 | 135 | 48.0 | 1.3 | 3.7 |
| `turbulent-displace` | `warp.ts` | 507 | 176 | 95.7 | 2.9 | 5.3 |
| `curl-noise` | `warp.ts` | 846 | 124 | 66.8 | 6.8 | 12.7 |
| `roughen-edges` | `stylize.ts` | 188 | 153 | 112 | 1.2 | 1.7 |
| `scatter` | `stylize.ts` | 137 | 44.9 | 27.5 | 3.1 | 5.0 |
| `ripple` | `aeDistortAdvanced.ts` | 430 | 231 | 83.7 | 1.9 | 5.1 |
| `magnify` | `aeDistortAdvanced.ts` | 263 | 79.3 | 28.0 | 3.3 | 9.4 |
| `warp` | `aeDistortAdvanced.ts` | 299 | 161 | 56.1 | 1.9 | 5.3 |
| `page-turn` | `aeDistortAdvanced.ts` | 63.9 | 29.2 | 11.2 | 2.2 | 5.7 |
| `split` | `aeDistortAdvanced.ts` | 200 | 83.2 | 28.9 | 2.4 | 6.9 |
| `slant` | `aeDistortAdvanced.ts` | 199 | 73.0 | 24.7 | 2.7 | 8.1 |
| `smear` | `aeDistortAdvanced.ts` | 292 | 88.3 | 32.1 | 3.3 | 9.1 |
| `rolling-shutter` | `aeDistortAdvanced.ts` | 237 | 132 | 47.6 | 1.8 | 5.0 |
| `radial-shadow` | `aeDistortAdvanced.ts` | 159 | 75.8 | 31.8 | 2.1 | 5.0 |
| `color-difference-key` | `aeRoundSevenColor.ts` | 183 | 106 | 38.1 | 1.7 | 4.8 |
| `wire-removal` | `aeRoundSevenColor.ts` | 13.4 | 5.9 | 2.9 | 2.3 | 4.6 |
| `broadcast-colors` | `aeRoundSevenColor.ts` | 100 | 34.8 | 12.5 | 2.9 | 8.0 |
| `noise-hls` | `aeRoundSevenColor.ts` | 273 | 195 | 124 | 1.4 | 2.2 |
| `block-load` | `aeRoundSevenStylize.ts` | 22.4 | 7.8 | 4.5 | 2.9 | 5.0 |
| `kernel` | `aeRoundSevenStylize.ts` | 237 | 107 | 61.1 | 2.2 | 3.9 |
| `3d-glasses` | `aeRoundSevenStylize.ts` | 105 | 20.2 | 7.9 | 5.2 | 13.4 |
| `fractal` | `aeRoundSevenStylize.ts` | 465 | 242 | 120 | 1.9 | 3.9 |
| `unmult` | `aeRoundSix.ts` | 54.7 | 28.9 | 15.3 | 1.9 | 3.6 |
| `cc-composite` | `aeRoundSix.ts` | 49.2 | 25.4 | 17.6 | 1.9 | 2.8 |
| `cc-scatterize` | `aeRoundSix.ts` | 278 | 146 | 84.4 | 1.9 | 3.3 |
| `radial-fast-blur` | `aeRoundSix.ts` | 1059 | 108 | 55.9 | 9.8 | 18.9 |
| `cross-blur` | `aeRoundSix.ts` | 708 | 314 | 161 | 2.3 | 4.4 |
| `scale-wipe` | `aeRoundSix.ts` | 253 | 105 | 51.9 | 2.4 | 4.9 |
| `plastic` | `aeRoundSix.ts` | 555 | 197 | 111 | 2.8 | 5.0 |
| `glass` | `aeStylizeRoundFive.ts` | 463 | 197 | 107 | 2.4 | 4.3 |
| `texturize` | `aeStylizeRoundFive.ts` | 222 | 186 | 90.7 | 1.2 | 2.4 |
| `threads` | `aeStylizeRoundFive.ts` | 70.9 | 48.5 | 25.6 | 1.5 | 2.8 |
| `chromatic-aberration` | `aeStylizeRoundFive.ts` | 582 | 247 | 120 | 2.4 | 4.9 |
| `hex-tile` | `aeStylizeRoundFive.ts` | 127 | 60.1 | 17.1 | 2.1 | 7.4 |
| `vector-blur` | `aeStylizeRoundFive.ts` | 788 | 288 | 153 | 2.7 | 5.2 |
| `flo-motion` | `aeDistortRoundFive.ts` | 329 | 181 | 72.3 | 1.8 | 4.6 |
| `lens` | `aeDistortRoundFive.ts` | 138 | 48.9 | 26.7 | 2.8 | 5.2 |
| `griddler` | `aeDistortRoundFive.ts` | 195 | 96.0 | 48.9 | 2.0 | 4.0 |
| `ball-action` | `aeDistortRoundFive.ts` | 206 | 94.4 | 72.0 | 2.2 | 2.9 |
| `drizzle` | `aeDistortRoundFive.ts` | 1362 | 76.1 | 47.1 | 17.9 | 28.9 |
| `jaws` | `aeTransitionsRoundFive.ts` | 116 | 93.9 | 37.7 | 1.2 | 3.1 |
| `pixel-polly` | `aeTransitionsRoundFive.ts` | 56.6 | 34.6 | 12.7 | 1.6 | 4.4 |
| `twister` | `aeTransitionsRoundFive.ts` | 50.2 | 28.5 | 12.4 | 1.8 | 4.0 |
| `card-dance` | `aeTransitionsRoundFive.ts` | 41.9 | 32.6 | 15.6 | 1.3 | 2.7 |
| `path-stroke` | `pathStroke.ts` | 116 | 34.7 | 26.3 | 3.3 | 4.4 |
| `scribble` | `scribble.ts` | 134 | 39.7 | 37.0 | 3.4 | 3.6 |
| `write-on` | `writeOnBrush.ts` | 74.0 | 23.8 | 22.2 | 3.1 | 3.3 |
| `star-burst` | `generateRoundFive.ts` | 23.1 | 15.6 | 11.5 | 1.5 | 2.0 |
| `snowfall` | `generateRoundFive.ts` | 17.7 | 2.6 | 1.7 | 6.8 | 10.4 |
| `rainfall` | `generateRoundFive.ts` | 9.5 | 1.0 | 2.5 | 9.5 | 3.8 |
| `light-burst` | `generateRoundFive.ts` | 1034 | 676 | 233 | 1.5 | 4.4 |
| `cc-tiler` | `aeRoundSevenDistort.ts` | 344 | 137 | 47.3 | 2.5 | 7.3 |
| `ripple-pulse` | `aeRoundSevenDistort.ts` | 466 | 56.0 | 23.8 | 8.3 | 19.6 |
| `radial-scale-wipe` | `aeRoundSevenDistort.ts` | 174 | 49.0 | 20.3 | 3.6 | 8.6 |
| `glass-wipe` | `aeRoundSevenDistort.ts` | 428 | 110 | 40.9 | 3.9 | 10.5 |
| `image-wipe` | `aeRoundSevenDistort.ts` | 57.4 | 17.2 | 6.3 | 3.3 | 9.1 |
| `particle-systems` | `aeRoundSevenSimulation.ts` | 14.7 | 1.6 | 0.8 | 9.2 | 18.4 |
| `cc-bubbles` | `aeRoundSevenSimulation.ts` | 38.1 | 9.2 | 3.6 | 4.1 | 10.6 |
| `bezier-warp` | `bezierWarp.ts` | 1926 | 296 | 109 | 6.5 | 17.7 |
| `cell-pattern` | `generatePatterns.ts` | 803 | 224 | 88.4 | 3.6 | 9.1 |
| `apply-color-lut` | `cubeLut.ts` | 223 | 78.3 | 29.8 | 2.8 | 7.5 |
| `deep-glow` | `deepGlow.ts` | 7398 | 2730 | 1287 | 2.7 | 5.7 |
| `beam-path` | `beamPath.ts` | 13728 | 2578 | 934 | 5.3 | 14.7 |

Not ported (27) — all draw through Canvas2D and need the E3 `raster::Canvas`
in the chain before they can move:

| status | effects (`applyCanvas2dEffect` cases) |
|---|---|
| **Forces a bake today** (`CANVAS2D_ONLY`, no WGSL) | `vegas`, `numbers`, `timecode`, `audio-spectrum`, `audio-waveform`, `lightning`, `plexus` |
| Canvas-drawn (gradients, `drawImage` compositing, `ctx.filter` blurs) | `fill`, `stroke`, `four-color-gradient`, `inner-shadow`, `inner-glow`, `satin`, `bevel`, `directional-blur`, `linear-wipe`, `transform`, `beam`, `lens-flare`, `light-rays`, `light-sweep`, `checkerboard`, `grid`, `circle`, `ellipse`, `radio-waves`, `cc-repetile` |

Open work for E4:
- **Wire the chain.** Map each effect's params onto its kernel arguments (the
  TS `apply*` wrappers), and interleave the kernels with the canvas-drawn
  passes, masks, fill opacity and interior styles. `layer_is_baked` layers then
  render through `engine_effects` instead of being reported as unported by
  `frame_build.cpp`, and the golden gate runs on whole frames.
- The 27 canvas-drawn effects (above, after E3's canvas lands in the chain),
  and the non-effect CPU bake sites in
  `src/core/rendering` (`pixelMotion*`, `deinterlace`, `channelView`,
  `frameTap`, `AppTextureProvider`'s read-backs).
- Toolchain not checked here: clang-tidy (CI runs it on `native/libs` only),
  the sanitizers (this container has no compiler-rt runtime, which also stops
  `engine_fuzz` from linking), MSVC / clang-cl and WASM builds.

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
