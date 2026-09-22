# Viewport route — C1 measured decision

> Step **C1** of `docs/NATIVE_CORE_PLAN.md`: how frames rendered by
> `premation-engine` (C++, Dawn) get into the Electron viewport. Three routes
> were built and measured on one machine, 2026-09-23. The prototype lives in
> `native/engine/` and `native/engine/proto-host/` and shares no code with the
> app.

## Decision

**Route C — shared GPU textures via Electron's `sharedTexture` module.** It
needs **Electron ≥ 40.0.0**; the app is on 32.3.3, where it does not exist.
So C1's recommendation comes with a prerequisite: **upgrade Electron to 40+
before D5** (engine viewport on by default).

- **A (frame copy) stays as a small fallback**, used at half-res preview only:
  for when a texture import fails (for example the engine and Chromium end up
  on different GPUs, or a remote session), and for platforms where C is not
  proven yet.
- **B (native child window) is rejected.** The viewport can't show HTML on
  top of it — the "airspace" problem, shown in the screenshots below. That
  rules out gizmos, handles, guides, the pen tool and HUDs. Every menu,
  tooltip and popover over the viewport would also need a cut-out in the
  window.

On the same machine and comp, C matched B's CPU cost and kept A's
compositing. It held the full engine rate at 1080p and at 4K, where A
managed about 36 fps and 6 fps.

## Setup

| | |
|---|---|
| Machine | Windows 11 Pro 26200. Hybrid laptop: **AMD Radeon 780M** (integrated) + **NVIDIA RTX 4060 Laptop**. Two displays: internal panel at DPR 2.18 and external at DPR 1.09, 75 Hz. The measurement window ran on the external display. |
| Chromium's GPU | Electron 32 and 40 both choose the **RTX 4060** by default (`app.getGPUInfo`). The engine follows Chromium's adapter, matched by PCI vendor id. A second full run forced both onto the **780M** (`--chromium-gpu=low`). |
| Engine | `premation-engine` in Release, clang-cl, Dawn `20260714.215939`, D3D12 backend. |
| Scene | A tiled textured background plus a rotating textured card, then separable Gaussian blur H and V, then vignette, then the display encode and a 20-bit frame counter. The first three shaders are **WGSL taken verbatim from `packages/renderer`** (`textured`, `blur`, `vignette`), extracted by `native/engine/shaders/extract.mjs`. Intermediates are rgba16float at comp resolution. Pixels depend only on the frame index. |
| Pacing | The engine runs at a 60 fps playback clock (A, C). B is paced by its FIFO swapchain, which is the display's 75 Hz. The "ceiling" run is unpaced. |
| Engine alone | 780M: 1080p render 284 fps, render + readback 312 fps; 4K render 75 fps, render + readback 73 fps. RTX 4060: 1080p 571 / 469 fps; 4K 146 / 114 fps. Source: `premation-engine --route bench`. |

**Definitions.**
- **Frame latency**: engine starts encoding the frame → the page submits it
  inside `requestAnimationFrame` (A, C), or the engine's `Present()` returns
  (B).
- **Cmd latency**: the page stamps a ping, which goes page → main → engine
  stdin → the first frame that carries it → presented. It includes waiting
  for the next frame slot (up to 16.7 ms at 60 fps).
- None of these include scanout. For A and C, add about one display interval
  (13.3 ms at 75 Hz) for DWM and scanout. B pays that too, so its frame
  latency is **not** comparable with A and C; compare cmd latency instead.
- **CPU** is % of one core: the engine's own `GetProcessTimes`, plus
  Electron's `app.getAppMetrics()` for main, renderer and the GPU process.
- Each number is an 8-second steady-state window after a 2-second warm-up,
  with a fresh host and engine per row.

## Results — default GPU (RTX 4060, what the app gets)

