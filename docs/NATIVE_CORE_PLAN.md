# Native core plan — C++ engine libraries under the existing Electron/React editor

> Written 2026-09-22 on branch `native-core`, cut from `dev` at `c47c2053`.
> It records the decisions taken in the architecture discussion of the same
> day and the order in which to act on them. Every measured number quotes the
> document it came from so a later reader can re-measure and disagree with
> evidence.
>
> **Status (2026-09-22): T0 landed on `native-core`, everything else is plan.**
> T0 delivered: the two lint boundaries (`eslint.config.js`, with 7
> `TODO(T0)` allow-listed `src/core` files that need a dialog/icon port
> injected rather than a move), 10 hook/store/component relocations out of
> `src/core` and 2 pure modules moved in, GPU frame time via `timestamp-query`
> (`gpuTime` stage, lags 1–3 frames) and a VRAM gauge (`gpuBytes`/peak) on
> the HUD, and the bench ratchet (`npm run bench:check`, `bench/baseline.json`,
> `bench` CI job — non-blocking until **2026-10-06**, then regenerate the
> baseline from a runner artifact and flip `continue-on-error`). Not done from
> T0's list: scrub-latency and RAM-preview-fill benches (need a real decoder
> and GPU; they belong to T3's exit criteria instead).
>
> Companion documents: `ENGINE_STRENGTH_PLAN.md` (the TypeScript-side
> performance program), `VIEWPORT_WORKER_PLAN.md` (why the scene walk is not
> the frame cost today), `AE_COMPARISON.md` (feature gaps against After
> Effects), `COMPOSITING_PLAN.md`.

---

## 0. Decisions, so nobody re-litigates them

| Decision | Choice | Why |
|---|---|---|
| Product | After-Effects-level **desktop** app, sold commercially | No web editor, no collaboration, no render farm. Do not build for them, do not prevent them. |
| Native language | **C++20** | Chosen over Rust for the shorter path to a native plugin tier and eventual AE-SDK compatibility. Its costs (memory safety, build fragility) are contained by §2. |
| UI | **Stays React 18 + TypeScript + Zustand + Radix + CSS modules in Electron 32** | The UI is not the bottleneck. The engine is. A C++ UI (Qt, ImGui) restarts years of work at zero. |
| GPU | **Stays WebGPU with WebGL2 fallback in `packages/renderer`** | The GPU does the work; the language issuing commands does not matter. Nothing in the renderer package moves to C++. |
| Package re-tree | **Rejected** | Eight new packages for ~700 `src/core` files buys nothing a desktop user can feel. Boundaries are enforced by lint (§4 phase 0), carved opportunistically (§4 phase F). |
| "DOM-free engine" | **Replaced by "worker-hostable engine"** | OffscreenCanvas + WebGPU + WebCodecs + `self.fonts` exist in workers. Worker-hostable is what unlocks multi-frame export; fully DOM-free only unlocks the web build we are not doing. |
| CLI and render-worker | **Keep, do not invest as products** | `electron/cliRender.ts` (hidden-window `premation render`) and `packages/render-worker` (HTTP render service) ARE the internal headless capability. They become the desktop export process in phase B. |
| Branch | **`native-core`** off `dev`; feature work continues on `dev` | Native work merges to `dev` per milestone, never as one drop. See §5. |

---

## 1. Where the codebase is today (measured 2026-09-22)

What already matches the target and must **not** be rebuilt:

- `packages/renderer` — ~31k lines: render graph (`rendergraph/`), WebGPU and
  WebGL2 backends (`gpu/backends/`), shaders, resources, compositing, camera.
  Zero React imports; 4 files touch the DOM. Both backends detect context loss.
- `packages/animation` — one track/keyframe/interpolation model, graph-editor
  data, expressions **parsed not eval'd** (CSP refuses `new Function`), so
  expressions are already sandboxed.
- `packages/scene`, `packages/timeline`, `packages/audio`, `packages/workspace`.
- Effects: 204 effect types, metadata-driven; the Inspector discovers
  parameters through `src/components/Inspector/PropertyRegistry.ts`.
- Plugins: capability permissions (`src/core/plugins/capabilities.ts`), worker
  isolation, WGSL/GLSL validation, versioned grammar, native SDK stub
  (`packages/plugin-native-sdk`).
- Workers: demux, decode, bake, encode, recovery, plugin kernel, plugin host
  (`src/core/**/spawn*Worker.ts`).
