# Premation engine plan — Electron UI, C++ engine

> **Final plan, 2026-09-22.** Branch `native-core`. This document replaces the
> earlier drafts (see git history for them). It records the architecture the
> product owner decided, what is already built, and the order in which the
> rest gets built. Every step shipped behind a flag with the TypeScript
> engine as the fallback, so the product kept shipping the whole way.
> **Superseded 2026-09-28 (`docs/TS_ENGINE_REMOVAL.md`): one engine.** The
> flags and fallbacks are gone, the C++ engine always owns the document, and
> since 2026-10-03 the page keeps no replica of it; what is left of the
> TypeScript engine serves the jest harness and the headless window only and is
> being deleted.

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
ordinary panel conversions. UI writes stay at 0. **B4-more: 681** (timeline
69 → 23, inspector 112 → 107, comps/dialogs 61 → 50, commands 66 → 54, other
135 → 126, layers 41 → 40): transport goes through `timelineView`; the work
area, markers, transitions, the motion-blur master and `CompSettings.pristine`
(now reported by both engines) come from the mirror; the timeline's row menus
read the mirror and send `setExpression`; autosave / thumbnails wake on the
mirror's `doc` key. **The B4 exit is met for the Inspector and the timeline**:
every remaining read there is an engine job, the transport pump, or a named
API gap with what closes it (B4_MIRROR.md §5, "The B4 exit").

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
**Both done (2026-09-28):** the three vaults use the async safeStorage API
(`electron/vaultCrypto.ts`; a vault the sync API wrote is read once through it
and rewritten), and the native plugin host force-kills a child that survives
`kill()` for 2 s (`endProcess`, only while `pid` is still defined).

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

**C platform plumbing (2026-09-28, branch platform-plumbing — Phase 0/2 of
TS_ENGINE_REMOVAL.md).**
- *Routes off Windows.* `PREMATION_VIEWPORT_ROUTE=copy` makes main offer only
  `frames.copy`: route A measured in the real app on the RTX 4060 box —
  bench.json 29.9 fps, latency p50 11.5 ms (route C 30.0 / 10.8). Linux dmabuf
  route C written (`shared_texture_ffi_linux.cpp`: LINEAR ABGR8888 GBM buffers
  on Chromium's render node → `SharedTextureMemoryDmaBuf` + SyncFD fences;
  `FrameSlots.strides/offsets/sizes/modifier`; main duplicates the engine's fds
  with `pidfd_getfd` through the Linux `premation-host-bridge.node` and imports
  `nativePixmap`). Built only where CMake finds GBM; unverified.
- *Multiple viewports.* Each `setViewport` id is its own surface: the Session
  renders every open viewport per tick (each with its own camera), the render
  thread keeps one ring per viewport (generations unique, round-robin service,
  device loss rebuilds all), `closeViewport` announces an empty ring. Main maps
  a viewport to the window that set it (`peekRequest` of setViewport), sends its
  frames there, and keeps receivers / in-flight transfers / route-A copies per
  window. A window's ids start at `engine:viewportBase` (0 in the editor,
  webContents id × 256 in a pop-out). Real app: editor + popped-out Viewport
  both drawn by the engine at ~30 fps, on route C and on route A.
- *CI / release.* render-tests.yml gains `native-golden` (Windows, WARP) on the
  shared build-engine action; the no-engine packaging hatch is refused in CI.
- *Session footage.* `FilePorts` imports (ffmpeg probe; bytes → content-addressed
  cache files in `<userData>/session-footage`); `doc::asset_media_src` reads a
  record's file when its src is a session URL.

### Phase D — Rendering in C++

| Step | What | Exit | Size |
|---|---|---|---|
| D1 | Document, evaluation, expressions, parenting and time remap in C++, fed by commands | Replayed sessions produce identical evaluated values to the TS engine | 8 wk |
| D2 | Render graph and passes on Dawn, reusing every WGSL shader; 2D, masks, mattes, blend modes, motion blur, precomps, 3D, lights, shadows, DOF | Golden gate: all frames match the TS reference within existing ceilings | 12–16 wk |
| D3 | Float linear colour with OCIO, working-space and display transforms, 16/32-bit export | Colour test charts match OCIO reference transforms; 8-bit output unchanged | 4 wk, alongside D2 |
| D4 | RAM and disk frame cache in the engine, sized by the machine, not by Chromium's heap | Cached playback of a heavy comp holds full rate | 3 wk |
| D5 | Engine viewport default-on; the TS renderer stays behind the flag for one release | HUD frame time ≤ TS path on every bench comp | 2 wk |

**D1 progress (2026-09-24): the replay corpus evaluates identically in both
engines — 0 differences in 17 491 compared records, from 520.** A new gate
measures D1's exit directly, in process, with no engine binary and no Dawn:
`src/core/engine/__tests__/d1EvalParity.test.ts` runs every corpus session
(B2 + family + generated, 61 sessions) on the TypeScript engine, records every
request and response, then PROBES the finished document — every layer's
property tree, every numeric property evaluated at 8 composition times
(before 0, on and between frames, past the end) and pre-expression, the world
transforms of every stack (parenting), motion paths, 31-point samples with
speed of every keyed or expressed property, and all keyframes.
`native/engine/tests/test_d1_eval_parity.cpp` (`engine_d1_parity_tests`)
replays the same bytes into a C++ `Session` and compares every response byte
for byte (refusals by error code) and every revision step; ratchet 0.
Fixture `tests/data/d1_eval_parity.bin` (3.9 MB: large answers stored as
length + hash, repeated probes as deltas; frozen data since phase 1 of
TS_ENGINE_REMOVAL, `PARITY_REBLESS=1` re-blesses it from C++). Two new corpus
sessions: *D1: evaluation* (a three-deep parent chain through a null with
spatial Bézier / eased / hold / roving keys, a 3D sub-chain with orientation
and axis rotations under a camera, toComp / toWorld / valueAtTime / velocity /
loopOut / seedRandom / posterizeTime expressions across layers, stretch, time
remap keys, reverse, freeze, a remapped precomp) and *B3z: plugin properties*.
- **Measured gap before → after.** First run: 520 of 17 177 records differed
  (358 probes; 17 of 59 sessions identical). Now: 0 of 17 491 (61/61
  sessions). The cross-engine process replay (`crossEngine.test.ts`) against
  `premation-engine-headless` (new: the engine process without Dawn, frames
  simulated — `PREMATION_ENGINE_PATH`): 62/62 sessions, 10 539 requests
  compared, **0 answered `unsupported`**, 0 dependent, 0 mismatches (first run:
  54/60 — two 120 s timeouts on a loaded machine, now 600 s, and four
  harness faults fixed below).
