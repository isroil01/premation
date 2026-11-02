# Program X — deep effects (2026-10-19)

Owner ask: "very advanced, deeply integrated effects like After Effects has
but we don't — at least 50 more, very deep in terms of everything."

Premation has 278 effects (`EffectType`). What it lacks is not breadth of
single-pass looks (Program E added sixty of those) but **depth**: effects that
need many passes, a pyramid, other layers, the scene's camera / lights /
depth, the layer at other times, or a simulation that carries state. Those are
what separate After Effects' built-ins (Timewarp, Time Displacement, Match
Grain, Warp Stabilizer, CC Mr. Mercury, Foam, the VR suite) and the plug-ins
AE users buy (Shine, Optical Flares, Saber, 3D Stroke, Deep Glow, Denoiser,
Twixtor) from a filter.

So the program is three engine foundations, then 56 effects built on them.
Every effect is an engine feature (C++ packer + WGSL passes + catalog entry),
never a UI special case; every one obeys the reliability rules (a failed pass
leaves the chain's input, records why, never blanks the frame) and is
deterministic (no wall clock, seeded noise, time only from the layer clock).

## Foundations

| Row | What | Status |
|---|---|---|
| X0 | **FX graph** — a chain entry `fx-graph` that runs a list of passes the packer writes: named slots (the input, the three free pool targets, four float data targets, two half- and two quarter-resolution targets), any registered material with up to four texture inputs, separable Gaussians at any slot's resolution, blend / clear per pass, and the scene depth / a map layer / a mask raster as inputs. Effects become data (packer + shaders), not bespoke chain code. | [x] |
| X1 | **Time taps** — an effect asks for its layer's pre-effect image at other times (≤ 8 offsets); the scene builder evaluates the layer again at each time (content time included: footage frame, precomp time, shape animation) as hidden map sources the chain binds. Deterministic: pure functions of the document and t. | [x] |
| X2 | **Simulation state** — effects that integrate over time (fluid, reaction–diffusion, Mr. Mercury, Foam) step from their start time in fixed substeps with checkpoints kept per (layer, effect, params hash), so any frame is reproducible in any order, and scrubbing forward costs one step. | [x] |
| X3 | **Backdrop slot** (stream D, 2026-11-02) — `BACKDROP` (slot 31): the scene under the layer, copied by the composition pass into `fx-backdrop` before the chain of a layer whose entry carries `readsBackdrop` (`Graph::backdrop()`); such a chain is never kept across frames and never pixel-snapped. Refraction, Displacement Map, CC Glass and Frosted Glass expose it as a Source switch (This Layer / Backdrop); the glass layer style reads it as before. Blank on the 3D route (layer-space chains). | [x] |

## Effects (56)

Each row: type id · what makes it deep · foundation.

### Batch 1 — light, paint, analysis (X0)
| # | Effect | Depth | |
|---|---|---|---|
| 1 | `lens-bloom` Lens Bloom | physically based dual-filter pyramid (6 levels, half/quarter targets), soft-knee threshold in linear light, per-level tint, anamorphic squeeze, lens-dirt from another layer, HDR clamp | [x] |
| 2 | `shine` Shine | Trapcode-Shine class: luminance-sourced volumetric rays by log-step radial accumulation (3 passes ≈ 64 taps), source point, ray length, shimmer (fractal), 3/5-colour colorize over ray intensity, boost light, transfer modes | [x] |
| 3 | `image-flares` Image Flares | screen-space lens system from the picture's own highlights: threshold + downsample, a chain of mirrored ghosts with per-ghost scale / chroma, halo ring, starburst, lens dirt; no light position needed | [x] |
| 4 | `painterly` Painterly | anisotropic Kuwahara: structure tensor → smoothed tensor → 8-sector anisotropic filter; brush size, sharpness, anisotropy, colour quantise | [x] |
| 5 | `watercolor` Watercolor | abstraction (edge-preserving blur) → pigment density from noise, wet-edge darkening from the blurred-gradient, granulation, paper texture, colour bleed | [x] |
| 6 | `ink-outline` Ink & Toon | XDoG edges (two Gaussians, soft threshold) over a cel-quantised, bilateral-smoothed fill; line weight, line colour, levels, halftone shading option | [x] |
| 7 | `detail-upscale` Detail-preserving Upscale | AE's: edge-directed (gradient-oriented) resample to a scale, detail-preserving sharpen, noise reduction | [x] |
| 8 | `paint-bucket` Paint Bucket | AE's: flood fill from a point by jump-flood propagation within tolerance (RGB / luma / hue / alpha), feather, choke, stroke / fill / alpha modes | [x] |

### Batch 2 — other layers & masks (X0)
| # | Effect | Depth | |
|---|---|---|---|
| 9 | `light-wrap` Light Wrap | background layer blurred and wrapped onto the foreground's edge via alpha falloff; wrap width, intensity, background blur, luma bias | [x] |
| 10 | `refraction` Refraction | Displacer-Pro class: height from another layer → normals → refracted lookup with IOR, chromatic dispersion (3 or 7 wavelengths), frosting blur, specular | [x] |
| 11 | `compound-arithmetic` Compound Arithmetic | AE's: 13 operators with a second layer, per-channel / RGB / RGBA, overflow clip / wrap / scale, stretch | [x] |
| 12 | `color-link` Color Link | AE's: matches the layer's colour to another layer's mean / median / brightest / darkest / max-RGB / alpha (GPU reduction pyramid), blend modes, opacity | [x] |
| 13 | `inner-outer-key` Inner/Outer Key | AE's: key from an inner and outer mask path (path rasters), soft edge by distance between them, edge thinning / feather, cleanup | [x] |
| 14 | `energy-saber` Energy Saber | Saber class: an energy core along a mask path (path raster distance), noise-distorted, flicker, multi-octave glow via the pyramid, core / glow colours, start / end offsets | [x] |
| 15 | `ps-arbitrary-map` PS Arbitrary Map | AE's: per-channel arbitrary map (256-entry table), phase, apply to luminance or RGB | [x] |
| 16 | `edge-rays` Edge Rays | rays cast from the layer's alpha / luminance edges away from a centre (Sobel at the edge width, shimmer, 512-tap radial passes) — replaces CC Glue Gun here, which needs a param history over time (later batch) | [x] |

### Batch 3 — immersive (VR) suite (X0)
| # | Effect | Depth | |
|---|---|---|---|
| 17 | `vr-blur` VR Blur | blur on the sphere: latitude-dependent kernel width, wrap across the seam | [x] |
| 18 | `vr-chromatic-aberrations` VR Chromatic Aberrations | radial CA about a sphere point, seam-correct | [x] |
| 19 | `vr-converter` VR Converter | equirect ↔ cubemap 3×2 / 1×6 ↔ sphere-to-plane with FOV, rotation | [x] |
| 20 | `vr-denoise` VR De-Noise | edge-aware NL-means on the sphere, seam wrap | [x] |
| 21 | `vr-fractal-noise` VR Fractal Noise | 3-D noise on the unit sphere (seamless, pole-free), evolution | [x] |
| 22 | `vr-glow` VR Glow | pyramid glow with seam wrap and latitude correction | [x] |
| 23 | `vr-plane-to-sphere` VR Plane to Sphere | places a flat layer onto the sphere at yaw / pitch / roll / FOV | [x] |
| 24 | `vr-sharpen` VR Sharpen | unsharp on the sphere, latitude-correct, seam-correct | [x] |

### Batch 4 — camera, lights, depth (X0 + scene)
| # | Effect | Depth | |
|---|---|---|---|
| 25 | `volumetric-lights` Volumetric Lights | god rays from the comp's own 3D point / spot lights through the scene depth (occluded by 3D layers), scattering, density noise, per-light colour | [x] |
| 26 | `relight` Relight | normals from luma / height (or a normal-map layer), lit by the comp's 3D lights (point / spot / parallel / ambient), specular, wrap | [x] |
| 27 | `volumetric-clouds` Volumetric Clouds | ray-marched 3-D noise clouds seen through the active camera (moves with it), sun direction, Beer–Powder lighting, coverage, wind | [x] |
| 28 | `starfield` Starfield | 3-D star / nebula field placed in world space, camera-correct parallax, twinkle, depth fade | [x] |
| 29 | `cc-environment` CC Environment | AE's: an environment layer reflected on the layer by its luma normals | [x] |
| 30 | `ocean` Ocean | Tessendorf-style sum of Gerstner / FFT-band waves seen through the camera: horizon, Fresnel sky reflection, foam on crests, wind | [x] |
| 31 | `aurora` Aurora | ray-marched curtain bands with noise flow, colour by altitude, stars, camera-aware | [x] |
| 32 | `stroke-3d` 3D Stroke | a mask path stroked in 3D through the active camera: taper, thickness, start / end / offset, repeater (copies with z / scale / rotation steps), bend | [x] |

### Batch 5 — time (X1)
| # | Effect | Depth | |
|---|---|---|---|
| 33 | `timewarp` Timewarp | AE's: speed / source-frame retime of the layer itself with whole-frame, frame-mix or pixel-motion (optical-flow) blending, vector detail, motion blur | [x] |
| 34 | `pixel-motion-blur` Pixel Motion Blur | AE's: optical flow to the neighbour frames, blur along it (shutter angle, samples) | [x] |
| 35 | `time-displacement` Time Displacement | AE's: per-pixel time offset from a map layer's luminance, max displacement, time resolution | [x] |
| 36 | `time-difference` Time Difference | AE's: difference with the layer (or another) at an offset, absolute / alpha channel modes, contrast | [x] |
| 37 | `time-blend` CC Time Blend | accumulation over previous frames with decay and blend mode | [x] |
| 38 | `light-trails` Light Trails | luminance-thresholded trails from previous frames with fading colour ramp | [x] |
| 39 | `datamosh` Datamosh | flow from frame to frame applied to a held keyframe's pixels: I-frame drop look, block size, bleed | [x] |
| 40 | `temporal-denoise` Denoiser | flow-compensated temporal + spatial NL-means across ±2 frames, detail preservation | [x] |

### Batch 6 — simulation (X2)
| # | Effect | Depth | |
|---|---|---|---|
| 41 | `fluid-ink` Fluid Ink | stable-fluids 2-D solver (advection, vorticity confinement, pressure Jacobi) driven by the layer's alpha / emitters, dye advected | [x] |
| 42 | `reaction-diffusion` Reaction-Diffusion | Gray–Scott with feed / kill maps from the layer, colour ramp | [x] |
| 43 | `mr-mercury` CC Mr. Mercury | metaball liquid particles emitted from the layer, gravity, influence map, blob birth / death size, lit mercury shading | [x] |
| 44 | `foam` Foam | AE's: bubbles with physics (wind, wobble, zoom, popping), bubble texture from a layer or built-in, flow map | [x] |
| 45 | `hair` CC Hair | strands grown from the layer, length / thickness / weight / density, light | [x] |
| 46 | `rain-on-glass` Rain on Glass | droplets that grow, merge and run with trails, refracting the layer, fog | [x] |
| 47 | `particle-world` CC Particle World | 3-D particles through the active camera, producer box, physics (gravity, resistance, extra), lines / faded spheres / textured | [x] |
| 48 | `crystal-growth` Crystal Growth | Kobayashi's anisotropic phase-field dendrites (phase + temperature with latent heat), nucleated from the layer at the start time — a deterministic X2 simulation | [x] |

### Batch 7 — analysis & transitions
| # | Effect | Depth | |
|---|---|---|---|
| 49 | `warp-stabilizer` Warp Stabilizer | analysis over the layer's frames (tracker features) → smoothed path; position / scale / rotation or perspective; crop / auto-scale | [x] |
| 50 | `match-grain` Match Grain | AE's: measures a source layer's grain (high-pass variance per channel, frequency) and synthesises matching grain over the layer | [x] |
| 51 | `color-stabilizer` Color Stabilizer | AE's: brightness / levels / curves from sample points at a reference frame (time tap) | [x] |
| 52 | `camera-shake-deblur` Camera Shake Deblur | AE's: picks / blends the sharpest neighbour frames by local sharpness | [x] |
| 53 | `burn-dissolve` Burn Dissolve | transition: noise-driven edge burn with ember glow, char, smoke | [x] |
| 54 | `liquid-morph` Liquid Morph Wipe | transition: flow-warp of A into B along a noise field, chromatic split | [x] |
| 55 | `bend-it` CC Bend It | AE's: bends the layer along a start / end line | [x] |
| 56 | `bender` CC Bender | AE's: marionette / bend / sharp bend between top and base | [x] |

### Batch 8 — on an Object Matte (2026-10-28)
| # | Effect | Depth | |
|---|---|---|---|
| 57 | `matte-stroke` Matte Stroke | an outline around a matte (this layer's alpha, or a Matte Layer's) from its jump-flood distance field (the graph's `field` op = the Alpha Stroke style's fx_distance.cpp), so a soft per-frame Object Matte with no contour strokes cleanly: outside / center / inside, softness, glow (Gaussian of the band), dashes by the contour's angle about the matte's centroid (a 256-column reduction; a whole number of periods round the circle of the matte's own area, so no seam; Offset marches them), on original / on transparent | [x] |
| 58 | `selective-color-ai` Selective Color (AI) | hue / saturation / lightness + colorize in linear light, unclamped, confined to a matte or its outside: a Matte Layer's alpha, or the layer's own Object Matte frame (`alphaMatte`) read as a texture through the layer's placement — the layer is then NOT cut out by it (snapshot_build `objectMatteSrc`); the matte choked by its distance field, feathered by a Gaussian | [x] |
| 59 | `object-matte` Object Matte | After Effects' Object Matte card, added by setLayerMatte to footage that gets an Object Matte (one history entry, the record marked `cutByEffect`): the stored cut-out frame is read as a texture (`fxmatte:<id>`, as #58) and cuts the layer in the shader — Invert and Fine-tune (Shift Edge by the matte's distance field, Feather by a Gaussian, Contrast about the 1/2-contour) are live; Quality, Edge Radius, Decontaminate, Motion Blur, Reduce Chatter and Render Refine Edge are the propagation's, read by the next one (objectMatteEffect.ts). Disabled or removed, the layer shows uncut; a record from before the card still stands in for the footage | [x] |

### Stream D — liquid & glass (2026-11-02)
| # | Effect | Depth | |
|---|---|---|---|
| 60 | `goo` Goo | the metaball / "gooey" filter as an engine effect: the layer blurred, its alpha soft-thresholded so nearby shapes fuse with a meniscus, then shaded from the blob's jump-flood distance field (the `field` op) — a dome normal, directional light, Blinn highlight, Fresnel rim, the blurred layer's own colour or a tint; measured reach (`Graph::measured()`) so a small layer stays scissored. On a precomp of blobs, or on a masked adjustment layer over the scene (adjustment layers honour their masks and opacity since stream D) | [x] |

Matte Stroke differs from the Alpha Stroke style (`stroke`: width / colour /
opacity / position on the layer's alpha) by its matte source, softness, glow,
dashes and composite; Selective Color (AI) from Hue/Saturation, Change to
Color, Tint and Colorama by its matte. Covered by
`src/core/engine/matteEffects.native.test.ts` and the goldens
`effect-matte-stroke`, `effect-selective-color-ai`.

## Status (2026-10-19)

All 56 landed (batches 1–5 with X0 / X1, batches 6–7 with X2). Every one is covered by
`src/core/engine/deepEffects.native.test.ts` on the GPU (PREMATION_GPU_TESTS=1):
it reaches the chain, changes the picture, and the key ones are checked for
what they mean. Engineering notes that came out of it:

- A dynamic graph shader that fails to compile used to invalidate the WHOLE
  frame's command buffer (every fx-graph frame came back transparent). The
  executor now validates each pass's pipeline in its own error scope first
  (`Device::pipeline_error`); a bad shader skips its own effect and is logged
  once (`fx_graph_skipped`), never the frame.
- `map_layer` now draws a precomp source (its subtree offscreen), so a time
  tap — and any layer control — can name a precomp.
- Precomp layers resolve their effects with their layer time: a clock-driven
  effect on a precomp (Program E's too) animates.
- `engine-api:gen` leaves unchanged files alone (a fresh timestamp on the
  protocol headers rebuilt most of the engine).
- X2 simulations live in persistent device targets at their own resolution
  over the layer box (view-independent), checkpointed every 30 frames; their
  inputs are the layer at the start time (a time tap) and their controls, so
  a frame is the same however it is reached. Data copies in a graph go
  through `fxx-copy` (the colour textured draw zeroes a velocity stored with
  alpha 0).
- The closed-form systems (Mr. Mercury, Foam, Particle World) compute each
  particle from its index and the time; Particle World projects and depth
  sorts on the CPU and bins into 32 px screen tiles for the GPU.

## Wiring checklist (per effect)

1. `native/engine/catalog/effects.json` entry (gpuOnly) → `npm run engine-api:gen`.
2. `src/core/effects/effects.ts`: `EffectType` + `EFFECT_DEFS` (same params).
3. `src/layout/Effects/effectCategory.ts`, `src/core/i18n/locales/en.json` `menu.effect.add.<type>`.
4. Packer in `native/engine/src/scene/effects_spatial_x*.cpp` (writes `fx-graph` or a single-pass entry).
5. Shaders `native/engine/shaders/wgsl/fxx-*.wgsl` + `materials.json`.
6. `effects_port.cpp`: opacity blend set, clock set when time-driven.
7. `packages/ai-tools/src/tools/write.ts` effect list; AE importer match name when AE has it.
8. GPU test row in `src/core/engine/deepEffects.native.test.ts`.