- Preview and export share `buildSnapshot` + `renderFrameAt`
  (`src/core/export/offlineRenderer.ts` calls the same path the viewport uses).
- Golden-frame gate in CI on SwiftShader (`packages/render-tests`); 1264 test
  files in `src`.
- Per-layer error isolation in `buildSnapshot` (landed 2026-09-21; a throwing
  layer becomes an invisible stub and is reported on `snapshot.layerErrors`).
- `src/core/perf/framePump.ts` — the viewport renders in the same rAF the clock
  advanced (landed 2026-09-21).
- Project migrations (`src/core/project/migrations`), IPC with
  `contextIsolation`, `nodeIntegration:false`, OS sandbox on, `electron/ipcGuard.ts`.
- RAM (512 MB) + disk (4 GB) preview cache, raster LRU, adaptive playback
  resolution.

What is genuinely missing (the reasons for this plan):

| Gap | Evidence | Fixed in |
|---|---|---|
| Engine monolith lives in `src/core`, not in packages, and depends on the page | `src/core/rendering/buildSnapshot.ts` 6241 lines, `AppTextureProvider.ts` 3371 lines; 182 `src/core` files touch `document`/`window`/canvas elements | A, C, F |
| Boundary is real but unenforced | 10 of ~700 `src/core` files import react/zustand (hooks and stores mis-filed) | 0 |
| No per-stage measurement | HUD shows total tick ms only; no GPU timestamp query, no VRAM counter, no CI bench ratchet | 0 |
| Two undo systems | Timeline commands vs 700 ms debounced scene snapshots; timeline layer ids re-minted on every undo | A |
| Desktop crash recovery never writes; saves not atomic everywhere | Desktop QA 2026-09-21 | A |
| WebGPU device loss only invalidates plugin pipelines | `packages/renderer/src/gpu/backends/WebGPUBackend.ts` ~165 | A |
| Export serial, JPEG-per-frame → IPC → disk → ffmpeg re-decode; no multi-frame rendering (fonts not visible in workers) | `offlineRenderer.ts`, `electron/ffmpegStream.ts`, `AE_COMPARISON.md:133` | B, C |
| Video decode on main thread, 2 CPU copies per frame, uncancelled serial seeks | `src/core/video/*` | C, N4 |
| 44 `getImageData` bake sites, 28 Canvas2D-only effects | engine audit 2026-09-15 | N3 |
| Text/shape rasterization is Canvas2D bitmaps | `AppTextureProvider.ts` | N2 |
| Single-frame CPU work is JavaScript | scene walk 2.4 ms @ 500 layers, 9.8 ms @ 2000 (`VIEWPORT_WORKER_PLAN.md` §0); per-frame `JSON.stringify` raster keys | N1, C |
| Broadcast codecs (ProRes, DNxHR) and mixed timelines go through CPU ffmpeg with copies | `electron/ffmpegStream.ts` | N4 |

---

## 2. Ground rules for the C++ side

These go into `CLAUDE.md` so every session inherits them. They are the
substitute for the borrow checker.

**Toolchain**
- C++20. **Clang everywhere**, including `clang-cl` on Windows. One compiler in
  CI and on every dev machine.
- CMake ≥ 3.28 with presets; **vcpkg** in manifest mode with a committed
  `vcpkg.json` + baseline. No system libraries.
- Two targets from day one: **Emscripten → WASM** (runs inside the worker
  engine) and **node-addon-api + cmake-js → N-API** module (runs in the
  export/worker process). A library that builds on only one is not done.
- Ninja generator. ccache/sccache in CI.

**Safety gates (blocking in CI on every push)**
- ASan + UBSan build runs the full Catch2 suite. TSan build runs the threaded
  kernels suite.
- `clang-tidy` with `cppcoreguidelines-*`, `bugprone-*`, `performance-*`,
  `modernize-*`; warnings are errors. `clang-format` enforced.
- `-Wall -Wextra -Wpedantic -Werror -Wshadow -Wconversion`.

**Coding rules**
- No raw `new`/`delete`. RAII for every resource. `std::unique_ptr` by default;
  `std::shared_ptr` needs a comment saying why.
- `std::span`, `std::string_view`, and plain structs at every public boundary.
- **No exceptions cross the C ABI.** Internally exceptions are allowed; every
  exported function catches and returns an error code + message buffer.
