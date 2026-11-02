# Render + scene audit vs After Effects — 2026-11-02 (native-core, read-only)

Method: four code audits (2D compositing core, viewport/texture feed, frame build + caching,
3D/effects/text) plus live frames rendered through the running engine with a diagnostic comp
(hairline, rotated rect, 12 px text, 160 px stroked text, 60 px Gaussian, Multiply/Screen at 50 %,
motion-blurred mover, two intersecting 3D planes, 12 % downscaled checkerboard). Every
`file:line` below was read, and the four top findings were re-verified by hand.

Verdict in one line: the architecture is not naive (float intermediates, premultiplied discipline,
4× MSAA, zero-copy shared-texture viewport, content-keyed caches, per-layer isolation). What makes
frames look worse than AE is a short list of specific wrong choices, most of them one file each.

## Tier 1 — visibly wrong today, fix first

### 1. Any blend mode (except Normal/Add) quantises the WHOLE frame to 8-bit and clips HDR — critical
- **Fixed 2026-11-03 (uncommitted):** `kMatteTarget` declared float (project precision); combine passes the backdrop through untouched where the layer has no coverage (stencils excepted); clamps kept only for modes whose formula needs [0,1]. Not done: scissoring the combine to the layer box.
- `render_graph/frame_build.cpp:802-848` routes every AE mode to `advanced_blend`.
- `render_graph/composition_pass.cpp:1995-2021` copies the scene into `kMatteTarget`, which
  `render_graph/passes.cpp:267` declares `rgba8unorm`; `scene_renderer.cpp:297-302` only promotes
  `rgba16float`/`rgba32float` names, so this stays 8-bit in 16- and 32-bit projects.
- `shaders/wgsl/blend-combine.wgsl:192-193, 299` clamps `cs`, `cb` and the result to 1.0, and the
  combine is drawn full-screen with `Blend::none` into the scene, so pixels outside the layer are
  rewritten from the 8-bit copy (`co = ad*cb` when `as1 = 0`).
- Symptom: one Multiply/Screen/Overlay/Soft Light… layer bands every dark gradient, shadow and glow
  under it; every overbright in the frame is clipped; several blend layers compound.
- Fix: backdrop into a float target (`kFxBackdrop` is already rgba16float, `passes.cpp:273`) or
  declare `kMatteTarget` at project precision; drop the `min(…,1)` clamps except where a formula
  divides; scissor the combine to the layer's covered box (`scissor_of`, `composition_pass.cpp:2062`).

### 2. Luma track mattes are wrong three ways — major
- **Fixed 2026-11-03 (uncommitted):** luma of sRGB-encoded straight colour × α once; inverted = 1 − luma; Stencil/Silhouette Luma use the same luma. Project `linear_blending` is still not wired to rendering (always the non-linear AE default). 4 luma goldens re-blessed.
- `shaders/wgsl/matte-combine.wgsl:21-28`: `val = luma(s.rgb) * s.a` on a PREMULTIPLIED sample
  → luma·α·α (a 50 % white matte passes 25 %). Inverted: `(1-luma)*s.a` → an empty matte region
  passes 0, AE passes 1.