| Route | Comp | Electron | Engine fps | Presented fps | Frame lat. p50 / p95 ms | Cmd lat. p50 / p95 ms | CPU % engine / main / renderer / GPU proc | Total CPU % |
|---|---|---|---|---|---|---|---|---|
| A | 1080p | 32.3.3 | 60.0 | **35.9** | 38.7 / 57.2 | 82.6 / 115.2 | 13.3 / 4.8 / 3.1 / 1.2 | 22.4 |
| A | 1080p half (960×540) | 32.3.3 | 60.1 | 59.4 | 13.9 / 25.3 | 40.8 / 53.8 | 7.4 / 1.8 / 1.9 / 1.3 | 12.4 |
| A | 4K | 32.3.3 | 60.0 | **6.7** | 171.3 / 193.2 | 274.5 / 310.2 | 16.5 / 5.5 / 3.2 / 0.7 | 25.9 |
| A | 4K half (1920×1080) | 32.3.3 | 60.0 | 36.2 | 40.3 / 60.0 | 82.0 / 105.4 | 17.4 / 4.7 / 3.2 / 1.2 | 26.5 |
| A | 1080p | 40.10.2 | 60.0 | 43.4 | 34.5 / 48.1 | 67.5 / 91.8 | 12.9 / 4.7 / 3.8 / 1.3 | 22.7 |
| B | 1080p | 32.3.3 | 75.0 | 75.0 | 0.8 / 1.3 ¹ | 20.8 / 24.6 | 8.2 / 0.2 / 0.3 / 0.1 | 8.8 |
| B | 1080p half | 32.3.3 | 75.0 | 75.0 | 0.8 / 1.0 ¹ | 18.8 / 26.3 | 7.4 / 0.2 / 0.3 / 0.2 | 8.1 |
| B | 4K | 32.3.3 | 75.0 | 75.0 | 0.9 / 1.3 ¹ | 23.6 / 24.4 | 8.2 / 0.2 / 0.3 / 0.1 | 8.8 |
| B | 4K half | 32.3.3 | 75.0 | 75.0 | 0.8 / 1.1 ¹ | 21.2 / 25.7 | 6.6 / 0.2 / 0.3 / 0.1 | 7.2 |
| **C** | 1080p | 40.10.2 | 59.0 | **59.7** | 12.6 / 24.3 | 38.6 / 44.2 | 4.8 / 0.8 / 0.9 / 1.9 | **8.4** |
| **C** | 1080p half | 40.10.2 | 60.0 | 59.8 | 11.7 / 21.2 | 34.2 / 42.3 | 4.3 / 0.7 / 0.9 / 1.7 | 7.6 |
| **C** | 4K | 40.10.2 | 60.1 | **59.9** | 12.0 / 19.2 | 38.6 / 40.4 | 5.2 / 0.7 / 0.9 / 1.7 | **8.5** |
| **C** | 4K half | 40.10.2 | 59.9 | 59.9 | 12.1 / 20.8 | 38.9 / 43.9 | 3.3 / 0.7 / 0.9 / 1.7 | 6.6 |

¹ B's number stops at `Present()`, so it excludes the compositor. B always
presents at the viewport's own size: 986×911 physical px here. The 4K comp is
rendered internally and scaled down; that happens inside the page for C.

## Results — everything on the integrated 780M

| Route | Comp | Engine fps | Presented fps | Frame lat. p50 / p95 ms | Cmd lat. p50 / p95 ms | Total CPU % |
|---|---|---|---|---|---|---|
| A | 1080p | 60.1 | 33.8 | 48.0 / 68.1 | 90.9 / 111.9 | 21.0 |
| A | 1080p half | 60.0 | 59.8 | 18.6 / 29.2 | 38.1 / 59.4 | 12.6 |
| A | 4K | 60.0 | 5.8 | 197.2 / 230.9 | 308.5 / 347.7 | 27.9 |
| A | 4K half | 60.0 | 33.7 | 47.6 / 67.8 | 90.7 / 114.4 | 18.9 |
| B | 1080p | 75.0 | 75.0 | 0.7 / 0.9 ¹ | 20.8 / 27.5 | 10.4 |
| B | 4K | 75.1 | 75.1 | 1.0 / 1.2 ¹ | 21.2 / 27.2 | 10.8 |
| C | 1080p | 59.8 | 59.9 | 21.3 / 31.0 | 42.2 / 57.0 | 9.0 |
| C | 1080p half | 59.8 | 59.6 | 14.0 / 26.0 | 31.2 / 52.3 | 7.5 |
| C | 4K | 57.6 | 57.7 | 25.3 / 32.8 | 38.6 / 50.1 | 7.2 |
| C | 4K half | 59.9 | 59.8 | 21.6 / 31.3 | 37.8 / 48.8 | 6.9 |

On the 780M, C's 4K is GPU-bound: the engine takes 13.4 ms per 4K frame on
this chip. A's numbers barely move between GPUs, because A is limited by
copying, not by the GPU.

## Throughput ceiling (engine unpaced, RTX 4060)

