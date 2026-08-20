# Premation vs Adobe After Effects — Feature Comparison & Gap Analysis

> **Basis of comparison:** Premation `dev` as of 2026-08-20 (every Premation claim
> verified against source — registries, tests, and shipped commits, not prose) vs
> **After Effects 26.3** (June 2026 release; 26.0 shipped January 2026).
> Where a count is stated, a test or registry in this repo pins it.

## 1. Executive Summary

| Dimension | Premation | After Effects 26.3 | Verdict |
|---|---|---|---|
| Platform | Electron + React 19 + TypeScript + WebGPU/WebGL2 | C++ native (incl. native Windows-on-ARM since 26.0) | Modern, portable |
| Render determinism | One pipeline for preview and export (`buildSnapshot` → render backend) | Preview (Mercury) vs Render Queue / AME are separate paths | **Premation wins** on WYSIWYG |
| Color | Linear working space (`srgb-linear`, ACEScg), ACES ODT, 16/32-bit float RTs | OCIO/ACES, 32-bpc, Display Color Management | Parity on internal math; **HDR (PQ/HLG) delivery still open** here |
| Expressions | Hand-written safe language (`packages/animation/src/expressions.ts`, ~50 identifiers) + value/speed graph editor | Full JavaScript (ES6+) | Very high parity for motion-design idioms |
| 2D rigging | Bones, FK/IK, FABRIK solver, weight painting, ARAP puppet (`src/core/rig/`) | Puppet pins only; bones need Duik/Limber | **Premation wins natively** |
| Tracking | Multi-point tracker on the exact decoder; Follow, Stabilize, Corner Pin, mask tracking, 2-point solve, **Smooth Stabilize (dense optical-flow similarity + Gaussian path smoothing — shipped 2026-08-20)** | Point tracker, 3D Camera Tracker, Warp Stabilizer VFX, Mocha planar, Roto Brush 3 | Narrowed to: 3D camera tracker, dense planar, subspace warp/rolling shutter, AI roto |
| AI integration | 61 typed tools (read 7 / write 24 / craft 17 / compose 13), deterministic Caster/Director runner | Sensei / Firefly (generative fill, Roto Brush 3) | Premation has native agentic automation |

## 2. Feature-by-Feature

### 2.1 Timeline & sequence editing

| Feature | Premation | AE 26.3 | Status |
|---|---|---|---|
| Layer/clip model | Multi-clip bars per track (start, duration, sourceIn/Out) | One source per layer, in/out trims | Parity (+ multi-clip per track) |
| Trim/split/slip/slide | All present | All present | Parity |
| Time remapping | `remapTime` curve, freeze, reverse, sequence bars | Time Remap + speed graph, stretch, freeze | Parity |
| Frame blending | Frame Mix + **Pixel Motion** (deterministic optical-flow warp, shipped 2026-08-20; real-footage visual pass pending) | Frame Mix + Pixel Motion | Parity |
| Responsive/protected time | `responsiveTime.ts` regions | Responsive Design — Time | Parity |
| Markers | Comp + layer markers, duration, color (`layerMarkers`, `markerShortcuts`) | Comp + layer markers, cue points | Parity |
| Interpret Footage | fps, PAR, alpha, looping, **Separate Fields (upper/lower, deterministic single-field bob — shipped 2026-08-20)** | Same + 3:2 pulldown removal | Near parity — pulldown detection still open |

### 2.2 Keyframes & expressions

| Feature | Premation | AE 26.3 | Status |
|---|---|---|---|
| Interpolation | Linear, hold, bezier, continuous, **roving** (`interpolate.ts` retimes roving runs for constant speed), spatial auto-tangents | Same set | Parity |
| Graph editor | Value + speed graphs, handle editing, Easy Ease, presets | Same | Parity |
| Generators | Physics bounce (`bounce.ts`) | Keyframe assistants + expressions | Parity |
| Expression engine | ~50 identifiers incl. `wiggle`, `valueAtTime`, `velocityAtTime`, `loopOut` (with working `pingpong`), `sourceRectAtTime`, `key(n)`, `numKeys`, and `audio` (amplitude 0..1 at the playhead) | Full JS; 26.0 adds per-character styling via expressions | Parity for standard motion; no arbitrary JS by design (CSP-safe sandbox, no host-realm eval) |

### 2.3 Compositing, mattes, masks