- Every public function is a pure function over plain data where possible.
  No long-lived shared mutable graphs across the boundary; the TypeScript side
  materializes a flat frame description (it already does: the snapshot) and
  hands it over.
- `unsafe`-equivalent code (FFI to ffmpeg, Skia, OS APIs) lives only in the
  `*_ffi.cpp` files of `motion_media` and `motion_raster`; reviewed by hand.
- Determinism: no wall-clock reads, no unseeded RNG, no `float` fast-math.
  Same inputs → same bytes on all three platforms (this is what the golden gate
  checks).

**Process placement**
- The N-API module is **never loaded into the main editor renderer process**.
  It loads in the export process (phase B) and the worker engine host. A native
  crash kills a render, never the user's project.

---

## 3. Layout

```text
native/
  CMakeLists.txt            workspace; presets for win/mac/linux/wasm
  CMakePresets.json
  vcpkg.json                skia, ffmpeg, glm, catch2, benchmark, highway
  cmake/                    toolchains, sanitizer + tidy options
  include/motion/           the ONE public C ABI: motion_eval.h, motion_raster.h,
                            motion_kernels.h, motion_media.h, motion_abi.h (version)
  libs/
    motion_eval/            keyframe sampling, interpolation, transforms,
                            matte pairing, expression evaluation
    motion_raster/          path tessellation + text shaping/layout (Skia),
                            glyph atlases → mesh + texture output
    motion_kernels/         CPU effect kernels and bakes, SIMD (Highway),
                            thread pool
    motion_media/           ffmpeg demux/decode, audio decode, frame ring
                            buffers, hardware encode config
  bindings/
    wasm/                   Emscripten glue over include/motion; threads via
                            SharedArrayBuffer (COOP/COEP set in vite + electron)
    napi/                   node-addon-api module over the same headers
  tests/                    Catch2; golden fixtures SHARED with
                            packages/render-tests (same inputs, same expected
                            bytes)
  bench/                    Google Benchmark; JSON results ratcheted in CI
```

Repo-side wiring that must exist for the above:
- `packages/native-bridge/` (TypeScript) — the only place that imports the
  WASM or N-API build. Exposes typed functions; picks WASM vs native by
  environment; falls back to the TypeScript implementation behind a flag.
- `electron-builder.yml` `extraResources` for the per-platform `.node` binary;
  macOS notarization of the binary in the release workflow.
- `packages/plugin-native-sdk` becomes the published copy of `include/motion`
  once the ABI is versioned (phase N5).

Library dependencies (one direction only):

```text
motion_media ──┐
motion_raster ─┼──► motion_kernels ──► motion_eval
               │
bindings/* ────┴──► include/motion (never the reverse)
```

---

## 4. Phases

Two tracks. **Track T** (TypeScript) is the foundation program agreed earlier
today; **Track N** (native) is the C++ program. N cannot start before T0 and T1
because native libraries replace functions *inside* the engine, which must be
isolated enough to swap a function and measured enough to prove the swap helped.

### T0 — Boundaries and measurement (≈2 weeks)

- ESLint `no-restricted-imports`: `src/core/**` may not import `react`,
  `zustand`, `@/layout`, `@/components`; `packages/**` may not import `src/**`.
  Relocate the 10 offenders (`usePagedList`, `useAudioPlayback`, `nodeRevision`,
  `PropertyRegistry` react bits, `uiComponents`, `BakeDialog.tsx`,
  `transitionStore`, `samModelInstall`, `updateStore`, `useAutoUpdate`).
- Per-stage marks in `src/core/perf/framePerf.ts`: snapshot, texture upload,
  GPU passes (WebGPU timestamp queries where the adapter allows), readback,
  encode. VRAM counter from the renderer's resource pool.
- `npm run bench`: scene walk @ 500/2000 layers, 1080p export fps, scrub
  latency, RAM-preview fill rate. JSON output, ratcheted in CI (fail on >10 %
  regression, same adapter class).
- Exit: bench numbers in CI for two weeks; lint green.

### T1 — Reliability (≈3–4 weeks)

- Desktop recovery actually writes (`src/core/persistence/recovery.worker.ts`
  path for file-backed projects); every project save is temp-file +
  `rename` (audit `electron/main.ts` save handlers).
- WebGPU device-loss recovery: re-request device, rebuild resource pool,
  re-upload from the raster cache; viewport shows a one-line notice, not a
  dead canvas.