| Route | Comp | Engine fps | Presented fps | Frame lat. p50 ms |
|---|---|---|---|---|
| A | 1080p | 440 | 34.1 | 36.7 |
| A | 960×540 | 1681 | 75.0 | 14.8 |
| A | 4K | 111 | 6.0 | 201.5 |
| C | 1080p | 303 | **75.0** (display-bound) | 7.0 |
| C | 960×540 | 406 | 75.0 | 4.8 |
| C | 4K | 115 | **75.0** (display-bound) | 21.0 |

A cannot show 1080p at the display rate no matter how fast the engine is. C
is limited only by the display.

Raw data for every run, including per-stage breakdowns and test results:
`docs/assets/viewport-route/results-{dgpu,igpu,ceiling}.json`.

## Where route A's time goes

1080p, Electron 32, p50 per stage:

| Stage | ms |
|---|---|
| Engine: render + readback mapped | 4.7 |
| Engine stdout → Electron main has the whole frame | 4.3 |
| Main: parse + post | 3.0 |
| **Main → renderer (MessagePort structured clone, 8.3 MB)** | **22.2** |
| Page: `writeTexture` + draw, up to the next rAF | 2.1 |

The main → renderer copy through Mojo is the wall. A standalone microbench
(same Electron, same machine) timed one frame's transfer round trip:

| Frame size | MessagePort | webContents.send | fetch() from a localhost server |
|---|---|---|---|
| 2.1 MB (960×540) | 5.6 ms | 4.6 ms | 11.7 ms |
| 8.3 MB (1080p) | 17.7 ms | 18.9 ms | 36.0 ms |
| 33.2 MB (4K) | 75.9 ms | 77.9 ms | 111.9 ms |

That is about 2.3 ms per MB, whichever transport is used. There is no
cross-process shared memory into a sandboxed Electron renderer. A pipelined
A (two frames in flight) could raise 1080p throughput to about 50 fps; it
cannot lower latency, and 4K stays under 15 fps. Electron 40 improves 1080p
A from 36 to 43 fps and changes nothing else.

## Overlap, resize, DPR, move, minimize

Screenshots are OS-level captures of the screen (`proto-host/tools/shot.ps1`,
`CopyFromScreen`), so they show what the user sees, native child window
included. CDP `Page.captureScreenshot` can't see a child HWND and would have
hidden B's problem.

| Test | A | B | C |
|---|---|---|---|
| HTML dropdown over the viewport | visible ([shot](assets/viewport-route/menu-open-A-1080.png)) | **hidden under the native window** ([shot](assets/viewport-route/menu-open-B-1080.png)) | visible ([shot](assets/viewport-route/menu-open-C-1080.png)) |
| HTML gizmo / overlay text over the viewport | visible | **invisible** (same B shot: no crosshair, no overlay label) | visible |
| Dropdown with a `SetWindowRgn` cut-out (B only) | — | visible ([shot](assets/viewport-route/menu-open-holes-B-1080.png)), but only because the page reports the menu's rect and the engine cuts a hole on every open, close or move | — |
| fps with the dropdown open | 34.7 (steady 34.6) | 103.9 ² | 60.2 (steady 59.9) |
| Real OS click on the viewport reaches the page | yes | yes (child is `WS_DISABLED`, so input goes to the parent) | yes |
| Split-drag resize (1.5 s animated) | page re-lays out at once; 26.9 presented fps during the drag | child follows the page's rect with **p50 14.9 ms, p95 50.1 ms, max 68 ms** lag; the viewport edge visibly trails or overdraws the splitter ([mid-drag shot](assets/viewport-route/split-drag-mid-B-1080.png)) | page re-lays out at once; 43.8 fps during the drag |
| OS window resize, move | fine | fine (child moves with parent) | fine |
| Minimize → restore | engine alive, rate back to 36.9 | engine alive, 75 | engine alive, 60.1 |
| DPR change: zoom 1.25 (DPR 1.36) and moving to the 2.18 display | fine | fine; physical rect re-reported ([zoom shot](assets/viewport-route/zoom125-B-1080.png)) | fine |
| Engine thread stalls 4 s (B: stops pumping messages) | n/a | UI click handled in 1046 ms vs 1053 ms baseline (both mostly PowerShell start-up); window resize 5.9 ms, minimize+restore 40 ms, same as baseline. **The feared attached-input-queue hang did not occur** with a disabled, never-activated child | n/a |

² B's page has no WebGPU canvas; this is the page's rAF rate, not the
engine's rate.

## Route C: what Electron actually offers