| Feature | Premation | AE 26.3 | Status |
|---|---|---|---|
| Blend modes | **38** — all of AE's 38 (pinned by `blendMode.test.ts`), incl. stencil/silhouette matte modes and deterministic Dissolve / Dancing Dissolve (shipped 2026-08-20) | 38 | Parity |
| Track mattes | Alpha/Luma ± inverted, decoupled from layer order | Decoupled pick-whip (since AE 2023) | Parity |
| Masks | Bezier, 7 modes (pinned by `MaskMode`), expansion, opacity, uniform feather, **variable-width per-vertex feather (distance-field renderer, shipped 2026-08-20)**; effect-scoped masks | Same | Parity |
| Layer styles | **10** = 9 in `LAYER_STYLE_LABEL` + backdrop `glass` in `BACKDROP_STYLES` | 9 Photoshop styles | Parity (+ backdrop glass) |
| Continuous rasterization | Collapse transforms, vector CR for precomps & SVG | Same toggle | Parity |

### 2.4 Effects & color

| Feature | Premation | AE 26.3 | Status |
|---|---|---|---|
| Effect stack | **174** effects (`EffectType` union, completeness-tested; incl. Keylight, Curves, Lumetri, Corner Pin, Bezier Warp) | 400+ (26.0 adds **Unmult** with 32-bit HDR) + third-party ecosystem | High coverage of the used set |
| Keying | Full Keylight parameter set (`keylight.ts`) | Keylight 1.2 | Parity |
| Color spaces | ACEScg, linear sRGB, 16/32-bpc intermediates, ACES ODT, CUBE LUT import with GPU parity tests | OCIO, 32-bpc, HDR delivery | Parity on math; HDR **output** open (Tier 3) |
| Extensibility | Sandboxed Web Worker plugins + custom WebGPU/WebGL2 shader effects | C++ AEGP/Effect SDK | Different models; Premation's is sandboxed |

### 2.5 Text & shapes