- **C++ fixes** (each was a wrong evaluated value or step): material switches
  (Accepts Lights / Casts / Accepts Shadows) read and write as the TS
  `readMaterialSwitch` (every 3D layer's Accepts Lights read 0); two dangling
  references to by-value temporaries in `strokes.cpp` (every shape-stroke
  colour read #ffffff, every stroke gradient point 0); `sampleProperty` speed
  through V8's `Math.hypot`; new keyframe ids minted in the order the command
  touched the layers, not by id; plugin properties wired — `plugin_props.cpp`
  (ported, never compiled) now builds the `plugin/<name>` and
  `plugin/<slug>/<panel>/<param>` bindings, statics, fields and panel groups
  (add / remove / every refusal); a pasted group member's bar no longer
  outlives the command (`write_geoms` marks it for the reconcile — was an
  extra `compositionChanged`); saved documents no longer carry editor state
  (`openTabs`, a timeline's `view` / `currentFrame` — B4 removed them from the
  TS save; the C++ file was ~300 bytes larger, now equal except the TS's
  random track id).
- **TypeScript fixes:** `loadDocument` dropped the load's own pending debounced
  snapshot, which became a phantom "Edit N" undo step under the next command
  after every open / revert; test ports count saved UTF-8 bytes like the real
  port; the WS-L1 session holds the harness engine's write detector during
  off-document builds; `crossEngine.test.ts` clones request bytes from any
  realm (a pasted fragment was cloned as an object), counts history pushes
  that do not move the revision, and sends an undo/redo the model has no
  entry for (both engines must refuse it).
- **Remaining for D1:** the render-side evaluation — the engine producing its
  own FrameScene from the C++ document (`scene/snapshot_build`, buildSnapshot's
  port) — is gated by the D2 golden suite, not by this fixture, and still
  reported paragraph text's Fit Text to Box and CJK line breaking until the
  d2w-round2 port (2026-09-27, below). Shape operators were already built
  (`path_ops`, nothing reports them); image-layer rig culling and 3D
  `getLayerTransforms` landed 2026-09-26 (see "D2w leftovers, d2w-cpp-ports"
  below); the corpus
  has no session for footage decode-dependent values (E1) or audio-driven
  expressions (E2); 12 of 114 edit commands are never issued by the corpus
  (`restoreDocument`, `importBytes`, `clearWorkArea`, `timeStretchLayers`,
  `unfreezeLayers`, `rippleDeleteRange`, `shiftLayerKeyframes`, the three
  transition commands, `editPathTopology`, `setShapeOutline`), so their parity
  is unmeasured; saveProject's byte count is compared by path only (the TS
  track id is random).

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
Every shader and material was extracted verbatim from packages/renderer and is
now C++-owned data (`shaders/wgsl/*.wgsl` + `shaders/materials.json`, 207
shaders, 211 materials, embedded by `shaders/embed_wgsl.cmake`).
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

**D2w 3D (2026-09-25): 3D layers and lights build from the C++ document.**
The scene builder no longer reports "3D layers" / "light layers". The work is
in new files beside `snapshot_build` / `frame_build`, which only call hooks:
- `camera3d_port` / `lights3d` / `env_light` (in `engine_scene_core`, pure):
  DOF (legacy ramp and thin-lens, iris, planar CoC corners), Material Options,
  light props / falloff / reach, per-quad Lambert, shader lights, and the
  environment light's SH rig plus its prefiltered reflection atlas.
- `threed_port` (Scene3D): the view camera (active, `camera:<id>`, ortho,
  custom) with the parent lift, `parentWorld3d`, `affineAt` (orientation and
  rotation summed per axis, anchor Z, scale Z, toward-camera), the near-plane
  drop, camera motion blur, DOF effects, shading / shade3d, shadow lights
  (a budget of two maps), the 2D drop-shadow twin, the form rig, washes, landed
  beams, projected caster shadows and their splice, the run-bounded depth sort,
  and the extrusion / primitive mesh carriers (including the gradient paint
  plate) with the front quad inset, mesh-drawn or planar-DOF.
- `threed_frame`: `model3dFor`, mesh placement, castsShadow, per-fragment shade
  vs the tint fold, `lightToRenderable`, `enforceExtrusionPathAgreement` /
  `dropMeshes*`, and camera3d / lights3d / envMap / ssao.
- `light_wash`: `rasterizeLight` on the C++ Canvas2D.

`threeDCrossEngine.test.ts` → `threed_parity.json` pins the pure ports
bit-exact (2644 assertions). `premation-scene`'s structural diff now covers
threeD, the mesh key, camera3d, lights3d, ssao and envMap.

On the 52 golden frames that fell back on 3D or lights, 47 are now ported, and
all 47 are pixel-equal to the webgpu frame (0.000%, except
ext-mesh-rounded-concave at 0.005% and ext-mesh-text-styled at 0.411%). That
count needs the harness fix in the same change: scene projects are exported at
`CURRENT_DOCUMENT_VERSION`. At the old '1.1.0' label, the 1.7→1.8 migration
stamped every light `falloff: 'legacy'`, and the shadow-map-* and lit-primitive
frames failed until the next full run re-exports them.

**Remaining:** glTF models (the model registry, and footage that is a `blob:`
URL); height-map displacement; the extrusion fallbacks (the slice stack and
geometric faces, only reached when an outline cannot be traced); per-character
3D text; image (`asset:`) environment skies; sealed-precomp 3D scopes, which
wait on composition instances; corner pin on 3D layers.

**D2w 3D leftovers (2026-09-25): glTF models, height displacement, image skies,
corner pin and overlay-styled walls now build from the C++ document.** Each
port lives in its own new file. `snapshot_build` / `frame_build` only gained hook
calls. Every port is pinned byte for byte by a cross-engine fixture generated
from the editor's own code:
- `gltf_model` ports parseGltf and modelMesh.ts: GLB and embedded .gltf,
  strided / sparse / normalized accessors, generated normals and indices, and
  the Draco refusal with the TS message. It also ports modelKeyForBytes and
  primitiveToEntry. The model registry resolves a leaf through the Model
  component that carries the document's `glbData`. The carrier is built with
  its PBR map keys, and every model image is fed from the file itself
  (`gltf:<key>#<n>`, `scene_textures_model`). Fixture: `gltf_model_parity.json`,
  5 files including the goldens' GLBs. Morph targets and skinning are reported,
  not applied.
- `height_displacement` ports heightDisplacement.ts. Its fixture is
  `height_displacement_parity.json`, 9 cases including the golden's exact mesh
  and field. `mesh_displacement` applies it to primitive, extrusion and model
  carriers. It decodes the field from the asset or `heightMapSrc`: drawn
  through the Canvas2D to at most 256 px, then read as luma.
- `env_asset` handles `asset:` skies: decode, draw to at most 1024 px wide,
  `resampleEquirect`, SH9, and the reflection atlas under
  `asset:<id>#<hashEnvPixels>` (`env_asset_parity.json`). It mirrors the TS
  fallback to 'studio'. An EXR sky projects its linear float planes
  (`exr_read`, d2w-round2) from the .exr file.
- `corner_pin` ports readNodeCornerPin, resolveCornerPin and Homography.ts. A
  pinned 3D layer stays on the 2D pinned path (`corner_pin_parity.json`).
- `styled_surface` ports styledSurfaceFill for extrusion walls under a Colour /
  Gradient Overlay (`styled_surface_parity.json`).

`test_threed_models` builds all four features end to end from a document.

Quick loop (`--tag threed2`, 436 frames, RTX 4060): 416 ported / 411 within
tolerance / 129 bit-identical before and after, so nothing regressed. The 3
3D frames still fall back, and they now name the actual gap. The model-maps
pair's documents carry no file: the harness registered the model in memory.
The displaced sphere's field is primed in memory (`prime:bumps`). With the GLB
injected as `glbData`, premation-scene builds both model-maps frames
structurally equal to the TS FrameScene, with every model texture byte-equal
and 0 differing pixels against webgpu. `harness/scenes/modelMaps.ts` now stores
`glbData` the way the importer does, so the next full run exports it and the
pair ports. The displaced sphere stays pinned by the fixture only; porting that
golden needs an image-backed field, which means re-blessing it.
**Ported 2026-09-28:** the golden's field is now an 8-bit grey PNG `data:` URL in
the document (`harness/scenes/bumpsField.data.ts`; the harness primes the page's
cache with the same rounded bytes under that key). The engine decodes it and the
frame matches the unchanged reference within the scene tolerance (no re-bless:
rounding the field to bytes moves a vertex by ≤ 0.04 px).

**Remaining:** none of the 3D leftovers (EXR skies landed in d2w-round2). Per-character 3D text, the extrusion slice stack and
geometric faces, and glTF morph targets / skinning landed 2026-09-26 ("D2w
leftovers, d2w-cpp-ports" below). Sealed-precomp 3D scopes landed with
composition instances (D2w time/comp: `comp_instance`'s `precompScene3d`).

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
16/32-bit export (F*). The C++ document already produces `colorManagement`
(`scene/color_settings.cpp`: Project Settings ▸ Working Space + OCIO config,
the viewer's display transform, the output module's space; unmanaged exactly
where the TS pipeline renders itself) and every texture's `inputSpace`
(`scene_textures.cpp`: footage by its H.273 tags, stills and authored rasters
as sRGB, masks / LUT strips untagged); what the vocabulary cannot express
(Display P3 working space, PQ / HLG viewers) stays unmanaged with a frame note.

**D2w effects (2026-09-25): baked layers, colour LUTs and the paint effects
render from the C++ document, on the E4 chain.** `native/engine/src/scene`:
`bake_chain.cpp` (Canvas2DVectorRasterizer's bake branch: the layer mask as a
matte over the padded raster, the stack resolved with `params_of` and px-scaled
by `scaleEffectLengths`, handed to `effects::apply_effect_chain` — THE chain,
`effect_chain_parity.json` — through a BakeHook on `draw_raster_source`;
`bakedEffectSpread` pads the raster), `lut_port.cpp` (the `lut:<id>` 256×1 and
`cubelut:<id>` slice strips as builder-computed textures, `TexKind::pixels`,
byte-identical to the TS uploads, from the chain's per-effect tables; the
apply-color-lut entry; uniform fills graded through the strip) and
`effect_handoff.cpp` (buildSnapshot's packed mask geometry / `pathMaskIndex` /
`pathPoints` / `wiggleState`); D4's content key hashes the pixels textures.
Raster side: `css::parse_filter_list` → SkImageFilters (the chain's batched CSS
effects draw instead of being reported), accelerated canvases blur with Skia's
shader algorithm as Chromium's GPU canvas does (the bake canvas stays
willReadFrequently), a float16 canvas for Plexus. Parity:
`nativeBakeChainCrossEngine.test.ts` → `bake_chain_parity.json` →
`test_bake_chain.cpp` pins the scene side over the chain (9/9 whole bakes,
2366/2366 Canvas2D ops, every putImageData the same bytes, on real pixels);
`effect_chain_parity` 606/606. It found a TS bug the chain's port reproduced:
applyStroke's pooled `stroke-inner` context kept `destination-out`, so every
inside / centre Stroke after the first drew no inner band — fixed in both.
Quick loop (`--tag effects`, 436 frames, RTX 4060), effects family before the
wiring: **ported 247 → 265**; the reasons "CPU-baked effect chain / fill
opacity (E4)" (10 + 10 raster), "per-channel LUT effects" (7 + 7), "3D LUT
effect" (1) and "CPU-baked effect (E4) (vegas / plexus / path-stroke /
scribble)" (5) are gone (on native-core with 3D: 312 ported, 303 within
tolerance). Two ceilings in `native-scene-baseline.json` (effect-posterize
1.105 %, effect-plexus 4.411 % — Chromium's GPU canvas raster vs Skia CPU, not
the builder); fill-opacity-zero-inner-shadow 11 % → 0.000 %, mask-feather
6.2 % → 0.02 % from the blur. Glass / layer styles / backdrop blur were already
ported (4/4, 9/9). **Not ported, by decision:** JS/WGSL plugin effects and
plugin generator layers (13 frames) — their shaders, passes and params live in
the page's plugin registry (`registerEffects`), not in the document, and G2
keeps that system out of the engine; reported as such. Also still reported:
footage (image / video) bakes. (Write-on's brush form landed 2026-09-26.) **E4 exit not met yet:** per-effect bench (162 effects, a
full-frame 1080p shape baked every frame, opacity animated so no raster hit,
`premation-scene --bench`, RTX 4060): the bake with no effect costs 50 ms (46
ms raster: the 1080p path raster + ImageData round trips), median 80 ms with
one effect, worst inner-shadow 1027 / stroke 814 / inner-glow 478 / vegas 279
ms — the styles are dozens of full-frame drawImage calls on Skia's CPU raster.
Next: a GPU route for the styles, cached silhouettes, and not re-rasterizing
the content when only effect params change.
**E4 GPU route (2026-09-27, branch `e4-gpu-effects`, syntax-checked only — not
built or benched).** A layer the TS bakes runs its stack on the render graph's
chain when the frame renders on a device (`ViewSpec::gpuEffects`, on in the
engine; `PREMATION_CPU_BAKE=1` and the parity gate keep the CPU bake):
`effects_port` `gpu_effect_route` / `extract_gpu_route_effects` (a
`fill-opacity` entry + `effectOpacity` / `scopeMaskKey` on the entries the
bake blended back; `fxmask:` rasters), `RLayer::gpuEffects` making
`layer_is_baked` false. Chain additions: fill opacity (silhouette +
`STYLE_FILL_FX` for inner shadow / glow / satin / bevel), scoped blend-back
(`EFFECT_SCOPE_FX`), jump-flood alpha distance fields for Stroke and Spread
(`fx_distance`, kept across frames under the chain input's content key,
`fx_cache`), Vegas from cached alpha contours (`contour_texture`,
`VEGAS_FX`). `FrameStats.effects` records each entry's path;
`premation-scene --bench --gpu-effects` prints it. Still CPU-baked: the other
canvas-only effects, interleaved LUT / colour grades, path-following effects.
Exit to measure: `docs/VERIFY_ON_TEST_MACHINE.md` § e4-gpu-effects.
**E4 round 2 + exit (2026-09-28, branch `render-completeness`, built and run on
the RTX 4060 box).** The GPU route now covers the rest: Numbers, Timecode, Audio
Spectrum / Waveform, Lightning (every composite but Multiply) and Path Stroke /
Scribble's paint buffer are painted alone at the bake's size (`TexKind::overlay`)
and landed by the chain (`fx-overlay`: over / lighter / screen / source-atop /
in place / destination-in — each equals painting on the layer); CC RepeTile is
the identity on the GPU; colour-matrix grades run on the sRGB-encoded colour,
clamped, as the bake's canvas filter (`textured-srgb-grade.wgsl`; scoped-mask
49 % → 0.6 % of pixels > 16/255 vs the bake). **Exit met:** `premation-scene
--gen-effect-bench --active tests/data/effect_chain_bench.json` (every effect at
rest and at its @active point, plus the chain bench's stacks: 393 cases), 1080p,
30 frames, `--bench --gpu-effects`: **393/393 under 41.7 ms (24 fps), 0 CPU-baked,
median 1.34 ms, worst Dust & Scratches 33.7 ms mean / 29.3 p50** (then Echo 21.8,
the stylised stack 17.3, Median 15.2). Before → after (ms/frame): inner shadow
1027 → 3.0, stroke 814 → 1.2, inner glow 478 → 2.9, vegas 279 → 1.4, satin → 2.8,
drop shadow → 2.8; Audio Waveform@active 652 → 3.3, Audio Spectrum@active 1727
→ 3.3, Scribble@active 69 → 1.2, Path Stroke@active 55 → 1.1, CC RepeTile@active
70 → 1.2, Hue/Saturation 66 → 1.3, Timecode 8.5, Numbers / Lightning 1.3–1.5. The CPU bake (and the SIMD kernels) stay the
parity path (`PREMATION_CPU_BAKE=1`, the golden gate) and the device-less fallback.
Multiply too (2026-09-28): canvas multiply over source-over is associative (in
1 − premultiplied colour it is a + b − ab), so Lightning / Audio Waveform in
Multiply paint their overlay multiply-on-transparent and the chain lands it
through blend-combine's W3C multiply (placed in the buffer's space first).
1080p, 30 frames: Audio Waveform@active in Multiply 638 → 1.9 ms, Lightning in
Multiply 23.9 → 1.5 ms; against the CPU bake 2.0 % of pixels > 16/255 (the
same order as the already-routed source-atop case, 1.8 %: the chain composites
in linear light where the canvas composites encoded values). Still on the CPU
bake on the route's own terms: Vegas' mask / path modes or Vegas behind another
effect, a drawn effect on a layer a mask shapes, Scribble filling mask regions,
path-following effects outside the overlay set, a faded / scoped effect with
several chain entries, footage (no raster of its own) and precomp containers.

