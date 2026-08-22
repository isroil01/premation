# Premation vs Adobe After Effects — Feature Comparison & Gap Analysis

> **Basis of comparison:** Premation `dev` as of 2026-08-21 (every Premation claim
> verified against source — registries, tests, and shipped modules, not prose) vs
> **After Effects 26.3** (June 2026 release; 26.0 shipped January 2026).
> Where a count is stated, a test or registry in this repo pins it.

## 1. Executive Summary

| Dimension | Premation | After Effects 26.3 | Verdict |
|---|---|---|---|
| Platform | Electron + React 19 + TypeScript + WebGPU/WebGL2 | C++ native (incl. native Windows-on-ARM since 26.0) | Modern, portable |
| Render determinism | One pipeline for preview and export (`buildSnapshot` → render backend) | Preview (Mercury) vs Render Queue / AME are separate paths | **Premation wins** on WYSIWYG |
| Color | Linear working space (`srgb-linear`, ACEScg), ACES ODT, 16/32-bit float RTs; **PQ/HLG delivery + MaxCLL/MaxFALL mastering tags**; float EXR GPU upload / linear RT→EXR (WebGL2 sync + **WebGPU async**) | OCIO/ACES, 32-bpc, Display Color Management | Strong parity; guaranteed libx265 still environment-dependent |
| Expressions | Hand-written safe language (`packages/animation/src/expressions.ts`, ~50 identifiers) + value/speed graph editor | Full JavaScript (ES6+) | Very high parity for motion-design idioms |
| 2D rigging | Bones, FK/IK, FABRIK solver, weight painting, ARAP puppet (`src/core/rig/`) | Puppet pins only; bones need Duik/Limber | **Premation wins natively** |
| Tracking | Multi-point + planar/mesh; Smooth Stabilize (similarity / subspace / RS); **3D Camera Tracker (SfM + BA)**; Roto Brush + GrabCut + **SAM-class segment**; CAF video (PatchMatch + bidirectional) | Point tracker, 3D Camera Tracker, Warp Stabilizer VFX, Mocha planar, Roto Brush 3 | Classical parity footholds shipped; neural SAM / Mocha depth remain |
| AI integration | 61 typed tools (read 7 / write 24 / craft 17 / compose 13), deterministic Caster/Director runner | Sensei / Firefly (generative fill, Roto Brush 3) | Premation has native agentic automation |

## 2. Feature-by-Feature

### 2.1 Timeline & sequence editing

| Feature | Premation | AE 26.3 | Status |
|---|---|---|---|
| Layer/clip model | Multi-clip bars per track (start, duration, sourceIn/Out) | One source per layer, in/out trims | Parity (+ multi-clip per track) |
| Trim/split/slip/slide | All present; **ripple trim / ripple insert gap** | All present | Parity |
| Time remapping | `remapTime` curve, freeze, reverse, sequence bars | Time Remap + speed graph, stretch, freeze | Parity |
| Frame blending | Frame Mix + **Pixel Motion** (deterministic optical-flow warp) | Frame Mix + Pixel Motion | Parity |
| Responsive/protected time | `responsiveTime.ts` regions | Responsive Design — Time | Parity |
| Markers | Comp + layer markers, duration, color (`layerMarkers`, `markerShortcuts`) | Comp + layer markers, cue points | Parity |
| Interpret Footage | fps, PAR, alpha, looping, Separate Fields, **3:2 pulldown detect + Remove Pulldown** | Same | Parity |
| Layer property tree | Twirl-down tree built from the layer itself (`propertyTree.ts`): Text, Contents, Masks, Effects, Transform, Layer Styles, Material Options, Audio — every row present with its stopwatch before anything is keyed | Same groups | Parity, except Material Options (listed, values editable, not yet keyframeable — `readNodeMaterial` is a static read) |
| Mask animation | ONE Mask Shape track — whole-shape snapshots (`setMaskAnim`), so path, feather, opacity and expansion move together | Four independent properties per mask | **Coarser than AE** |

### 2.2 Keyframes & expressions