- **One undo history.** Scene snapshot records become structural-sharing diffs
  pushed as commands on `HistoryService`; the 700 ms debounce goes; timeline
  bars address scene node ids (see `docs` history notes:
  `TimelineController.splitLayerAtFrame` is the pattern). Highest-risk item in
  the plan; ships behind a flag with the full test gate.
- Exit: kill -9 during edit loses ≤ 60 s; save with disk full leaves old file
  intact; `chrome://gpucrash` in the viewport recovers; undo across a
  pre-compose is coherent in both panels.

### T2 / B — Out-of-process export (≈3 weeks, can overlap N0)

- Desktop export runs in a hidden `BrowserWindow` owned by the main process,
  reusing `electron/cliRender.ts`. Queue state lives in main
  (`src/core/export/renderQueuePersist.ts` moves behind IPC); renderer crash
  cannot kill a render, render crash cannot kill the editor.
- Frames go to ffmpeg as **raw RGBA over stdin** (`electron/ffmpegStream.ts`),
  replacing JPEG/PNG → IPC → disk → re-decode. Hardware encoders (NVENC,
  QuickSync, VideoToolbox) become an `encodeArgs` option.
- Exit: editor stays playable during export; export ≥ 2× today's fps on the
  bench fixture; output bit-identical to the previous path at the same CRF
  (golden export test).

### T3 / C — Worker-hostable engine (≈6–8 weeks, overlaps N1–N2)

- Video decode fully in the worker with direct `VideoFrame` upload and
  latest-wins seeks (`src/core/video/decode.worker.ts`).
- Raster cache keys memoized per node revision instead of `JSON.stringify`
  per frame (`AppTextureProvider.ts`).
- Static precomp texture cache.
- Host `buildSnapshot` + `AppTextureProvider` + renderer in a Worker with
  `OffscreenCanvas`; fonts registered via `self.fonts`; HTMLVideoElement paths
  removed (WebCodecs only). Main thread keeps input, UI, and a bitmap
  transfer. `VIEWPORT_WORKER_PLAN.md` §0 says the walk is not the cost today —
  the reason for the worker is **multi-frame export and a never-frozen UI**,
  not the walk.
- Multi-frame export: N worker engines render interleaved frames into the raw
  pipe from phase B.
- Exit: UI stays interactive during a 30 ms frame; export scales ≥ 0.6× per
  added core up to 8.

### N0 — Native tooling (≈2–3 weeks; starts after T1 begins)

- `native/` skeleton per §3, one `motion_abi_version()` function, both WASM
  and N-API builds, Catch2 + Benchmark wired, sanitizer + tidy CI on all three
  OSes, macOS notarization on tags, `packages/native-bridge` with the
  flag + TypeScript fallback.
- Exit: `npm run native:build` produces artifacts on Windows, macOS, Linux and
  WASM in CI; a trivial function callable from the worker engine and from the
  export process.

### N1 — `motion_eval` behind a flag (≈6 weeks)

- Port keyframe sampling, temporal/spatial interpolation, transform matrix
  chain, matte pairing, expression evaluation (the parsed AST from
  `packages/animation/src/exprLang.ts` is serialized and evaluated natively).
- Run side by side with the TypeScript evaluator; diff on the golden gate and
  on every fixture in `packages/render-tests` until **bit-identical**. Then
  flip the default.
- Exit: scene walk ≤ 0.5 ms @ 2000 layers on the bench; zero golden diffs.

### N2 — `motion_raster` (≈8 weeks)

- Skia-based path tessellation and text shaping/layout (HarfBuzz + FreeType
  come with Skia). Output is meshes + glyph atlas textures consumed by the
  existing WebGPU renderer, replacing Canvas2D bitmaps for shape and text
  layers. Canvas2D stays as the fallback for one release.
- Bidi/vertical/kinsoku behaviour must match the current TypeScript
  implementation (goldens in `packages/render-tests` for Noto fixtures).
- Exit: animated-text and vector-heavy bench comps ≥ 3× fps; resolution
  independent zoom.

### N3 — `motion_kernels` (≈6 weeks)

- The 44 `getImageData` bake sites and the 28 Canvas2D-only effects become
  SIMD kernels running across cores (Highway + thread pool); WASM threads in
  the worker engine, native in export.
- Exit: no effect drops the bench comp below 24 fps; CPU-effect export ≥ 4×.

### N4 — `motion_media` (native only, ≈6 weeks)