**D2w time/comp (2026-09-25): nested compositions, retime, ghosts, particles and
cloners build from the C++ document.** New files beside `snapshot_build` /
`frame_build`, which only call hooks (the walk gained an instance-aware
`sid()` / `anim_sample_of` that every animation and clip read goes through):
- `comp_instance`: a SEALED instance is its own recursive `build_snapshot`
  (`nested_comp_layers`: its camera, 3D sort and size, `compStack` /
  `MAX_COMP_DEPTH` cycle guard, ids re-keyed `<instance>::`, errors carried up,
  its 3D frame as `precompScene3d`); COLLAPSED instances expand into render-only
  clones (`expand_walk_nodes`: `__instanceSource`, the `isCompInstanceRoot`
  transform barrier, the centre anchor); Essential Properties on both
  (`__compOverrides`: the component patch and the dropped tracks). The container
  carries the instance frame: referenced size, `::frame` crop mask, anchor,
  world transform, 2D motion samples.
- `threed_card` (`Scene3D::comp_card`): a 3D comp layer is a card — placed like
  a 3D layer, corners projected through the host camera, one quad per shutter
  sample through the sub-frame camera, Accepts Lights. `precomp_frame`: the
  frame side — `precompCamera3d` (the inner camera with the placement lifted
  onto its projection), `placement3d` threaded through the flatten
  (`threeDPlacementOk`), the card's `squareToQuad` homography.
- Retime: precomp and layer Speed % / Time Remap through `retimed_source_at`
  (`retime_port` already had the integral); frame blending (Frame Mix: the
  bracket pair on the source's own rate, `vfa:` / `vfb:`).
- `temporal_ghosts` (Echo / Wide Time, 2D), auto-orient, `raw_world` (the raw
  graph's world chain: points bound to nulls, the cloner's field), Continuous
  Rasterization (on by default for inserted vector layers — the tier ladder
  change), corner pin (the render homography, pinned bounds), content-aware
  fill (the nearest fill frame; SceneTextures decodes `data:image` stills).
- `cloner_port`: cloners were SILENTLY DROPPED by the C++ walk (it never ran
  `expandCloners`; a cloner rendered as its single source with no report) —
  now `clonerPlan` (linear / grid / radial, step, JS-exact hashed random, order
  and layer falloff, push), the subtree clones, the offset on the resolved
  transform and opacity, and the cascade on the clone's clock.
- `particle_port`: particle layers — `resolveParticleConfig`, the closed-form
  and the frame-stepping emitters (drag, wander / curl turbulence, trails,
  3-point ramps, death / continuous / bounce bursts, collisions; the stateful
  state cached per layer and stepped forward), `drawParticleField` +
  `drawPlexusLinks` on the C++ Canvas2D, `particlesToRenderable` and a
  `particles:` texture (`TexKind::particles`).

Parity: `timeCompCrossEngine.test.ts` → `time_comp_parity.json` →
`test_time_comp_parity.cpp` (engine_scene_tests): 10 harness-style documents
(the golden harness's own `sceneToProject`), 20 frames — sealed instances incl.
instance-in-instance and two placements, collapsed clones with overrides, the
cycle guard, 3D cards (dollying camera, lit, motion-blurred, one behind the
camera), Speed % and Time Remap, Frame Mix and content-aware fill, Echo + Wide
Time, auto-orient, bound points, Continuous Rasterization, corner pin, cloners,
particle configs: every snapshot field and renderable equal, nothing
unported. `particleFieldCrossEngine.test.ts` → `particle_parity.json` →
`test_particle_parity.cpp`: 11 Canvas2D programs (every emitter, shape, trails,
streaks, plexus, the stateful sim) equal op for op on the recording canvases.
Quick loop (`--tag timecomp`, 436 frames, RTX 4060): **ported 416 → 420, within
tolerance 411 → 415**; the four golden frames of this family —
precomp-collapse (composition instances), precomp-time-remap (precomp retime),
effect-echo (temporal ghosts), particles-v2 (particle layers) — are all
bit-identical to webgpu. The remaining 16 fallbacks are plugin effects /
generators (13, G2 by decision), glTF models (2) and height displacement (1).
ctest 13/13.

**Merge Paths, Offset Paths cleanup and path cloners (2026-09-25).**
`polygon_clipping` is a line-for-line port of `polygon-clipping` 0.15.7
(Martinez–Rueda sweep) with the splay tree whose comparison order its output
depends on and robust-predicates' `orient2d`, pinned by
`polygonClippingCrossEngine.test.ts` → `polygon_clipping_parity.json` (16
cases × 4 operations). `merge_paths` builds live Merge Paths results
(`nodeWorldOutline` over each operand's world pose, the boolean, the result's
subpaths) and Offset Paths' non-convex cleanup unions the surviving loops
through it. Cloners in `path` mode place their clones along the driving
layer's outline (trimPath's arc table, tangent-aligned). The time/comp fixture
covers all three (`live-merge-paths`, `offset-paths-cleanup`, and an open rail
under a moving null plus a closed ellipse in `cloners`).

**3D ghosts and expanded-mask Energy Beam (2026-09-26).** Echo and Wide Time
on a 3D layer rebuild that ghost's matrix and `world3d` at the echoed time
(`Scene3D::place_ghost`, Scale Z left at `affineAt`'s default of 1, matching
the TypeScript). Energy Beam on a mask flattens the path after its expansion.
Both are in the time/comp fixture (`ghosts-3d`, `energy-beam-paths`).

**Still reported, and why:** (Pixel Motion, interlaced fields and pulldown
removal were wired into the media feed in d2w-round2, 2026-09-27.) The audio waveform
generator draws once the referenced layer's source has conformed
(`MediaClock::waveform`, 1024 mono buckets). Until then the layer still
reports it. Energy Beam on text, point or paragraph, traces the painted runs.
That path is not in the fixture, because the trace depends on the installed fonts.

**D2w leftovers, d2w-cpp-ports (2026-09-26).** Each port is pinned by a
cross-engine fixture generated from the editor's code; the pure halves compile
in the headless build (`engine_scene_core`), the Scene3D / snapshot_build hooks
are syntax-checked only on this machine (engine_scene needs Skia + Dawn), and
none of the fixtures has been generated or run yet.
- **Write-on brush form** — `write_on_trail` ports `resolveWriteOnTrail`
  (the dab history on a Brush Spacing grid from the first key, Stroke Length,
  the 2048-sample thinning); `effect_handoff` hands `brushTrail*` to the
  kernel through the walk's animation wrapper. `write_on_trail_parity.json`
  replays the TS sampler's recorded answers. Energy Beam on point text already
  traced (130d7e82 covered paragraph text too).
- **glTF morph targets + skinning** — `model_deform` ports modelMorph.ts and
  modelSkinning.ts; the parse keeps skins (inverse binds conjugated once) and
  the entries their skin attributes and flipped deltas; Scene3D morphs, then
  skins, under the weight- / pose-hashed keys (`model_deform_parity.json`).
- **Extrusion fallbacks** — `extrusion_faces` ports extrusionGeometry (walls,
  chamfer rings, rounded / elliptical rings); Scene3D draws the slice stack and
  the geometric faces with faceEffectsFor, the per-face styles, wallFillAt and
  one-sided lighting (`extrusion_faces_parity.json`).
- **Per-character 3D text** — `per_char3d` ports layoutPerChar3D over the
  rasterizer's layout; Scene3D emits one glyph plane per character and, when
  extruded, one body per glyph. No fixture (glyph advances depend on fonts).
- **Rigs on image layers** — `rig_coverage` decodes the bitmap into ≤64²,
  `alpha_mesh` ports the coverage mask and alphaMesh.ts; rig_mesh culls its grid
  by the mask or traces it in silhouette mode (`alpha_mesh_parity.json`).
  `extractAlphaContours` moved to `effects/alpha_contours.cpp` (engine_contours).
- **Pixel Motion / fields kernels** — `pixel_motion` ports pixelMotionFlow.ts
  and deinterlace.ts (`pixel_motion_parity.json`); not wired into the feed.
- **getLayerTransforms 3D** — both engines answer a 3D layer's / camera's /
  light's layer → world 4×4 (`world3DAt` / `world_3d_at`, split out of
  layerSpaceAt), at its comp's size.
Still reported after d2w-round2: see below. channelView is the viewport's
channel display, not part of the frame.

**d2w-round2 (2026-09-27): the D2w leftovers and four queries, in C++.**
Written and syntax-checked on the 8 GB machine (headless flags); nothing was
built or run — docs/VERIFY_ON_TEST_MACHINE.md lists what to check.
- **Apple clang** — no `std::jthread` / `std::stop_token` (libc++ gates them
  behind -fexperimental-library): `core/joining_thread.hpp`; ThreadPool stops
  on a flag under its mutex.
- **Paragraph text** — CJK paragraphs break between characters (kinsoku,
  first-line indent) with INSERTED soft breaks; soft_break_lines reads them
  back; runs / animator glyphs are aligned to the wrap (alignIndicesToWrap);
  Fit Text to Box searches its scale (fitScaleOf) and hands `fitScale` to the
  painter (`cjk_wrap_parity.json`). Fit with runs that change line height is
  still reported.
- **Media feed** — Remove Pulldown weaves (plan_frames), Fields deinterlace on
  the GPU (FrameConverter::deinterlace, `#u` / `#l` media hashes), Pixel Motion
  warps the bracket pair on the CPU (convert_frame + readback, flow per pair at
  ≤ 384 px, warp_blend at full res; nearest frame while decoding). A GPU warp
  is follow-up (cost: two full-frame readbacks + a CPU warp per new weight).
- **EXR skies** — `exr_read` ports decodeExr (scanline, NONE/RLE/ZIPS/ZIP)
  and exrToFloatRgba; the sky reads the .exr (src or the asset's original
  path) and projects the linear planes; no .exr reachable → the PNG, as the TS.