| Feature | Premation | AE 26.3 | Status |
|---|---|---|---|
| Interpolation | Linear, hold, bezier, continuous, **roving** (`interpolate.ts`), spatial auto-tangents | Same set | Parity |
| Graph editor | Value + speed graphs, handle editing, Easy Ease, presets | Same | Parity |
| Generators | Physics bounce (`bounce.ts`) | Keyframe assistants + expressions | Parity |
| Expression engine | ~50 identifiers incl. `wiggle`, `valueAtTime`, `velocityAtTime`, `loopOut` (with working `pingpong`), `sourceRectAtTime`, `key(n)`, `numKeys`, and `audio` | Full JS; 26.0 adds per-character styling via expressions | Parity for standard motion; no arbitrary JS by design |

### 2.3 Compositing, mattes, masks

| Feature | Premation | AE 26.3 | Status |
|---|---|---|---|
| Blend modes | **38** — all of AE's 38 (pinned by `blendMode.test.ts`) | 38 | Parity |
| Track mattes | Alpha/Luma ± inverted, decoupled from layer order | Decoupled pick-whip (since AE 2023) | Parity |
| Masks | Bezier, 7 modes, expansion, opacity, uniform + **variable-width per-vertex feather**; effect-scoped masks | Same | Parity |
| Layer styles | **10** = 9 in `LAYER_STYLE_LABEL` + backdrop `glass` | 9 Photoshop styles | Parity (+ backdrop glass) |
| Continuous rasterization | Collapse transforms, vector CR for precomps & SVG | Same toggle | Parity |
| Roto / segment | Roto Brush (flow-propagated mattes), GrabCut seed, **SAM-class click/box** (`samSegment.ts`, ONNX hook) | Roto Brush 3 (neural) | Classical shipped; neural open |

### 2.4 Effects & color

| Feature | Premation | AE 26.3 | Status |
|---|---|---|---|
| Effect stack | **174** effects (`EffectType` union, completeness-tested) | 400+ (26.0 adds **Unmult** with 32-bit HDR) + third-party | High coverage of the used set |
| Keying | Full Keylight parameter set (`keylight.ts`) | Keylight 1.2 | Parity |
| Content-Aware Fill | PatchMatch still + **video bake with bidirectional temporal polish** | Content-Aware Fill | Classical foothold; Adobe quality open |
| Color spaces | ACEScg, linear sRGB, 16/32-bpc intermediates, ACES ODT, CUBE LUT; **HDR10/HLG export with MaxCLL/MaxFALL + master-display SEI**; float EXR → GPU (`rgba32float`) | OCIO, 32-bpc, HDR delivery | Strong; libx265 availability still host-dependent |
| Extensibility | Sandboxed Web Worker plugins + custom WebGPU/WebGL2 shader effects | C++ AEGP/Effect SDK | Different models; Premation's is sandboxed |

### 2.5 Text & shapes

| Feature | Premation | AE 26.3 | Status |
|---|---|---|---|
| Text animators | Per-character 3D, range/wiggly selectors (`textSelectors.ts`) | Range/Wiggly/Expression selectors | Parity |
| Text on path | `textPath.ts` — margins, perpendicular, reverse | Same | Parity |
| **Variable fonts** | Keyframeable **wght** + **wdth/slnt** via `font-variation-settings` (`fontWidth` / `fontSlant`) | 26.0: keyframeable weight/width/slant | Parity for axes that the loaded face exposes |
| SVG import | SVG parsing + continuous rasterization | **26.0: native SVG → editable shape layers with gradients** | Rough parity |
| Path operators | **9** chainable (`PathOpType` incl. **wiggleTransform**) | Same set | Parity |

### 2.6 3D & rigging

| Feature | Premation | AE 26.3 | Status |
|---|---|---|---|
| Cameras | 1/2-node (`cameraOrientation`), DoF, **quad view**; **SfM + bundle adjust** camera solve (`sfmCamera.ts`, `bundleAdjust.ts`) | Same + denser commercial solver | Foothold shipped; COLMAP-grade open |
| Lights | 4 types (`LightType: point, ambient, spot, parallel`), falloff, cone feather, Blinn-Phong | 4 types + cast shadows | Parity |
| Geometry | Extrusion + bevels + per-face materials (`FACE_SURFACE_IDS`) | Advanced 3D: glTF + parametric meshes + Substance PBR | ⚠️ Gap (Tier 2) — out of scope per `docs/3d-layer-model.md` |
| Rigging | Bones, FK/IK with FABRIK, IK/FK blending, geodesic auto-weights, weight painting, ARAP puppet, bend pins | Puppet pins; bones via paid third-party | 🏆 Premation outclasses native AE |

### 2.7 Footage, audio, export