- ffmpeg demux/decode for ProRes, DNxHR, mixed-codec timelines; frame ring
  buffer shared with WebGPU without a JavaScript copy; audio decode; hardware
  encode presets.
- Exit: 4K ProRes scrub latency ≤ 50 ms; mixed 1080p timeline of 6 clips at
  full rate.

### N5 — Native plugin SDK (≈4 weeks)

- Publish `include/motion` as the versioned C ABI (`packages/plugin-native-sdk`
  becomes real). Third-party code runs in the worker engine host or a
  separate process, never in the editor renderer. AE-SDK compatibility shim is
  a scoped later project on top of this ABI, not part of this plan.

### F — Package carving (continuous, no dedicated phase)

- As `buildSnapshot.ts` and `AppTextureProvider.ts` are split by T3/N1/N2, the
  DOM-free pieces move into `packages/renderer` (or a `packages/engine`) and
  the DOM adapters go behind an interface. Never as a big-bang move.

---

## 5. Branch and merge strategy

- `native-core` is the integration branch for Track N. Track T work lands on
  `dev` as normal feature work (it is engine hygiene the product needs
  regardless).
- Each N milestone merges to `dev` **behind its flag**, with the TypeScript
  fallback intact, when its exit criterion is green. Nothing waits for "the
  native engine to be complete" — that is the rewrite we are avoiding.
- `native-core` rebases on `dev` weekly; conflicts are expected only in
  `buildSnapshot.ts`, `AppTextureProvider.ts`, `offlineRenderer.ts`,
  `ffmpegStream.ts`, `electron-builder.yml`, CI workflows.
- Release: a native milestone ships in a minor release with the flag default
  ON, and the flag stays for one further minor as the escape hatch.

---

## 6. What stays unchanged

`packages/renderer` (render graph, WebGPU/WebGL2 backends, shaders),
`packages/animation` (track model, expression parser), the plugin system and
its permission model, the effect registry and `PropertyRegistry`, IPC security
posture, project migrations, the React/Zustand/Radix/CSS-modules UI stack, the
dock and design-system packages, Playwright and golden gates.

---

## 7. Risks

| Risk | Containment |
|---|---|
| Memory bugs in native code reaching customers | ASan/UBSan/TSan in CI; native never in the editor process; a native crash = one failed render |
| Cross-platform build breakage | One compiler, vcpkg lockfile, all three OSes built on every push not just tags |
| Numerical drift changes existing projects' output | Side-by-side flag + bit-identical golden gate before every default flip |
| Undo unification breaks editing | Behind a flag, full test gate, the `splitLayerAtFrame` reconcile pattern |
| The "parallel engine that switches on when complete" trap | Every milestone replaces a function and merges to `dev`; no milestone longer than ~8 weeks |
| Plugin ABI locked too early | ABI is C, versioned from N0, published only at N5 |
| Contributor pool for the engine shrinks (open source) | Engine stays a minority of the code; UI, plugins, and TS remain the contributor surface |
| Skia build time and size | vcpkg binary cache in CI; Skia only in `motion_raster`; measured binary-size budget in the bench ratchet |
| Two languages, one team | `CLAUDE.md` rules (§2); the agent builds, sanitizers and tidy review |

---

## 8. Timeline (single-team, sequential where dependencies force it)

| Month | Track T | Track N |
|---|---|---|
| 1 | T0 boundaries + measurement | — |
| 2 | T1 reliability | N0 tooling |
| 3 | T1 → T2 export | N1 eval |
| 4 | T2 export done | N1 eval flips default |
| 5–6 | T3 worker engine | N2 raster |
| 7 | T3 multi-frame export | N2 flips; N3 kernels |
| 8–9 | F carving continuous | N3 done; N4 media |
| 10 | — | N4 done |
| 11–12 | — | N5 plugin SDK; hardening |

At month 12 the product is at After Effects level on responsiveness, export
speed, codec coverage and stability for the motion-graphics market. Remaining
gaps are the size of the third-party plugin ecosystem and very large RAM
previews (Chromium heap), which are business and hardware problems.

---

## 9. What we are NOT doing (so the plan does not grow)

- No C++ UI. No Qt, no ImGui, no native panels.
- No move of `packages/renderer` to C++/wgpu.
- No eight-package re-tree of `src/core`.
- No web renderer, collaboration, render farm, or public CLI product work.
- No AE-SDK compatibility shim until N5 is shipped and stable.
- No native module in the main editor process, ever.