- **Image-layer rigs** — SVG sources through the C++ SVG renderer; relative
  paths against the project folder (BuildContext / BuiltFrame `mediaBase`,
  which the viewport's texture feed now also uses). blob: stays reported.
- **Footage bakes** — Canvas2D-only styles on stills and video bake on the
  decoded frame (bakeImageBitmap / setVideoBaked sizes, fields first, the mask
  in the layer's centred space, `bake_footage`), `img:bake:` rasters.
- **Queries** — `getWaveform` (E2 peak pyramid, source-time range),
  `getThumbnail` (comp / isolated layer / footage still → PNG via the render
  thread's new task queue), `hitTest` (the built frame's quads, topmost first,
  locks), `readPixels` (the viewport's last frame redrawn offscreen, the float
  scene colour, straight alpha). getLayerBounds / getTextLayout /
  getLayerTransforms are B4's.
Still reported: paint strokes on footage; Fit Text to Box with runs that change
line height; blob: / remote image-rig and sky sources; channelView (viewport
only).
**2026-09-28 (`render-completeness`): the golden gate's unported report is down to
the accepted G2 loss.** Paint on footage and Fit Text to Box with line-height runs
landed in 54eaa1da; the last two non-plugin reasons went: the `prime:` height
field (the golden now carries its field — see D2w 3D leftovers) and SVG
`<fedropshadow>` (the page's sanitizer lower-cases that one name; Chromium still
draws the shadow, so the C++ SVG filter builder takes the lower-case name as
feDropShadow). Native golden gate: **423/436 frames ported, 338/348 gated frames
match, green**; the 13 unported frames are all JS/WGSL plugin effects and plugin
generator layers (G2, an accepted loss in TS_ENGINE_REMOVAL.md). Outside the
goldens the engine still reports `blob:` / remote image-rig and sky sources
(session data it cannot read until session footage is written to a cache file
and imported — TS_ENGINE_REMOVAL phase 2) and channelView (viewport only).

**D4 (2026-09-25): the engine keeps finished viewport frames in VRAM, keyed by
content.** A frame drawn before is a GPU copy into the slot instead of rasters,
effects and the render graph. The key is a 64-bit hash of the built frame (the
encoded frame, the texture feed, fonts, slot size), so an edit that leaves a
frame unchanged keeps it and undo returns to cached keys; there is no
revision-based clear. `render/frame_cache` is an LRU over a byte budget (evicted
textures are reused by size); `render/vram_ffi` sizes it at a quarter of the
render adapter's DXGI local budget (non-local on iGPUs), clamped to
256 MiB–4 GiB, 1 GiB elsewhere; `--frame-cache-mb N` overrides (0 = off). Only
exact frames are stored: a frame drawn mid-playback with a nearest decoded
footage frame is not. Baked rasters keep their bake across time and a re-bake
over unchanged content starts from a copy of the painted canvas (E4 perf, a
256 MB LRU beside the raster cache). `engine_gpu_tests` pins the round trip
(byte-identical), eviction, size mismatch, over-budget frames. **Exit met
(2026-09-28, real app, RTX 4060, engine owner + viewport, `scripts/realapp/d5Viewport.cjs
--cache`):** cache-first playback (`play{cacheFirst}`) of two heavy 30 fps comps —
`heavy.json` (the bench fixture's 6 shapes + 3 text at 1080p, every shape with
Lightning in Multiply — the one composite still CPU-baked — + Median + Dust &
Scratches, fill opacity animated) and `styles.json` (every shape with fill
opacity animated + inner shadow / glow / drop shadow / stroke; fixtures in
`scripts/realapp/fixtures`, `genFixtures.cjs`) — fills at 13.8 /
18.6 ms a frame (HUD p50) and then plays 60/60 frames in 1987 ms = **29.7 fps
(full rate)** at **1.6 / 1.4 ms a frame** from the VRAM cache.

**D5 (2026-09-25): with the owner flag on, the engine's frames are the
viewport.** Behind `PREMATION_ENGINE=process` + `PREMATION_ENGINE_OWNER=engine`
(default off):
- `engine()` is an `OwnedEngineClient` over the process client: its answers,
  events, history and dirty flag are the truth. The TypeScript engine becomes
  a replica fed the same edits, lifecycle and history requests in order (for
  the overlays that still read the page's document, B4 §5); differences are
  counted, never shown. After a fallback nothing is forwarded (the owner is
  then the same TypeScript engine). **Superseded 2026-10-03 (removal block
  3):** no replica — `engine()` is the owner alone, no LocalEngine is created
  in the app, and the page's history, inspector revisions and chrome repaints
  follow the mirror.
- Providers read the flag from `engine:status`; `ProjectManager` delegates to
  `EngineDocumentSession`; the dirty dot follows `mirror.dirty`; autosave runs
  `session.autosave()` every 60 s into `<userData>/recovery/`; the recovery
  prompt offers the engine's record as one undoable entry.
- `engineTransport`: play / pause / seek and the active comp go to the engine,
  whose playhead events drive the timeline; the page's clock and WebAudio mix
  stand down (the engine's clock is audio-paced, E2).
- `EngineSurface` in `viewport` mode fills the stage under the overlay canvas
  and every handle; the workspace render tick sends `setViewport` with the
  workspace camera (one request in flight, latest wins, no React render per
  frame). A camera-only `setViewport` keeps the shared-texture ring. The
  TypeScript renderer gets a null backend and paints chrome only; it returns
  if the process backend falls back. The HUD shows the engine's frame time
  (build + render to GPU completion; `RenderStats.cpuFrameMs` is the build
  half). `EngineUnportedNotice` lists what the engine drew the comp without.
- Tests: `ownedEngineClient` (routing, replication, gesture id mapping,
  fallback), `ownerMode` (a real `premation-engine-headless` owner and the TS
  replica: equal documents, 0 differences), `engine_tests` (ring decision,
  `getLayerErrors`).
**Exit met (2026-09-28), and the defaults flipped.** Real app, the built
Electron (`dist-electron`, not Vite), RTX 4060, a 998×545 viewport at DPR 1.09,
2 s of playback per comp (`scripts/realapp/d5Viewport.cjs`: the same project
opened in each mode; the TS number is its HUD CPU time + the GPU tail —
every WebGPU submit timed to `onSubmittedWorkDone` — because the engine's HUD
counts build + render to GPU completion; TS CPU-only in brackets):

| bench comp | engine HUD p50 | TS HUD p50 (CPU only) | TS fps |
|---|--:|--:|--:|
| bench (6 shapes + 3 text) | **2.6 ms** | 8.6 ms (1.6) | 30 |
| shapes8 | **2.6** | 8.6 (1.1) | 30 |
| shapes32 | **5.9** | 10.2 (1.5) | 30 |
| styles (fill opacity + 4 styles on every shape) | **17.1** | 115.2 (10.7) | **19** |
| grades (blur 20, hue, levels, noise on every shape) | **9.4** | 17.3 (3.2) | 30 |

The engine holds 30 fps on every comp (surface 29.8–30.7 fps); the TS path drops
to 19 fps on styles. From 2026-09-28 the process backend, the engine as the
document owner (hence the engine viewport) and engine export are ON by default
(`electron/engineHost.ts` `engineBackendEnabled` / `engineOwnsDocument`,
`electron/exportProcess.ts` `exportEngineEnabled`); the TypeScript path stays
behind `PREMATION_ENGINE=ts`, `PREMATION_ENGINE_OWNER=ui`,
`PREMATION_EXPORT_ENGINE=0` (or `{ "backend": "ts" }` / `{ "owner": "ui" }` in
`<userData>/engine.json`), and a missing executable, a crash loop or an
unported export frame still falls back to it. **Superseded 2026-09-28 (phase 4,
`docs/TS_ENGINE_REMOVAL.md`):** those flags, the preference file and every
fallback are deleted — the engine always runs and owns the document; a missing
executable / no GPU is a fatal startup dialog, a crash loop a blocking
"engine unavailable" dialog with a recovery save (`electron/engineUnavailable.ts`),
and an export the engine cannot render fails with its reason. Checked in the real app with no
flags set (`scripts/realapp/defaultFlags.cjs`): `engine:status` enabled +
ownsDocument, the viewport on the shared-texture route, and a Render Queue job
rendered by the engine (`f1RenderQueue.cjs --default`; this fixed the export launcher's
dev path, which looked for the engine under `dist-electron`). The golden gate
the flip rests on is green with its baseline (338/348 gated frames match; the
10 ceilings are the TS WebGPU backend's own or known E1/E3 differences — not
bit-identical, a decision recorded here: the owner flip was asked for once the
performance exits were met).

### Phase E — Media, audio, text, effects

| Step | What | Exit | Size |
|---|---|---|---|
| E1 | Hardware decode into GPU textures (NVDEC, D3D11VA, VideoToolbox, ffmpeg fallback); ProRes, DNxHR, mixed timelines | 4K ProRes scrub ≤ 50 ms; 6 × 1080p layers at full rate | 6 wk |
| E2 | Audio engine: decode, mixing, effects, playback device; the audio clock is the master clock | A/V drift ≤ 1 frame over 10 minutes | 5 wk |
| E3 | Text and vector with Skia + HarfBuzz; bidi, vertical, kinsoku parity with today | Noto text goldens match; animated-text bench ≥ 3× | 8 wk |
| E4 | Effects: GPU effects keep their WGSL; the 28 Canvas2D-only effects and 44 CPU bake sites become SIMD kernels on all cores | No effect drops the bench comp below 24 fps; golden parity | 8–10 wk |

**Engine jobs (2026-09-27, branch `engine-jobs`; TS_ENGINE_REMOVAL decision B).**
The analysis jobs run in the engine: a runner in engine_core (worker threads,
progress events, cancel, results applied through commands as one undoable
entry), and in `native/engine/src/jobs` the kinds ported from the TypeScript —
trackMotion / stabilize, autoTrace, sceneDetect, objectMatte (SAM through ONNX
Runtime in a child engine process), audioAnalysis / audioDuck / audioGate,
proxy, render / prerender (a child `--export` per item). The UI asks the
engine first (`src/core/engine/engineJobs.ts`) and falls back to its page path
when the TypeScript engine answers `unsupported`. Not ported: transcribe (a
provider call through main — needs a decision), auto-reframe, mask / planar
tracks, roto brush, content-aware fill, camera solve. ENGINE_API.md §4.9;
docs/VERIFY_ON_TEST_MACHINE.md `### engine-jobs`.

**E1 local results (2026-09-25, Windows 11, RTX 4060 Laptop + Radeon 780M,
Ryzen 16 threads; branch `worktree-agent-a3ee1a99a16026443` off `native-core`).**
Clips from `native/engine/tools/gen_media_clips.mjs` (testsrc2 + grain, 23.976
fps: 4K ProRes 422 HQ ≈ 700 Mbit/s = Apple's rate; 4K ProRes 4444 + 16-bit alpha
≈ 2 Gbit/s, about 4444 XQ; DNxHR HQ/HQX; H.264 High and HEVC Main10 at GOP 48
with B-frames; VP9 alpha), measured with `run_decode_bench.mjs` →
`premation-decode-bench` (60 random seeks through MediaSystem's latest lane,
cold cache; "texture" = decoded AND converted to RGBA16F on the GPU, GPU idle —
the honest scrub latency; hardware "decoded" times are submission times). The
machine was shared with other agents' builds: every run waited for CPU load
< 35 % and the load at start was 6–33 %. Render adapter RTX 4060 unless noted.

| clip · path | scrub texture p50 / p95 ms, before → after | frames decoded / 60 targets | playback ×1 fps (after) |
|---|---|---|---|
| 4K ProRes 422 HQ · software | 18.8 / 25.4 → 15.7 / 29.8 (p95 is noise-level; ≤ 50 ✔) | 62 → 60 | 62–67 |
| 4K ProRes 4444 + alpha (≈ 2 Gbit/s) · software | 52.3 / 92.8 → 42.6 / 65.7 | 64 → 60 | 24.1–24.2 (just full rate) |
| 4K ProRes 4444 at ≈ 4 Gbit/s (grain stress, before only) · software | 61.0 / 96.4 | 64 | 18.3 |
| 1080p ProRes 422 HQ · software | 7.0 / 10.1 → 6.3 / 8.6 | 62 → 60 | 213 |
| 1080p DNxHR HQ · software | 5.2 / 7.8 → 4.8 / 7.8 | 62 → 60 | 264 |
| 4K DNxHR HQ · software | 17.4 / 22.6 → 14.7 / 24.7 | 62 → 60 | 91 |
| 4K DNxHR HQX (10-bit) · software | 17.6 / 29.0 → 15.3 / 21.7 | 62 → 60 | 71 |
| 4K H.264 · software | 432 / 926 → 380 / 827 | 884 → 695 | 51 |
| 4K H.264 · d3d11va zero-copy | 55.9 / 506 → 56.3 / 458 | 155 | 73–76 |
| 4K H.264 · nvdec (download + upload) | — → 116 / 432 | 270 | 79 |
| 1080p H.264 · d3d11va zero-copy | 11.7 / 137 → 12.2 / 119 | 130 | 261 |
| 1080p H.264 · nvdec | — → 12.9 / 108 | 130 | 279 |
| 4K HEVC Main10 · software | 292 / 499 → 250 / 471 | 1111 → 768 | 122 |
| 4K HEVC Main10 · d3d11va (P010 downloaded) | 51.2 / 252 → 46.6 / 262 | 253 | 81 |
| 4K HEVC Main10 · nvdec (= policy "auto") | — → 37.4 / 169 | 253 | 115–123 |
| 1080p VP9 alpha · software (libvpx) | 5.5 / 352 → 3.8 / 348 | 376 | 101 |
| **6 × 1080p paced at 23.976** | H.264 sw / d3d11va / nvdec, ProRes 422 HQ, DNxHR HQ: **all full rate**, 2–10 late of 720 (the first frames) | | |
| 780M as render adapter · d3d11va | 4K H.264 scrub 84.6 / 649, playback 33 fps; 6 × 1080p H.264 full rate in 3 of 4 runs (one 4.3 fps run while other agents used the GPU, not reproduced) | | |

- **Exit criteria.** 4K ProRes 422 HQ scrub ≤ 50 ms: met (p95 25–30 ms to a
  texture). ProRes 4444 at ≈ 2 Gbit/s is 66 ms p95: CPU-bound (≈ 30 ms
  slice-threaded decode on 16 threads + ≈ 12 ms to upload four 16-bit 4:4:4
  planes, 66 MB a frame); a lighter 4444 (Apple's ≈ 1.1 Gbit/s) would land near
  the limit. Closing it needs either a GPU ProRes decode (a Vulkan compute
  path; nothing in our Windows ffmpeg build offers one, not verified further) or
  uploading the 10-bit planes packed. 6 × 1080p at full rate: met on every path.
- **Changes behind the numbers.** Intra-only streams seek unless the target is
  the next frame (a 1–2 frame gap used to be decoded through: 62–64 → 60 decodes
  per 60 seeks). Long-GOP scrubs skip non-reference frames before the target
  (exact index only): 884 → 695 frames for 4K H.264 in software; these x264 /
  NVENC encodes use B-pyramids, so fewer B-frames are skippable than in an
  IBBP camera GOP. Long-GOP scrub remains bounded by GOP length (48 here):
  p95 ≈ 0.45 s on hardware, ≈ 0.8 s in software. Threading was already right:
  slice threads for intra codecs, frame + slice for long-GOP, one thread for hwaccel.
- **NVDEC vs d3d11va (decision).** On NVIDIA, d3d11va *is* NVDEC (same
  silicon), and on the render adapter it lands in Dawn with no CPU copy — so
  **d3d11va on the render adapter stays first** for 8-bit streams: 4K H.264
  scrub p50 56 vs 116 ms, playback CPU 56 % vs 78 % of a core. **10-bit goes
  to nvdec** when the render adapter is a CUDA device: the pinned Dawn can't
  import P010 on D3D12, so d3d11va downloads 10-bit through a staging copy,
  and CUDA's download is faster (4K HEVC Main10 scrub p95 262 → 169 ms,
  playback 81 → 115 fps). NVDEC is opened only on the CUDA device whose LUID
  is Dawn's adapter (`cuda_ffi.cpp`); with the engine on the 780M it declines
  and d3d11va runs on the 780M (VCN). `media_config_for(device)` encodes this.
- **Reliability.** A hardware decoder that refuses a stream or fails
  mid-stream hands that clip to threaded software from the frame it was on
  (`SourceStats::hwFallback`, `media_hw_fallback` in the engine log); tested by
  fault injection with bit-identical frames. Colour: the CPU twin and the GPU
  pass match swscale for BT.601/709/2020 (+ FCC, 240M on the CPU) × limited/full
  × 8/10/12(/16)-bit, P010-style storage included, and a wrong matrix or range
  fails by ≥ 8× the tolerance. A six-codec mixed timeline decodes interleaved
  with no cross-talk and an empty cache after close.
- **Open.** (The engine's frames and export jobs both open their
  `MediaSystem` with `media_config_for`, so they use the policy above.)
  VideoToolbox (macOS) and VAAPI / Vulkan Video (Linux) are compiled but
  unmeasured. CUDA → D3D12
  zero-copy interop for nvdec, and P010 zero-copy once Dawn offers
  `MultiPlanarFormatP010` on D3D12. GPU ProRes (Vulkan) for 4444 at 4K.
  A GPU-busy gate for the bench (it gates on CPU only).

**E2 (2026-09-24): exit met.** `native/engine/src/audio`: decode-once sources
(48 kHz float stereo), per-clip voices with varispeed / reverse / loop, the 13
built-in effects ported with Chromium's DSP, keyframed automation, the master
limiter and meter, miniaudio / WASAPI output, and a DLL-locked audio transport
clock: **A/V within one frame over 10 minutes** (the wall clock drifts 4–7
frames). The mixdown equals the TypeScript's on 36 scenes
(`tests/data/audio_parity.bin`); offline render is bit-deterministic. Export
jobs mix with it (F1). Open: audio-driven expressions in the D1 corpus.

**E3 progress (2026-09-24).** `native/engine/src/raster`
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
**E3 open items, round two (2026-09-24, branch `e3-text`, built on Linux without
Skia / HarfBuzz / SheenBidi / woff2 / ICU headers — so the Skia-free core, with
parity measured against the TS by call log and by value, not by pixels):**
- **Paint strokes** — `paint_raster.cpp` ports `paintRaster.ts` + `paintDabs.ts`
  onto the Canvas2D interface (direct and dab passes, erasers of every mode, self
  clones, trim, transforms, dynamics, channels, blends, Paint On Transparent);
  text and path rasters draw paint instead of reporting it. Against the TS
  `drawPaint` on a recording canvas: 25/25 cases, 7078/7078 Canvas2D ops identical.
- **Vertical optical kerning** — `optical_math.cpp` (`VerticalKerner`) +
  `OpticalKerner::kern_vertical_px` + `opticalKernVertical` in the vertical layout:
  24/24 profiles and 169/169 pair kerns (96 non-zero) bit-exact on synthetic glyph rasters.
- **Intl word breaks** — `line_break.cpp` + `word_break_ffi.cpp` (ICU's word
  iterator, loaded from the OS through its C ABI; the TS's no-Segmenter branch
  when none loads): break opportunities 23/23 and wraps 23/23 exact over 23
  texts (Thai, Lao, Khmer, Myanmar, CJK, bidi scripts) — OS ICU 74 vs Node's ICU 78.
- **Linux system fonts** — `system_fonts_ffi.cpp`: fontconfig matched as
  Chromium's font service accepts a match, plus Blink's generic defaults and
  alternate names; 29/30 families resolve as Chromium 141 draws them on the same
  machine (the miss is a quoted `"Serif"`, which the font parser treats as the keyword).
- **Alias FontFace features** — `CanvasOptions::aliasFaces` (off for the
  harness's `fv0`): OpenType features straight to HarfBuzz, no glyph-by-glyph
  ligature fallback.
- **Canvas-drawn effects** (with E4) — Canvas2D gained shadows and
  `getImageData` / `putImageData`; `engine_canvas_effects` ports 9 of the 27
  canvas-drawn effects (fill, linear-wipe, checkerboard, grid, circle, ellipse,
  radio-waves, light-rays, light-sweep): 21/21 cases, 1224/1224 ops identical.

Not compiled here (no Skia / HarfBuzz): `canvas_ffi.cpp` (create_canvas, shadows,
ImageData) and `fonts_ffi.cpp` (the fontconfig call); every Skia-free painter is
built or syntax-checked with the project's warning flags. Pixel parity of the new
paths (`premation-raster --mode native` on the golden scenes) is still to run on a
machine with the vcpkg `engine` feature.

Open: the GPU (Graphite) raster path (needs a GPU), the CPU bake chain under the
engine (E4: the chain and all 27 canvas-drawn effects are ported — see the E4 chain
note — `frame_build.cpp` does not call it yet), macOS system fonts (CoreText), variation axes and
the 'vert' face through alias faces, the D2w scene builder's own paint resolution
(`snapshot_build.cpp` still marks paint unported), pixel parity of the above.
**E3 native run (2026-09-28, RTX 4060 box, `premation-raster --mode native` over
the render-tests raster export, 263 rasters, platform glyphs):** 0 failures to
draw; within 1/255 — blend 36/36, "other" 47/53, masks 11/18, strokes 14/22,
text 17/28, shapes 6/13. Two known causes account for every visible (> 16/255)
difference, neither a C++ painter bug: (1) ellipse edge AA — every `effect-*`
subject ellipse (a gradient-filled 220×170 ellipse) is off on the same 527 rim
pixels (max 71) and nowhere inside, the GPU-canvas-vs-Skia-CPU AA already noted
for effect-posterize; the frames stay inside the golden tolerance; (2) glyph AA
(DirectWrite through Chromium vs FreeType / the platform backend here): worst
text-scale-4x 9 % and text-optical-kerning 17 % of inked pixels > 16/255, CJK
vertical text with FreeType. The 10 rasters with ≥ 50 % differences (vegas, path-stroke,
plexus, scribble, scoped-mask, plugin kernel, fill-opacity-*) are BAKED
textures — the TS texel includes the effect chain, the native raster is the
content before it; those are pinned by `bake_chain_parity` and the whole-frame
golden gate, not by this harness. Whole frames: the native golden gate is green
(338/348 gated, text 22/22, shapes 16/16, strokes 24/24).

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

The 27 canvas-drawn effects were not ported by the kernel rounds; E3 ported 9
of them on `raster::Canvas` (`engine_canvas_effects`). The chain round below
ports the other 18 and runs all 27 in the chain.

**E4 chain (2026-09-24, branch `e4-chain`, CPU only, built on Linux without
Skia).** `engine_effect_chain` (`native/engine/src/effects/effect_chain.cpp`,
`effect_apply.cpp`, `effect_color.cpp`; see `native/README.md` § The bake
chain) is `effectBake.ts` `applyEffectChain` + `bakeWorkerCore.ts` `runBakeJob`
on the Skia-free `raster::Canvas2D`:

- **Param mapping.** All 139 pixel effects go through a port of their TS
  `apply*` wrapper, not the kernel's argument names: the guards that skip
  neutral settings (a guard that returns never touches the frame, so it is part
  of the Canvas2D program), renames, `/100` scalings, `w/2 +` centre offsets,
  `Math.round` / clamps, the three colour parsers, Find Edges' blend,
  `deepGlowSettings`, `beamPathSettings` + `beamFlicker`, `pickMaskPaths`'
  index, `fromStoredLut`'s validation.
- **Routes, in `applyOne`'s order.** 10 LUT effects (`colorLut.ts` +
  `aeRoundSevenLuts.ts`, Float32 tables), the 11 CSS effects (their filter
  strings, batched and flushed as one `ctx.filter` draw — the Skia canvas draws
  only `blur()` of them so far, and reports the rest in
  `ChainReport::unsupported`), the colour-matrix pair (tint, channel mixer),
  the two procedural generators, plugins (reported), and the canvas2d route:
  the 139 kernels and **all 27 canvas-drawn effects** — the 18 left after E3
  (stroke, the interior styles, satin, bevel, four-colour gradient,
  directional blur, transform, beam, CC RepeTile, lens flare, numbers,
  timecode, audio spectrum / waveform, lightning, plexus, vegas) ported call
  for call onto `raster::Canvas2D`, with a `CanvasEffectContext` for what the TS
  keeps in module state (the `scratch(role)` pool, the fill-opacity style
  silhouette). They need Skia only to rasterise, not to verify: their parity is
  the call log.
- **Interleaving.** Fill opacity (silhouette snapshot + `destination-in`
  fade, the silhouette installed for every style), the Compositing-Options
  opacity and effect-scoped masks (one before / after blend; the mask painted
  by `raster/mask_paint`, now in the Skia-free core), and the batched ImageData
  exactly as the TS intercepts it — including that every non-CSS step's
  `flushCss()` lands the batch, so consecutive pixel passes each pay a
  get / put pair in the TS and must in C++ too (on Skia the put / get round
  trip is premultiplied, so dropping it would change bytes at partial alpha).

**Parity.** `effectChainCrossEngine.test.ts` runs `runBakeJob` on the
recording canvas, which now holds pixels: getImageData / putImageData are real
(every put logs the FNV-1a 64 of its bytes) and the chain's own composites go
through a reference compositor both recorders share; filters, shadows, paths,
gradients, text and scaled draws are pinned by the call log only. Cases: every
registered effect alone at its registry defaults and at two random points of
its declared ranges, 15 stacks (every route interleaved; fill opacity 0, 0.35
and 0.4 under the styles; opacity 0 / 55 / 100 and scoped-mask blends
including a missing mask id; LUT and colour-matrix families; drawn passes
between kernels; generators on mask paths; brushes), and a keyframed stack
sampled through `resolveEffectParams` at three times. `engine_effects_tests`:
**606 / 606 cases exact on 1 thread and on 4 — 50 585 / 50 585 Canvas2D ops,
1 093 byte-checked putImageData, every final buffer, every route** (474 cases
change pixels; the rest are neutral defaults or drawn-only). Zero tolerance.
Two TS bugs the port reproduces on purpose, for the TS to fix first: Stroke
inside / center draws no inner band on a reused scratch canvas (its pooled
context keeps `destination-out`), and Audio Waveform is always mid grey
(`rgba()` of `bandColor`'s `rgb(...)` string).

**Bench** (`premation-effects --chain tests/data/effect_chain_bench.json`,
1920×1080 baked layer through `run_bake_job`: seed, chain, read-back; the
canvas holds pixels for ImageData only, so this is the chain's CPU work and
the canvas's own rasterisation — blits, filters, paths, text — is Skia's and
not in it; shared 4-vCPU container, CPU pressure 0.4–7 %, best of 3):

- 382 single-effect layers (191 effects × defaults / active) + 6 stacks:
  **306 / 388 within 41.7 ms on 4 threads** (251 on 1 thread); median 10.0 ms.
- At the active settings: 147 / 191 effects fit a 24 fps frame on 4 threads
  (115 on 1); median 11.7 ms (24.2 ms on 1 thread). 52 of the defaults are
  neutral and cost only the seed / read-back (≈ 1.7 ms).
- Over budget on 4 threads at the active setting (44): the heavy kernels of
  the table above (Deep Glow ≈ 1.05 s, Cross Blur 287 ms, Beam Path 244,
  Light Burst 240, Brush Strokes 237, Vector Blur 230, Radial Blur 159–179,
  Fractal 160, …), Gaussian / Fast Box Blur at radius 60 (96–109 ms), and
  Vegas active (163 ms: a contour stroke per speckle of the synthetic layer,
  657 k draws).
- Stacks (4 threads): title card (fill 0.5 + drop shadow + glow + fill)
  1.7 ms; keyed plate (Keylight, spill, matte choker, scoped colour balance)
  64 ms; graded footage (levels, curves, vibrance, masked 12 px blur, grain)
  97 ms; generators 122 ms; stylised (median, find edges, posterize, 50 %
  unsharp) 140 ms; distort (turbulent displace, twirl, chromatic aberration)
  157 ms.

So the exit criterion is not met on the CPU alone for the heavy kernels: they
need the lower-precision twins behind the golden gate noted above, or their
WGSL on the GPU (they are ported effects: they bake only when a layer bakes for
another reason).

Open work for E4:
- ~~Put the chain under the engine.~~ Done for shape / text rasters (D2w
  effects, 2026-09-25, see Phase D): `scene/bake_chain.cpp` builds the job from
  the document (`params_of` + `scaleEffectLengths`, the layer mask as a matte)
  and runs `apply_effect_chain` on the raster's Skia canvas; the golden gate
  runs on whole frames. Footage bakes (`setImage` / `setVideo`) landed in
  d2w-round2 (`bake_footage`, run on the render thread's prepare, one frame
  at a time — not on the raster pool yet). Left: the 24 fps exit (styles on a 1080p layer cost 0.4–0.9 s a frame on Skia's CPU
  raster; see the D2w bench).
- ~~Skia side~~: CSS filter lists (`css::parse_filter_list` → SkImageFilters)
  and Plexus' float16 scratch are in; accelerated canvases blur with the GPU
  canvas's algorithm. Pixel parity of all 27 drawn effects against Chromium on
  their own (`premation-raster`) is still to run; the golden effect scenes pass.
- The non-effect CPU bake sites in `src/core/rendering`: `pixelMotion*` and
  `deinterlace` are ported (d2w-round2); `channelView`, `frameTap`,
  `AppTextureProvider`'s read-backs remain.
- Toolchain not checked here: clang-tidy (CI runs it on `native/libs` only),
  the sanitizers (this container has no compiler-rt runtime, which also stops
  `engine_fuzz` from linking), MSVC / clang-cl and WASM builds.

### Phase F — Export and ownership

| Step | What | Exit | Size |
|---|---|---|---|
| F1 | Export from the engine directly to ffmpeg, multi-frame across threads; the export supervisor launches engine jobs instead of hidden Chromium windows | ≥ 3× today's raw-pipe fps on 8 cores; md5-identical output at the same settings | 4 wk |
| F2 | The engine owns the document and undo; the UI holds only its mirror. The TS engine is kept behind the flag for one release, then removed | No authoritative project state in the UI process; undo parity suite green | 6 wk |

**F2 progress (2026-09-24): the undo parity suite is green; the document
lifecycle runs through either engine behind a flag.** Branch `f2-ownership`.
- **Undo parity suite** (the exit's second half):
  `src/core/engine/__tests__/undoParity.test.ts` runs every replay-corpus
  session (B2 + family + generated, and a new F2 lifecycle session) on the
  TypeScript engine and probes `getHistory` (labels, origins, position,
  can-undo/redo, gesture open, limit) and `getDocument` (property trees,
  keyframes, items, comps, layers, dirty) after EVERY non-query request; then
  a WALK per session: undo to 0 and one past, redo to the end and one past,
  `jumpToHistory` 0 / middle / end / past the end, a checkpoint undone and
  redone, a blank checkpoint, a cancelled gesture (with undo / redo / jump /
  checkpoint / nested gesture / clearHistory / a wrong gesture id refused
  inside it), a committed 3-message drag, undo/redo of it, a new edit
  clearing the redo tail, an empty and a round-trip gesture, a batch, the
  history limit (0 refused, 2 dropping the oldest), `clearHistory`.
  `native/engine/tests/test_undo_parity.cpp` (`engine_undo_parity_tests`,
  ctest) replays the bytes into an in-process C++ `Session` and compares
  every response byte for byte and every revision step (fixture
  `tests/data/undo_parity.bin`, 7.0 MB, frozen, `PARITY_REBLESS=1` re-blesses; the
  fixture format and replayer are now shared with D1:
  `__testHelpers__/parityFixture.ts`, `tests/parity_fixture.hpp`;
  `PARITY_DUMP=<dir>` writes both engines' bytes for a difference).
  **62 sessions, 58 364 records (10 002 walk steps, 37 796 probes): 0
  differences, ratchet 0.** First run: 57 (one session).
- **C++ gap found and fixed:** redo of a command that CREATED several
  compositions (a deep `duplicateComposition`) re-inserted them in key order
  (`comp_3, comp_4`), the TypeScript engine in its entry's order
  (`comp_4, comp_3`) — items and comps listed differently after any undo/redo
  across such a command. Compositions have no order part in either engine, so
  a `ChangeSet` now carries `compSeq` (the composition order when the edit
  began, then the ones it created in document order) and `Document::apply`
  re-inserts compositions and timelines in that order. D1 stays at 0.
- **Lifecycle through the engine** (`src/core/project/engineDocumentSession.ts`):
  New / Open / Save / Save As / Save a Copy / Revert / Close as `newProject` /
  `openProject` / `saveProject` / `revertProject`; autosave =
  `saveProject{recovery, copy:true}` when the MIRROR is dirty + a recovery
  record (editor state); recovery = `openProject` of the file it belonged to
  (or `newProject`) + `restoreDocument` as one undoable "Recover Unsaved
  Work" entry — dirty, still bound to its file, Undo shows the saved version.
  Path / dirty / history come from the document mirror only.
  `ProjectManager` delegates to it when given `engineDocument`; the flag is
  `PREMATION_ENGINE_OWNER=engine` (or `"owner": "engine"` in
  `<userData>/engine.json`) on top of `PREMATION_ENGINE=process`, reported as
  `ownsDocument` by `engine:status` (`processEngineOwnsDocument()`). Default
  off: the TypeScript engine stays the owner (this release). Tested on both
  engines (`engineDocumentSession.test.ts`, the C++ one through
  `ProcessEngineClient` + `premation-engine-headless` writing real files
  temp + rename): the full cycle incl. a crash between autosave and recovery,
  a never-saved project's recovery, a stale record, refusals, and
  ProjectManager with a page document IO that throws if touched.
- **Remaining for F2:** wire the flag in `Providers` (the recovery prompt, the
  autosave timer, the title-bar dirty dot, `ProjectLoaded` no longer
  rebuilding the TS engine as owner) and route `engine()` to the process
  client when it owns the document — that needs the engine viewport (D5),
  otherwise UI edits vanish from the TS-drawn viewport; `.motion` BUNDLES
  are now written by the engine (`saveProject{format}`, see the inventory row;
  left: `blob:` session footage the
  engine cannot read until an engine import port exists — E1); then the
  inventory rows still open (Versions ▸ Compare as an engine still), and
  deleting the TS engine after one release. **2026-09-27 (`engine-jobs`):**
  motion blur / colour management are commands in both engines
  (`setMotionBlur` / `setColorManagement`, their stores mirror views), the
  assets store's items and projectStore.comps are mirror views
  (`engineItemsView.ts`), DEFLATE portable zips open in the engine, and the
  Render Queue Output Module offers 16-bit mov on the engine export path. `setGuides`,
  `setSwatches`, `setMaterials` and `exportDocument` landed 2026-09-26 (both
  engines; undo is a part of the document). **Done 2026-09-26 on
  `f2-ownership`** (see the rows): Open Portable Copy in the engine, the
  whole-document callers on `exportDocument` / `saveProject`, pop-out windows
  as second mirrors, the command log in main, guides / swatches / materials
  and the dirty readers engine-sourced. Written and linted, jest not yet run;
  the C++ is compiled object-by-object here (the engine was not linked or run
  on this Mac).



**F2 inventory — authoritative project state in the UI process (2026-09-24).**
Everything below is document state the page holds and that is *not* the
mirror (`src/stores/documentMirror.ts`). With the TypeScript engine as owner
it is the document; with the engine as owner it must be gone, derived from the
mirror, or demoted to editor state. The column "how" names the route; "state"
is where it stands on `f2-ownership`.

| Holder (UI process) | What it holds | Why it is authoritative today | Must move to / how | State |
|---|---|---|---|---|
| `defaultSceneGraph` (`src/core/scene`) | every layer row: components, switches, nesting (= parenting), effects, masks, text, styles | `captureDocument` saves it; the TS renderer draws it; 53 UI files still import it | the engine's `doc::Document` nodes. Reads → mirror (B4 read ratchet, 681 left, mostly per-frame viewport reads); the TS renderer's input goes with D5 (engine viewport default-on) | reads ratcheted; writes 0 (B3) |
| `defaultAnimation` | tracks, keyframes, expressions, data tracks | same; 26 UI files import it | the engine's `anim` parts; reads → `mirror.keyframes` / `valueAt` | as above |
| `useProjectStore.comps` | composition settings per comp | `captureDocument().comps`; `replaceComps` on restore | `mirror.comps` (`CompInfo.settings`); the store keeps TABS only (editor state, `editorView.ts`) | mirror carries them; **2026-09-27:** with the engine as owner `projectStore.comps` follow CompInfo (`bindEngineComps`) |
| `useCompositionStore` | the active comp's settings incl. background gradient | render hooks read it into `buildSnapshot` | derived: `useActiveMirrorComp()`; deleted with the TS renderer (D5) | derived copy |
| `TimelineController` (`src/core/timeline`) | bars (clip ids, in/out, stretch), comp/layer markers, work area, bar order | `capture()`/`restore()` in the document (`timelines`) | `LayerInfo.timing`, `CompInfo.markers/workArea` in the mirror; the controller keeps zoom/scroll only | mirror complete (B4 exit for the timeline) |
| `useAssetStore` + `documentItems` + localStorage caches (`saveFolders/Assignments/Interpretations`) | footage records, folders, interpretation, proxy, tags, label, comment | `captureProjectItems` / `applyProjectItems` | engine items (`ItemInfo`, item commands exist); object URLs, thumbnails and decode caches stay UI session state keyed by item id until E1 moves decode | commands + mirror exist; **2026-09-27:** with the engine as owner the store's items follow ItemInfo (`src/stores/engineItemsView.ts` bindEngineItems; session fields kept per id) |
| `motionBlurStore`, `guidesStore`, `colorManagementStore`, `swatchStore`, `materialStore`, `transitionStore` | project motion blur, guides/grid/camera bookmarks, colour management, swatches, materials, transition records | captured/restored whole by `cloudDocument` | the C++ document already saves/loads all of them (D1: identical saves). `setGuides` / `setSwatches` / `setMaterials` exist in both engines. **2026-09-26:** the mirror carries `guides` / `swatches` / `materials` (snapshot + `guidesChanged` / `swatchesChanged` / `materialsChanged`); with the engine as owner `src/stores/engineDocumentStores.ts` makes the three stores VIEWS — the engine's value lands in the store, a user edit is ONE undoable `setGuides` / `setSwatches` / `setMaterials` (whole value; a replica `restoreDocument` is never sent, `isRestoringDocument()`). Motion blur and colour management: no engine command yet (saved/loaded by both engines); transitions: engine commands + `CompInfo.transitions` in the mirror, store written by the replica | guides / swatches / materials engine-sourced behind the flag; **2026-09-27:** motion blur and colour management too — `setMotionBlur` / `setColorManagement` (both engines; setCompositionSettings{motionBlur} writes the same record, now clamped in C++), `DocumentSnapshot.motionBlur/colorManagement` + `motionBlurChanged` / `colorManagementChanged`, the two stores bound in `engineDocumentStores.ts` |
| `documentExtras.ts` | project settings, the SAVED render queue | captured/restored by `cloudDocument` | engine (`setProjectSettings`, render-queue commands; mirror `settings` / `renderQueue`); module deleted with the TS engine | engine-owned in C++ |
| `projectStorage` / `restoredPluginRefs` | JS plugin storage and dependency block | captured into the document | JS plugins are not ported (G2); native SDK sequence data lives in the engine (G1) | retire with G2 |
| `HistoryService` (CommandSystem) + `EngineHistoryEntry` | the undo stack, labels, position, limit | the TS engine's entries live on the app's stack | the C++ `History`; the page reads `mirror.history`, Ctrl+Z / History-panel jumps are already engine requests (`setHistoryRoute`). **Parity: `engine_undo_parity_tests`** | parity suite green |
| `historyStore` legacy debounce recorder (`LEGACY_DEBOUNCE_RECORDER`, `StoreSnapshotCommand`, baselines) | undo for writes made AROUND the engine (whole-store snapshots) | 133 automation sites (`lint:automation-writes`) still write around the engine | delete when the automation-write ratchet reaches 0 (UI writes are already 0); an engine-owned document has no such writes by construction | ratcheted |
| `LocalEngine` per-document state | id counters, key index, project path, saved revision (dirty), open gesture, command log | the TS engine runs in the page | the C++ `Session` has each (ids.ts / key index / `projectPath_` / `savedRevision_` / gesture); the replay log moves from the page to main (C3 limit). **Moved (2026-09-26):** `electron/engineCommandLog.ts` records every applied non-query request main relays (envelope peeks only — main still never decodes a document; `newProject` clears; play/pause/step skipped and view controls replayed as their last value, the client's rules); main renumbers every window's `seq` into its own space (two windows both count from 1) and maps `causedBy` back for the window that caused a batch; after `engine-restarted` MAIN replays the log before any window's request, then tells each window `replayedByHost` — the renderer clients record nothing (`EngineHostStatus.hostCommandLog`) and only refetch | C++ equivalent exists; log in main (`engineCommandLog.test.ts`) |
| `projectStore.tabs[].dirty` + Providers' `markDirty` on bus events | the unsaved indicator | computed from TS bus traffic | `mirror.dirty` (engine `dirtyChanged`, cleared by `saveProject`, restored by undo to the saved revision) | mirror carries it; with the engine as owner `hasUnsavedChanges()` (discard prompt) and the title-bar dot (`ProjectStatus`) read `mirror.dirty` (2026-09-26) |
| `ProjectManager` + `projectDocumentIO` + `bundleProjectIO` / `localProjectIO` | New/Open/Save/Save As/Close: `io.capture()` → storage, storage → `io.restore()`; `.motion` bundles collect footage | the page serializes and parses the document | `EngineDocumentSession` (engine `newProject` / `openProject` / `saveProject` / `revertProject`) — ProjectManager delegates when given `engineDocument` (the F2 flag). `.motion` bundles are written and read by the ENGINE (2026-09-26, branch `f2-motion-bundles`): `saveProject{format}` (`ProjectFormat` auto / json / bundle / portable); the C++ FilePorts read a directory as a bundle and write bundles (bundleCodec chunks + FNV hash, only changed chunks, each temp + rename, manifest last; `motion-blob:` footage the target lacks copied from the source bundle with its registry rows) and portable STORE zips (`native/engine/src/core/bundle_io.cpp`); the TS engine routes the same `format` through its app ports. The page asks for `bundle` where it would have written one (LOCAL_FIRST + `.motion`), Save Portable Copy is `saveProject{portable, copy}` when the engine owns the document. **Open Portable Copy goes through the engine (2026-09-26, `f2-ownership`):** `openProject` of a zip (`bundle_io.cpp read_portable`: STORE entries, a wrapping folder unwrapped, `assets/<file>` written content-addressed (SHA-256) into a staging bundle `<temp>/premation-portable/<fnv(path)>` with registry rows keeping the layer's `assetId`, srcs rewritten to `motion-blob:<sha256>` so a later bundle save collects them); the copy opens UNTITLED with a `portable:` warning; the TS engine does the same through its `readPortable` port; the page (`openLocalMotionFile` → `ProjectManager.openPortable`) only picks a path (`project:chooseOpenPath`) | done behind the flag, jest on both engines; bundles: TS engine green in `bundleCrossEngine.test.ts`, C++ `bundle_io` verified against the page's BundleRepository / codec / unpack (byte-identical manifest), C++ process backend of the test not yet run on a built engine |
| `AutosaveController` + `recovery.ts` (+ worker, localStorage ring) | crash-recovery snapshots of `captureDocument()` | the page captures the document every interval | `EngineDocumentSession.autosave` (`saveProject{recovery, copy}` when `mirror.dirty`) + `recover` (`openProject` + `restoreDocument` as one undoable "Recover Unsaved Work" entry); the cadence is `setAutosave` | done behind the flag; Providers wired (`engineOwnedSession.tsx`: 60 s autosave, recovery prompt — D5/F2 `0ba22139`) |
| `CloudAutosave`, `ApiFileAdapter.createProject`, `VersionHistoryPanel`, `publishTemplate`, `exportMogrt`, `exportManager` | whole-document captures for upload / templates / export | `captureDocument()` in the page | `exportDocument` returns the saved document bytes. **Switched (2026-09-26, `f2-ownership`):** every caller reads the owner's document through `src/core/project/liveDocument.ts` — `liveDocument()` = `exportDocument` when the engine owns the document, `captureDocument()` otherwise (flag off: the page path, unchanged); cloud autosave, cloud Save As (`createProject`), publish template, mogrt, Export JSON. Save Version (bundle) = the engine's `saveProject{bundle}` + the version snapshot recorded beside it (`ProjectBundleService.snapshotVersion`). Version restore is `restoreDocument` | done behind the flag (`liveDocument.test.ts`) |
| `windowSync` (pop-out windows) | the whole document over BroadcastChannel/IPC, both ways | `captureDocument` / `restoreDocument` per settle | a pop-out is a second mirror over the same engine (events relayed by main), edits are engine requests. **2026-09-26:** main relays `engine:events` / state / restart / fallback to the main window AND every pop-out (`EngineHost.getWindows`); a pop-out boots its own owner client (`bootEngine{ownsDocument}` without the lifecycle); the document is no longer sent between windows (`startWindowSync{engineDocument}`) — a window's page replica refreshes from `exportDocument` when main marks a batch `foreign` (caused by another window; `replicaRefresh.ts`, 120 ms debounce, invisible to undo), and a pop-out's first document is fetched the same way. Selection and playhead still travel over the channel (editor state). **2026-10-03:** no page replica, so no refresh — every window reads its mirror | done behind the flag; untested in the real app (needs a built engine) |
| `compositeEdit`, `documentSwap`, `headlessRender` | document snapshots for composite edits, swapping the live document for a render, missing-asset scans | page-side capture/restore | composite edits → batches/`restoreDocument`; render swaps → F1 engine export jobs (`saveProject{copy}` is the snapshot); missing assets → `openProject.missingItems`. **2026-09-26:** with the engine as owner `runAsOneHistoryEntry[Sync]` runs the builder on the page replica and lands the result in the owner as ONE `restoreDocument` entry (no page history push); `withDocumentSwapped` restores the OWNER's document (`exportDocument`) after the swap; `headlessRender`'s missing-asset scan reads `liveDocument()` | composite edits + scans done behind the flag; Versions ▸ Compare still renders on the page's TS still renderer (an engine still of another document needs an engine render of a non-open document — F1 export job of one frame) |
| Selection, keyframe/property selection, `renderQueueStore` running jobs, component/template libraries | ids, UI session state, user libraries | — | NOT document state: stays in the UI (the rule "editor state never enters the document") | stays |

**F1 (2026-09-25): export jobs run in the engine, behind `PREMATION_EXPORT_ENGINE=1`**
(on by default since 2026-09-28; `PREMATION_EXPORT_ENGINE=0` keeps the window path — see D5).
`premation-engine --export JOB.json` (`native/engine/src/export`, protocol and exit
codes in `export_job.hpp`) is one process per job. It opens the project on disk: a
`.motion` bundle, including its asset registry, with `motion-blob:` refs pointed at
`blobs/`, or a JSON document. It then:
- **Preflights** every frame of the range through the scene builder, in parallel.
- **Mixes the audio** with the E2 mixer into the WAV that `encodeWav` writes.
- **Renders** with N build workers (one document copy each) and a render thread
  that keeps 3 frames on the GPU (`SceneRenderer::render_submit` / `take_readback`).
- **Writes** frames to ffmpeg from a writer thread, in order, as straight-alpha
  RGBA8, the raw pipe's own bytes.

The supervisor (`electron/engineExport.ts`) builds the ffmpeg command line with the
Chromium path's `buildEncodeArgs`, so only pixels can differ. Progress, cancel and
the watchdogs are the window path's. Any **fallback** continues the same attempt in
a hidden window, unchanged. These fall back:
- an unported frame found in preflight: layer errors, SVG layers, echo, LUT
  effects, native plugins;
- audio the E2 builder reports as unported;
- no executable, or a GPU that will not start;
- a pass that cannot be honoured mid-render;
- an engine crash. ffmpeg dies with it through a Windows job object, and nothing
  is delivered.

An image-sequence job (`sequence`: `png`, `exr`, `png-zip`, or `exr-zip`) writes
numbered frames, or one STORE zip, instead of spawning an encoder. Chapters on the
job are written to `chapters.ffmeta` (FFMETADATA1, the same text as the editor)
before the encoder starts. A hardware encoder is probed first; if it will not
start, the job encodes with libx264.

Real engine, through the launcher: a kill -9 mid-render gives fallback, with no
file and no orphaned ffmpeg. Cancel gives cancelled. `effect-echo` gives fallback
from preflight. A missing project gives fallback.

**Parity** (`scripts/bench-export-engine.cjs`: both paths end to end from the same
project; raw streams compared through `premation-export-sink`; files by md5).
- 17 of 17 golden scenes whose native-scene frame equals the webgpu frame are
  md5-identical over 30 frames, in the raw stream, mp4 (x264) and mov (ProRes
  4444). They cover keyframes, motion blur, nested precomps, trim paths, puppet,
  layer styles, bevel, dashes, fractal noise, a 3D camera, DOF, spot shadow maps
  and 32 bpc.
- Scenes where the native-scene port is off by ±1–13 stay off by exactly that
  amount (blend-normal ±1 on 19 % of pixels). The export pipeline adds nothing:
  engine frames equal the native-scene frames byte for byte. That is D2w's gap.
- In today's scan, 118 ported scenes are bit-exact against webgpu.
- The bench fixture's text is off by ≤ 228 on 0.9 % of pixels (E3 AA on system
  Arial), so its md5 differs.

**Speed** (RTX 4060 laptop, 8 cores / 16 threads, 1080p, 120 frames; "steady" is
first frame to done):

| comp | path | Chromium | engine | ratio |
|---|---|--:|--:|--:|
| bench fixture (6 shapes + 3 text) | raw pipe, no encoder | 15.6 fps steady, 12.7 fps wall | 186.5 fps steady, 56.3 fps wall | **12×** steady, **4.4×** wall |
| bench fixture | mp4 x264 | 18.1 / 14.2 | 140.2 / 46.2 | 7.7× / 3.3× |
| bench fixture | mov ProRes 4444 | 15.9 / 12.9 | 48.7 / 26.4 | 3.1× / 2.0× (prores_ks bound, 19 ms a frame) |
| heavy (300 shapes + 12 text) | raw | 14.5 / 11.8 | 175.8 / 55.6 | 12× / 4.7× |
| heavy | mp4 | 13.5 / 11.1 | 108.1 / 39.5 | 8.0× / 3.6× |

The exit criterion is met on the raw pipe and on mp4: ≥ 3× both steady and wall
clock. On this machine the Chromium hidden window renders 1080p at 14–18 fps; the
121 fps quoted in §3 was not reproduced here. The engine's wall clock includes
0.73 s of Dawn/DXC start, now overlapped with the project open (0.25 s). ProRes is
bound by the encoder, not the render.

**16-bit.** A job with `bitDepth: 16` (mov only) renders into an rgba16float
surface and sends `-pix_fmt rgba64le`. Binary16 keeps ~11 significant bits near
white. A 16-bit job that falls back is delivered at 8 bits with a warning. Engine
only. **Exposed (2026-09-26):** main answers `export:capabilities` (`bitDepth16` when the engine export flag is on); the Export form offers "Bits per channel 8 / 16" for a mov through the out-of-process export, and `buildSupervisorSpec` carries `bitDepth: 16` (mov only). The Render Queue's Output Module offers it too (2026-09-27, `engine-jobs`; verified in the real app 2026-09-28, below).

**Open:**
- The engine's own native-plugin host and the remaining preflight fallbacks
  (D2w/E4 ports).
- Hardware encoders: the engine export path probes with the same `EncoderProbe`
  as the window path and passes the winner (`libx264` when the device will not
  start). PNG and EXR
  sequences, and chapters already resolved to `{startMs, endMs, title}`, run
  in the engine when the export flag is on, and so do JPEG sequences (WIC on Windows).
- ~~Partial-alpha unpremultiply is only unit-tested; the alpha golden scenes
  cannot run in the CLI.~~ **Done 2026-09-28:** each `alpha-*` scene staged as a
  project folder with its harness media beside it and exported through
  `premation-engine --export` (PNG sequence, the frame alone;
  `scripts/realapp/alphaCli.mjs`): **13/13 within the
  scene tolerance of the reference** (11 at 0.000 %, the two extruded scenes at
  0.047 % / 0.018 %).
- ~~The real-app Render Queue run with the flag on.~~ **Done 2026-09-28** (the
  built app driven over CDP, `scripts/realapp/f1RenderQueue.cjs`): Render Queue ▸ Add
  Comp ▸ Output Module ▸ H.264 MP4 → "started in the engine … completed", 1920×1080
  h264 yuv420p, 120/120 frames; ProRes MOV with **Bits per Channel 16** in the
  Output Module → the engine job file carries `depth: 16`, ProRes 4444
  yuva444p12le, 120 frames. With no flags at all (the new default) the same
  queue job runs in the engine.

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

**G1 GPU run (2026-09-25): the plugin GPU path runs on a real GPU.**
`engine_plugins_gpu_tests` renders the `grade` sample through `render_glue`
inside the render graph on this machine's RTX 4060 (D3D12). At every depth,
SMART_RENDER_GPU (WGSL on the engine's Dawn device) equals its CPU twin, and
the gap is only the chain buffer's rounding: max |diff| 1/255 at 8 bpc,
4.9e-4 at 16 bpc and 4.5e-8 at 32 bpc.

At 16 bpc the two paths legitimately differ on over-range values. The CPU
world is integer 0..32768 and clips, while the GPU buffer is half float. This
is documented in PLUGIN_SDK.md.

GPU faults are contained. `grade`'s new *Debug ▸ GPU Fault* records a draw
with no pipeline. The glue's error scope catches it and drops the command
buffer. The CPU path then renders the exact same picture, and the frame
reports `native-plugin-gpu-error`. No error escapes uncaptured, and the next
frame's GPU render is clean.

A crash inside SMART_RENDER_GPU (child process) disables the instance. The
layer renders as its input.

A fix found by running it: a new device under the same host is now detected.
The glue calls `gpu_device_gone` and drops its textures. Before, the plugin's
per-device pipelines and buffers would have been reused on a device the frame
never submits to.

`premation-render --plugins DIR [--plugin-gpu 0]` renders native-plugin
FrameScenes. `--scene` prints the diagnostics.

Measured at 1080p, as the median of render + submit + GPU idle, cost over no
effect:

| Depth | GPU path | CPU path |
|---|---|---|
| 8 bpc | +0.10 ms | +51.8 ms |
| 16 bpc | +0.54 ms | +183 ms |
| 32 bpc | +2.2 ms | +58 ms |

At 16 bpc, the CPU path's half↔uint16 conversions dominate.

**G1 (2026-09-26): another layer's pixels check out on the GPU, and a lost
device is rebuilt in-process.** The `checkout` sample's Layer Displace is a
GPU effect when Dawn's headers are present: `SMART_RENDER_GPU` reads the map
through `checkout_layer_gpu` and matches its CPU twin (the plugin GPU tests,
8 bpc, one unorm step). A lost device (the render thread sees `Gpu::device_lost`)
drops the slots, the frame cache, the drawer and every plugin's GPU data,
opens a new device, announces a new slot generation and draws the last frame
again. Three losses with no frame between them, or a device that will not
open, is fatal: `OnFatal`, and the supervisor restarts the engine.

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