| Feature | Premation | AE 26.3 | Status |
|---|---|---|---|
| Text animators | Per-character 3D, range/wiggly selectors (`textSelectors.ts`) | Range/Wiggly/Expression selectors | Parity |
| Text on path | `textPath.ts` — margins, perpendicular, reverse | Same | Parity |
| **Variable fonts** | **Keyframeable continuous weight (1–1000, `fontWeight` track — shipped 2026-08-20)**; wdth/slnt axes not yet (they don't survive the canvas font shorthand) | 26.0: keyframeable weight/width/slant | Partial parity — weight covered |
| SVG import | SVG parsing + continuous rasterization | **26.0: native SVG → editable shape layers with gradients** | Rough parity now — AE caught up |
| Path operators | **9** chainable (`PathOpType`: zigzag, roundCorners, pucker, twist, offset, roughen, trim, repeater, **wiggleTransform** — shipped 2026-08-20, per-run so repeater copies wander independently) | Same set | Parity |

### 2.6 3D & rigging

| Feature | Premation | AE 26.3 | Status |
|---|---|---|---|
| Cameras | 1/2-node (`cameraOrientation`), DoF, **quad view** (`quadViewModes`) | Same | Parity |
| Lights | 4 types (`LightType: point, ambient, spot, parallel`), falloff, cone feather, Blinn-Phong | 4 types + cast shadows | Parity |
| Geometry | Extrusion + bevels + per-face materials (`FACE_SURFACE_IDS`) | Advanced 3D: glTF import **+ 26.0 parametric meshes (cube/sphere/cone/torus/cylinder) + 1,300 Substance PBR materials + "Accepts Lights" toggle** | ⚠️ Gap (Tier 2) — and deliberately so: imported models/PBR/HDRI are out of scope per `docs/3d-layer-model.md`; the target is Classic-3D + extrusion |
| Rigging | Bones, FK/IK with FABRIK (`solveFabrik`, N-joint), IK/FK blending, geodesic auto-weights, weight painting, ARAP puppet, bend pins, controllers, presets | Puppet pins; bones via paid third-party | 🏆 Premation outclasses native AE |

### 2.7 Footage, audio, export

| Feature | Premation | AE 26.3 | Status |
|---|---|---|---|
| Decoding | **Shipped:** WebCodecs exact path (`exactVideoFrames.ts` is the render path's first choice — viewport and export), mp4box demux + GOP/B-frame index, element-seek as permanent fallback for WebM/odd containers | Native importers | Done — no longer a gap |
| **Import breadth** | Browser-decodable codecs (H.264/HEVC/VP9/AV1 in MP4/WebM) + ffmpeg fallback; image sequences (`imageSequence.ts`); Lottie **import** | **EXR, DPX/Cineon, MXF, camera raw (R3D/BRAW/ARRIRAW), layered PSD/AI** | ⚠️ **Gap (Tier 1–2)** |
| Tracking applies | Follow, Stabilize, Corner Pin, mask tracking, 2-point solve, **Smooth Stabilize** (dense flow → robust similarity per pair → Gaussian-smoothed path; jitter cancels, deliberate pans survive — test-pinned) | Tracker panel + Warp Stabilizer VFX + 3D Camera Tracker | Subspace warp and 3D solve remain |
| Audio | Multi-voice engine: mixdown, dB automation, per-clip effects, spectrum, waveforms, solo, `audio` expression | Basic playback + keyframed levels; **26.0 adds Gate, Compressor, Distortion** | Comparable — different strengths (was "better than AE"; AE 26 narrowed it) |
| Export | ProRes 4444 w/ alpha (`prores_ks`, `yuva444p10le`), MP4 (libx264), WebM, GIF, PNG/JPG sequences, **Lottie/bodymovin JSON** (AE needs a plugin for that) | AME formats incl. HEVC, EXR | Parity for web/broadcast delivery |
| Caching | RAM preview + **persistent content-addressed disk cache** (`frameDiskCache.ts` + `sceneContentHash.ts`, shipped 2026-08-17): content-hash generation keys, parked generations, manifest reconcile — undo gets frames back, a restart inherits the previous session | Persistent global cache; **26.0 adds lossless compressed cache format** | Parity |
| Templates | Template fields — Essential Graphics analog, responsive time | Essential Graphics + **`.mogrt` interchange with Premiere** | ⚠️ Gap (Tier 3, ecosystem) |

## 3. Gap Matrix (current)

**🔴 Tier 1 — high impact**
1. AI rotoscoping (Roto Brush-class foreground extraction) — un-gated now that the exact decoder + tracking column shipped
2. Import format breadth: EXR, DPX, MXF, camera raw, layered PSD/AI

**🟡 Tier 2 — pro workflow**
4. Subspace warp & rolling-shutter repair (similarity-model Smooth Stabilize shipped 2026-08-20; the per-region warp is the remainder)
5. 3D camera tracker & dense planar tracking (point/corner-pin/mask tracking shipped)
6. Content-Aware Fill for video
8. glTF/3D model import — *explicitly out of scope by design; listed for honesty, not planned*

**🟢 Tier 3 — niche/finishing**
9. 3:2 pulldown removal (field separation shipped; telecine detection is the remainder)
10. Variable-font wdth/slnt axes (weight shipped; the other axes need a non-shorthand rasterization path)
11. HDR (PQ/HLG) delivery
12. `.mogrt` interchange with Premiere

**Removed from earlier drafts (shipped):** ExactVideoSource renderer integration
(commit `a983511`); point tracking, stabilize, corner pin, mask tracking
(commits `52bfa40`, `98574d7`, `0f6a89c`); persistent content-addressed
disk cache (2026-08-17 — `sceneContentHash.ts` keys + manifest retention);
Wiggle Transform shape operator, Dissolve / Dancing Dissolve blend modes,
render-queue pause/resume with staged frames kept, Interpret Footage field
separation, keyframeable variable-font weight, Pixel Motion optical-flow
frame blending, variable-width per-vertex mask feather, Smooth Stabilize, and
the Clone Stamp paint mode (all 2026-08-20).

## 4. Roadmap (corrected)

**Phase 1 — footage pipeline finish:** optical-flow vectors (unlocks Pixel Motion retiming *and* is the substrate for
dense stabilization and better tracking).

**Phase 2 — masking & roto:** per-vertex mask feather (extend `MaskPoint`);
ONNX/WebGPU segmentation (SAM-class) for one-click roto, feeding the shipped
mask-tracking path.

**Phase 3 — breadth:** EXR/DPX/PSD import; 3D camera solver on top of the
existing multi-point tracker; ecosystem interchange (`.mogrt`), HDR delivery.

---

*Sources for the AE side: Adobe release notes and coverage of AE 26.0–26.3
(January–June 2026): native parametric meshes, Substance materials, variable
fonts, native SVG import, Unmult, Gate/Compressor/Distortion, compressed cache,
Windows-on-ARM. Premation side: this repository at the commit above; counts are
pinned by tests (`blendMode.test.ts` = 38, `EffectType` = 174, AI tools = 61,
`PathOpType` = 8+none, `MaskMode` = 7, layer styles = 9+1).*