| Feature | Premation | AE 26.3 | Status |
|---|---|---|---|
| Decoding | WebCodecs exact path, mp4box demux, **WebM VP8/VP9 + dual-plane alpha** | Native importers | Done |
| **Import breadth** | Browser codecs + ffmpeg fallback; sequences; Lottie; **EXR + DPX + layered PSD**; **camera-raw stills (DNG/CR2/… via ffmpeg)**; **MXF/R3D/BRAW ingest attempt**; float EXR cache → GPU | **MXF, camera raw (R3D/BRAW/ARRIRAW)** as working float media | Partial — stills foothold + MXF transcode; vendor raw SDKs / float working copies still open |
| Tracking applies | Follow, Stabilize, Corner Pin, mask tracking, 2-point, Smooth Stabilize variants, planar/mesh (**RANSAC + temporal H smooth**), **SfM camera solve**, multi-plane nulls | Tracker panel + Warp Stabilizer VFX + 3D Camera Tracker | Classical column shipped |
| Audio | Multi-voice engine + **time-remap / precomp-ancestor piecewise varispeed** | Basic playback + keyframed levels | Comparable |
| Export | ProRes 4444, MP4, WebM, GIF, PNG/JPG, **EXR sequence (WebGL2/WebGPU linear RT readback)**, Lottie, **EDL / OTIO / FCPXML / ALE**, **`.mogrt.zip`**, HDR10/HLG | AME formats incl. HEVC, EXR, true `.mogrt` / AAF | Strong; Adobe-native mogrt / binary AAF open |
| Caching | RAM preview + persistent content-addressed disk cache | Persistent global cache; **26.0 adds lossless compressed cache format** | Parity |
| Templates | Template fields + **`exportMogrtZip` (Premation package)** | Essential Graphics + Adobe `.mogrt` | Foothold shipped; Premiere-native open |

## 3. Gap Matrix (current)

**🔴 Tier 1 — high impact**
1. Neural rotoscoping (Roto Brush 3 / SAM ONNX model) — classical + **`tryRegisterSamOnnxFromUrl`** hook shipped; needs model weights + `onnxruntime-web`
2. Vendor camera raw / MXF as **working float** media — DNG/CR2 stills + MXF transcode footholds shipped; R3D/BRAW need SDKs; float masters still open

**🟡 Tier 2 — pro workflow**
4. COLMAP-grade SfM / denser planar (Mocha product depth) — RANSAC + **temporal H smooth** + BA footholds shipped
5. Adobe-quality Content-Aware Fill (classical PatchMatch + bidirectional video shipped)
8. glTF/3D model import — *explicitly out of scope by design*

**🟢 Tier 3 — niche/finishing**
9. ~~3:2 pulldown removal~~ — shipped
10. ~~Variable-font wdth/slnt~~ — shipped
11. ~~HDR MaxCLL / master-display~~ — shipped; **libx265 probed** (falls back to tagged H.264 10-bit with UI note)
12. Adobe-native `.mogrt` / binary AAF — Premation `.mogrt.zip` + **ALE** + OTIO shipped; binary AAF open

**Removed from earlier drafts (shipped):** ExactVideoSource; point / stabilize / corner / mask tracking; disk cache; Wiggle Transform; Dissolve modes; field separation; variable-font weight; Pixel Motion; variable mask feather; Smooth Stabilize; Clone Stamp; subspace / RS; SfM + BA; Roto / GrabCut / SAM-class; CAF video; float EXR GPU + HDR10/HLG + MaxCLL; EXR/DPX/PSD; EDL/OTIO/FCPXML/**ALE**; mogrt.zip; font wdth/slnt; **WebGPU float RT readback**.

## 4. Roadmap (corrected)

**Phase 1 — neural priors:** ship/host a SAM ONNX model and `npm i onnxruntime-web`; call `tryRegisterSamOnnxFromUrl`.

**Phase 2 — footage depth:** camera raw / MXF float pipelines.

**Phase 3 — ecosystem:** Adobe-compatible `.mogrt` binary layout; binary AAF (or rely on OTIO→AAF adapters + ALE).

---

*Sources for the AE side: Adobe release notes and coverage of AE 26.0–26.3
(January–June 2026). Premation side: this repository; counts are pinned by tests
(`blendMode.test.ts` = 38, `EffectType` = 174, AI tools = 61, `PathOpType` = 9,
`MaskMode` = 7, layer styles = 9+1).*