- Luma is taken in linear light (`rg_math.hpp:177`), so sRGB mid-grey passes 21 % not 50 %.
- The matte source is rendered into the same 8-bit `kMatteTarget` (`composition_pass.cpp:1803`).
- Fix: `val = luma` (premul already carries α), inverted `1 - luma`; luma on display-encoded straight
  colour (or expose AE's gamma/linear choice); float matte target.

### 3. Effects on 2D layers run in screen space AFTER the transform — major (parity)
- **Fixed 2026-11-03 for scale:** Renderable.fxScale (the layer's world scale) × the view's px per comp px drives every px radius / width / offset of the 2D chain (and fx_bounds' reaches); a 10 px blur on a 25 % layer is 2.5 comp px at any viewer zoom. Not done: rotation (a directional effect keeps its comp axis on a rotated 2D layer).
- `composition_pass.cpp:2068-2094`: the layer is drawn through its transform into a viewport-sized
  `kLayerTarget`, then the chain runs; `effect_chain.cpp:606` uses `kx = 1` on the 2D route, while
  the 3D route (`threed.cpp:1493-1514`) runs the chain in layer space. The code comment near
  `composition_pass.cpp:140` acknowledges AE runs effects in layer space.
- Symptom: a 10 px blur on a 25 % layer is 10 comp px (AE: 2.5); scale-animated layers keep a
  constant blur; rotated layers get axis-aligned Directional Blur; noise/halftone/grain do not scale;
  a layer changes look when its 3D switch is toggled.
- Fix: route effected 2D layers through the layer-space surface path (raster tier → chain → composite
  with the model matrix), or scale radii/offsets by world scale and rotate direction vectors.

### 4. Opacity is baked in before effects on the matte / blend-mode / backdrop-blur routes — major
- **Fixed 2026-11-03 (uncommitted)** for the matte and blend-mode routes and plain backdrop blur; glass still bakes opacity into its panel coverage (its shader has no opacity slot).
- Main path is right (`composition_pass.cpp:2082` draws at 1, opacity at composite `:2060`), but
  `layer_into_target(ctx, r, r.opacity, …)` at `:1802`, `:1895`, `:2000` applies opacity before
  `apply_layer_effects`. Any non-linear effect (glow threshold, levels, Set Matte, styles) on a 50 %
  layer with a matte or a blend mode renders differently from the same layer without one.
- Fix: pass 1 and multiply opacity inside `emit_matte_combine` / `emit_blend_combine`.

### 5. Live-scene bugs seen in the open project (not from code reading)
- **Re-checked 2026-11-03:** neither is an engine bug as described. The pinholes are the layer's own **Noise** effect (fx_9, amount 25, monochrome) after the Object Matte; the saved matte (Object Matte/layer_3/subject_000180_*.png) has 28 stray edge px of 272k solid. The text did not move from the weight edit: its x moved too (960 → 1054), which re-centred point text cannot do, so its position was rewritten; the audit's call sequence replayed headless (sequential and parallel, panels + GPU) keeps it in place. Guard: src/core/ai/textStyleKeepsPlace.native.test.ts.
- Subject cut-out (`featured-16-9_nubian-08-topaz.jpg (subject)`): the matte has dense white
  pinhole noise across the whole body (source image is clean). The still-subject matte needs a
  morphological close / hole fill before it is usable; this is the most visible defect in the
  project that was open.
- Text layer position drifts after a style edit: a 12 px Arial text created at y=120 rendered at
  y≈120, then moved to y≈197 after `fontWeight` was changed, and stayed there when changed back
  (`inspect_layers` bounds y 190..204 for a layer whose `y` is 120). Reproduced twice; root cause
  not isolated (suspect the text anchor/box being recomputed from a stale layout).

## Tier 2 — structural gaps against AE

### 6. The frame cache is keyed by the VIEW, not by comp pixels — critical for the editing feel
- **Fixed 2026-11-03:** a view scale off the power-of-two ladder draws the comp at the next tier up (zoom = tier, dpr 1, phase 0) and the render thread places it scaled (Compositor::place); every zoom inside a tier and every pan share the cached frames. Ladder zooms keep the exact copy. Verified live at Fit (51 %). Not done: raising the 8192 side cap to the device limit.
- Frames are drawn at viewport px × preview scale (`scene/engine_frames.cpp:516-531`) and the
  key mixes `width,height` (`:1185-1186`); a zoom opens a new cache scope ("the bar starts over",
  `core/session.cpp:2205`); comp-space caching is refused above 2× slot / 8192 px
  (`core/frame_scene.hpp:421-424`); channel view / exposure / LUT force slot space.
- Symptom: `,`/`.` or Fit empties the green bar; two panes at different zooms hold two copies;
  a 4K comp above ~2.1× never caches. AE caches comp-resolution frames once; zoom/pan is free.
- Fix: cache the comp at its resolution tier as the unit and apply zoom/pan/channel/exposure/LUT in
  the final blit; raise the 8192 cap to the device limit (already 16384 in `device_limits.hpp`).

### 7. One build thread, one GPU thread, one prefetch frame at a time — critical for heavy comps
- **Fixed 2026-11-03:** prefetch workers (one per four hardware threads, at most two; PREMATION_PREFETCH_WORKERS) build render-ahead frames with builders and expression caches of their own under a shared build lock; plugin calls stay one at a time; a frame that samples layer pixels goes back to the main worker. The render thread queues four prefetch jobs (was one). Render-ahead also runs while a play is served from the tiers, inside the play range. Not done: parallel builds of the frames a viewport shows.
- `core/session.cpp:2787-2806` single build worker; idle prefetch submits one frame and waits
  (`:2041-2054`, `render/render_thread.cpp:1010`), after a 300 ms quiet period, disarmed while
  playing. The 657-layer film is 64 ms build + 3 ms draw per frame on one core (AUDIT 10-22).
- Fix: N build workers with their own `DocExprEnv`/`WalkCache` filling distinct frames; a small
  prefetch queue on the render thread; prefetch while playing from cache.

### 8. Invalidation is "whole comp" for almost every edit — major
- **Narrowed 2026-11-03:** a static edit re-keys only the frames its layer draws when nothing else reads it (no expressions, not named by another layer, no children); guides, swatches, asset labels, project display settings, layer names and marker text (without expressions) are no longer keyed; a static edit that leaves the static hash unchanged re-keys nothing. Not done: nested comps keyed per frame.
- `core/frame_keys.hpp:415-418` returns `all` on any static change; `static_of` hashes markers
  (`:993-1014`), asset records (`:1019`), guides and swatches (`:1037-1038`), full project
  settings; nested precomps hash their whole animation; any `loopOut`/`valueAtTime`/`key()` sets
  `global_` so every track hashes whole. Only a keyframe edit on a top-level layer narrows to ±3.
- Symptom: renaming a marker or nudging a static layer rebuilds every frame (60–95 ms each on
  heavy comps). Fix: drop non-rendering inputs from the hash; per-layer static spans bounded by
  the layer's in/out; nested comps keyed per frame through the parent's clock.

### 9. Intermediate caches are tiny fixed slot counts — major
- **Fixed 2026-11-03:** chain caches are 48 slots under byte budgets (640 MB layer, 256 MB 3D surface, LRU), precomp cache 512 MB.
- `LayerFxCache` 8 slots (`composition_pass.cpp:741`), `PrecompCache` 256 MB with 120-frame idle
  expiry (`:411-414`), 4 SDF slots. Nine static glowing titles re-run their chains every frame.
- Fix: one byte-budgeted LRU for chain results + precomp images, keyed as today, evicted on pressure.

### 10. Preview resolution rebuilds the texture ring; ROI is a clip, not a render region — major
- **Fixed 2026-11-03:** slots stay the viewport's full size; a reduced frame is drawn into the slot's corner (FrameReady.contentWidth / Height), the preload crops it (VideoFrame visibleRect) and the page upscales it pixelated. Live: Auto → Half shows its next frame in ~100 ms with no ring rebuild. ROI culls root-level layers outside it (no effects, no motion, not 3D). Not done: comp-space caching with an ROI.
- Full/Half/Quarter changes the slot size, which is part of the ring config
  (`frame_scene.hpp:360-363`); `src/stores/renderQualityStore.ts:139-144` records the 0.3–1.7 s
  freeze and that the cache misses at the other size — which is why adaptive resolution during
  playback was disabled. The page then upscales bilinearly (`frameBlit.ts:137`) instead of AE's
  blocky nearest.
- `regionOfInterest` only narrows the clip rect (`scene/native_scene.cpp:150-165`) and disables
  comp-space caching (`frame_scene.hpp:374-378`): an ROI can make scrubbing slower.
- Fix: keep the ring at full size, render into a sub-rect at the reduced scale, nearest-upscale in
  the final blit; pass the ROI into `visibleWorldRect` and chain boxes so layers outside are culled.

### 11. Nothing is pixel-exact in the viewer — major
- **Partly fixed 2026-11-03:** Zoom In / Out step AE's ladder; a wheel zoom within 1.5 % of a stop takes it; pans, zooms and Fit settle the comp origin on a whole device pixel. Not done: 100 % = one comp px per device px.
- `packages/workspace/src/camera/Camera.ts:127-137` zoom is an arbitrary float after any wheel
  zoom; no rounding of `offsetX·dpr`; "100 %" is 1 comp px = 1 CSS px (then × DPR); +/− steps ×1.2
  (`WorkspaceController.ts:288-294`) instead of AE's 12.5/25/50/100/200 ladder.
- Symptom: at "100 %" a 1080p comp never looks like its export; thin lines and text soften after a
  wheel zoom. Fix: snap pan to device pixels at gesture end, define 100 % as 1 comp px = 1 device px,
  step the preset ladder.

### 12. Viewer colour — major
- **Partly fixed 2026-11-03:** View ▸ Adjust Exposure applies on the OCIO route. Not done: 8-bit output surface, screen-fixed checkerboard, gamma-space compositing option.
- Output slots are RGBA8 (`shared_texture_ffi.cpp:88`), canvas has no `colorSpace`, so no HDR or P3
  display; PQ/HLG display transforms are tone-mapped onto 8-bit SDR.
- `render_graph/passes.cpp:88-91`: exposure is not applied on the OCIO route — View ▸ Adjust
  Exposure does nothing with colour management on.
- Transparency checkerboard is a 16-comp-px layer under the comp (`snapshot_build.cpp:2662-2683`)
  so it zooms with the picture and is cached as content; AE's is screen-fixed. No alpha-boundary /
  alpha-overlay in the comp viewer.
- Compositing is always linear-light (`rg_math.hpp:176-185`, `color_settings.cpp:98-100` maps
  srgb/rec709/srgb_linear all to linear); AE's default is gamma-space, so 50 % mixes, AA edges,
  blur and feather falloffs read lighter/wider than the same project in AE.

### 13. 3D: translucent layers write depth; shadows are 3×3 nearest PCF — major
- **Fixed 2026-11-03:** planar layers lay fully covered texels first, then partly covered ones back-to-front; shadows are 12 Poisson taps each a bilinear 2×2 comparison. Not done: transmission-tinted shadows, per-fragment lighting on every planar layer.
- `threed_port.cpp:2009-2079` sorts a depth run by projected anchor depth; `threed.cpp:1870-1873`
  writes depth for every texel with α ≥ 1/255 (`textured3d.wgsl:762`), so a farther layer drawn
  later is rejected behind a 50 % card or an AA rim. Live test: two intersecting opaque planes
  intersect correctly.
- `threed.cpp:1226-1228` + `mesh3d-pbr.wgsl:246-253`: nine nearest taps, diffusion capped at 16
  texels → stepped penumbra; one 512–2048 map fitted to the whole scope; Light Transmission tint
  exists only on the projected-copy path, so a coloured translucent caster drops a black shadow.
- Planar layers get one lit colour per layer (`threed_port.cpp:690-694`) unless the per-fragment
  path fires (`threed.cpp:1431-1436`) — spot cones and falloff across a big card are flat.
- Fix: depth-write only for α ≈ 1, opaque first then translucent back-to-front; Poisson/PCSS with a
  comparison sampler; RGBA transmission map; always pack `RenderShade3D` when any light exists.

### 14. Blur / vector / text quality — major to minor
- **Partly fixed 2026-11-03:** Fast Box Blur is a true box × Iterations; Repeat Edge Pixels on footage; adjustment layers honour their blend mode; Luminescent Premul keeps colour past alpha; Alpha Add sums coverage; hardware Multiply keeps the backdrop; shutter up to 720°. Not done: blur pyramid above σ≈12, Bézier path operators, float text/shape rasters, Corner Pin LOD, distance-ramp mask feather, parent/expression motion blur, scrub latency.
- `blur.wgsl:160-162`: above σ ≈ 12 taps are spaced > 1 texel with bilinear filling, no pyramid;
  `fast-box-blur` is the same Gaussian, not a box; no Repeat Edge Pixels on gaussian-blur/blur.
- `scene/path_ops.cpp:188-216`: Trim/Offset/Round Corners/Merge flatten Béziers to 2.5 px
  polylines and write corner points back, so scaled-up operated paths facet and write-on steps.
- `canvas_ffi.cpp:285,391,709`: text/shape rasters are 8-bit; gradient fills band before the float
  pipeline (F16 canvas exists at `:278`, unused for these).
- Corner Pin / Bézier Warp / Displacement sample LOD 0 with hard edges (`corner-pin.wgsl:23,138`).
- Mask feather is a Gaussian σ = feather/2 (`raster/mask_paint.cpp:173,281`), not AE's distance
  ramp; expansion is a vertex offset, not a true offset curve.
- Motion blur ignores parent/expression-driven motion (`snapshot_build.cpp:1034` inspects only the
  layer's own tracks) and clamps shutter to 360° while the UI allows 720.
- Adjustment layers ignore their blend mode (`composition_pass.cpp:1817-1877`).
- Luminescent Premul degenerates to Normal (clamp at `blend-combine.wgsl:230-231`); Alpha Add keeps
  a dark seam (`:222`). Hardware `multiply = {Dst, Zero}` (`device.cpp:26`) punches black holes if any
  plugin ever picks it.
- Scrub path: ~40 ms command latency through 7 hops via main's JSON IPC (`VIEWPORT_ROUTE.md:69`);
  no per-frame stale/dropped cue in the viewer (HUD only, off by default).

## Live-frame results (diagnostic comp, deleted afterwards)
- Sub-pixel translation: smooth (1 px rect at y=60 → two 50 % rows; at y=60.5 → one full row). OK.
- Rotated rect edges: clean analytic AA. OK.
- 60 px Gaussian on a 220 px rect: grows well beyond the layer rect, no clipping. OK.
- Motion blur on a 600 px/s mover: ~10 px smear at 180°, correct averaging; faint dark right edge at
  t=0 (shutter samples clamped at the start of the comp?) — minor.
- Two intersecting 3D planes: correct intersection line, no z-fighting. OK.
- 12 % downscaled checkerboard: visible moiré (AE's bilinear also aliases; AE's Bicubic does better).
- 12 px text: soft, unhinted — comparable to AE. 160 px text with a 24 px stroke: stroke under fill,
  AE default. OK.
- Multiply / Screen at 50 % over light grey: plausible values (but see #1 for what it did to the
  rest of the frame's precision).

## What is genuinely strong (keep)
Float intermediates with 4× MSAA and dithered sRGB output; consistent premultiplied math and
premultiplied mips; analytic layer-edge AA; trilinear + 16× aniso sampling with raster tiers up to
64× for continuous rasterization; all 36 AE blend formulas present with the W3C alpha line; coplanar
clustering + reversed float depth; mattes/blends inside a depth run; camera motion blur with
adaptive samples; grow-bounds scissoring verified bit-for-bit; effect isolation per pipeline;
HarfBuzz/Skia/SheenBidi text with text-on-path and variable fonts; robust polygon clipping;
zero-copy shared-texture viewport holding 60 fps at 4K with no React render per frame; audio-master
clock with frame skipping; content-keyed VRAM/RAM/disk tiers with a protected play range; per-layer
error isolation, GPU-error quarantine, device-loss recovery and memory-pressure relief; a hardware
zero-copy media stack with correct colour matrices.

## Suggested order
1 → 2 → 4 (all `composition_pass.cpp` + two shaders, one or two days together), then 5 (two live
bugs), then 3 (layer-space effects), then the cache trio 6/8/9, then 7 (multi-frame), 10/11/12
(viewer), then 13/14.