- **Electron 32.3.3** (`node_modules/electron/electron.d.ts`) has no
  `sharedTexture` and no `useSharedTexture`. Nothing can bring an external
  GPU handle into a page. Offscreen-rendering shared textures (added in
  33.2.0, #44511) are Chromium → app **output** and don't help.
- **Electron 40.0.0** added the `sharedTexture` module (PR #47317, backport
  #48831; not in any 39.x — checked in the 39.8.5 `electron.d.ts`). What it
  does:
  - main calls `sharedTexture.importSharedTexture({ textureInfo: { pixelFormat, codedSize, handle: { ntHandle } } })`,
    then `sendSharedTexture({ frame, importedSharedTexture })`;
  - the renderer's `setSharedTextureReceiver` gets an object whose
    `getVideoFrame()` gives a `VideoFrame`. WebGPU `importExternalTexture`
    samples that zero-copy;
  - `allReferencesReleased` fires once every process, including queued GPU
    work, has finished with it.
- Handle types: Windows NT handle, macOS IOSurface, Linux dmabuf.
- Pixel formats: `rgba`, `bgra`, `rgbaf16`, `nv12`, `nv16`, `p010le`. rgba,
  bgra and rgbaf16 carry **no keyed mutex and no fence input**.
- The API is marked *Experimental*.
- The prototype ran on Electron 40.10.2 from the local Electron cache. No new
  download was needed.

How the engine side works (`native/engine/src/shared_texture_ffi.cpp`):

1. A ring of 3 D3D11 textures (RGBA8, `SHARED | SHARED_NTHANDLE`), created
   on the Dawn device's adapter, found by LUID.
2. Each is imported into Dawn as `SharedTextureMemory` and wrapped in
   `BeginAccess`/`EndAccess`.
3. `DuplicateHandle` puts each handle into Electron main once.
4. Per frame, the engine renders into a free slot. Chromium takes no fence,
   so the engine waits for its queue to finish on the CPU, then announces the
   slot on stdout.
5. Main imports, sends, and releases. When `allReferencesReleased` fires, main
   writes `free <slot>` to the engine.

Per frame, main takes 0.15 ms and main → renderer takes 1.2 ms.

## What the losing routes cost to keep

- **A (keep, as fallback).** About 250 lines: engine readback ring + stdout
  frames, main relay with drop-to-newest, page `writeTexture`. It is only
  viable at ≤ 960×540 at full rate (59.4 fps, 12 % of a core), or at 1080p
  as a 36–43 fps degraded preview. Keeping it means one more path in the
  golden and real-app tests. It is also the only route with no
  GPU-adapter-matching requirement.
- **B (delete).** Keeping it would mean:
  - the engine draws every overlay the UI draws today in HTML/SVG — gizmos,
    handles, guides, rulers, snapping hints, mask/pen paths, text carets;
  - every floating UI element (menus, tooltips, drag images, toasts, Radix
    popovers) has to report its rect so the engine can cut a region hole;
  - live resize lags the child by about a frame at p50 and three frames at
    p95.

  Its real advantages — lowest CPU (8–10 %), vsync-exact presentation,
  cmd latency about 20 ms — are matched closely enough by C (7–9 %, about
  38 ms). Per the plan, B's code (`child_window_ffi.*`, `run_route_b`, the
  host's rect/holes plumbing) is deleted when C2 starts. It stays in git
  history from the commit that lands this prototype.

## Implications for C2 (engine process + protocol)

1. **Frames and commands travel separately.** The command/event pipe carries
   only small `frameReady { slot, frameIndex, revision, tRenderStart, tDone }`
   events. Pixels never cross it, except on the A fallback, which gets its
   own stream (a second pipe), so a 33 MB frame never queues behind a
   command.
2. **Texture-ring ownership is part of the protocol.** It needs `frameReady`
   and `slotFree`, a bounded ring (3 slots measured), and "all slots busy →
   engine drops, never blocks". Command replay and fuzzing must cover slot
   exhaustion and a UI that stops acknowledging.
3. **`EngineSupervisor` must pin the engine to Chromium's adapter.** Measured:
   with the engine on the 780M and Chromium on the 4060, every
   `sendSharedTexture` timed out and **the page's renderer crashed**
   ("Render frame was disposed"). The supervisor passes the adapter
   (`app.getGPUInfo` vendor/device today; a LUID would be better — Electron
   doesn't expose one). It must respawn the engine when Chromium's GPU
   process restarts or switches adapters, and fall back to A if the import
   fails.
4. **The engine needs `PROCESS_DUP_HANDLE` on Electron main.** That's fine
   for a child of main. Handles are duplicated once per ring slot, not per
   frame.
5. **The viewport protocol is "preview size + DPR", not a window rect.** C
   scales in the page's compositor, so there is no rect sync, no resize lag,
   and no DPR plumbing beyond choosing a preview resolution.
6. **No GPU fence reaches Chromium for rgba.** Until Electron takes a fence,
   the engine CPU-waits for its queue before announcing a slot. That costs
   latency (C 1080p frame latency 12.6 ms p50 on the 4060, of which the
   engine's GPU part is about 5 ms) but no throughput, because of the ring.

## Implications for D5 (engine viewport on by default)

- **Blocker: Electron 32 → ≥ 40.** That is its own work item: Chromium 128 →
  140+, Node 20 → 22/24, and whatever breaking changes that brings. It runs
  through the existing gates: the sandbox tests, the golden gate, and the
  real-app harness.
- The TS-renderer flag and the A fallback cover machines where the import
  fails.
- The HUD's frame time for the engine path must include the page's rAF
  submit, not only the engine's GPU time.

## Dawn in the build

- **vcpkg has a `dawn` port at our pinned baseline** (`20260714.215939`).
  `native/vcpkg.json` gains a manifest **feature `engine`** with Dawn and only
  one backend per OS: D3D12, Metal, or Vulkan + X11. The default install is
  unchanged, so no existing CI job pays for Dawn.
- CMake: `MOTION_BUILD_ENGINE` (default OFF). New presets:
  - `windows-clang-cl-engine` (built and run here);
  - `linux-clang-engine` and `macos-clang-engine` (defined but **never
    built**; the engine compiles routes A and bench only off Windows).
- Command: `node scripts/native.mjs configure|build --engine`.
- **Clean build on this laptop: 16.0 min** — Dawn 12 min, abseil 1.4 min, DXC
  binary 5 s.
- Sizes:
  - vcpkg binary-cache archive for Dawn: **565 MB**;
  - installed tree: 3.6 GB (debug + release; release `webgpu_dawn.lib` is
    1.66 GB with debug info);
  - a later configure that hits the cache: **12 s**.
- Shipped footprint: `premation-engine.exe` 6.8 MB + `dxcompiler.dll` 18 MB +
  `dxil.dll` 1.5 MB. Dawn loads DXC at runtime; the CMake post-build step
  copies both DLLs, because vcpkg's app-local step misses runtime loads.
- For CI: this needs vcpkg binary caching (GitHub Actions cache or a NuGet
  feed), or every engine job pays 16 minutes.

## Open risks

1. **`sharedTexture` is experimental** and may change; it is maintained by
   one contributor. Pin the Electron version; keep A.
2. **macOS (IOSurface) and Linux (dmabuf) C paths are untested.** The
   Electron doc says Linux zero-copy WebGPU import depends on
   `supportsZeroCopyWebGpuImport`. Measure there before D5.
3. **Hybrid-GPU adapter matching** uses vendor id (fine here: one AMD, one
   NVIDIA). Two GPUs from the same vendor are ambiguous without a LUID.
   Windows per-app GPU preference can move Chromium between launches.
4. **CPU wait before announcing a frame**, until Electron accepts a fence.
5. **The Electron 40 upgrade** has not been scoped.
6. **The latency clocks are the system clock**, `Date.now`-anchored in both
   Node processes, about ±1 ms. Page "present" means rAF submit, not scanout.
7. Measured on one laptop, one comp. The scene is light (5 passes). Heavier
   comps make the engine GPU-bound on all routes equally, except that A adds
   its copy cost on top.

## How to reproduce

```powershell
node scripts/native.mjs configure --engine      # first time ~16 min (Dawn), then seconds
node scripts/native.mjs build --engine
native\build\windows-clang-cl-engine\engine\premation-engine.exe --route bench --width 3840 --height 2160
npx electron native/engine/proto-host --route=A --interactive=1          # or B; drag the splitter, open View ▾
<electron-40>\electron.exe native/engine/proto-host --route=C --interactive=1
node native/engine/proto-host/run-matrix.mjs --out=<dir> --electron40=<electron-40>\electron.exe   # the tables above
```

Flags: `--chromium-gpu=low` moves the whole stack to the integrated GPU.
`--fps=0` gives the unpaced ceiling. `--tests=0` skips the scripted
overlap, resize and minimize tests. With tests on, the host moves the real
mouse once, clicks, and restores it.

`native/engine/shaders/extract.mjs --check` fails if `renderer_wgsl.hpp` has
drifted from `packages/renderer`.
