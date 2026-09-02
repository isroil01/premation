# Premation vs Adobe After Effects — Feature Comparison & Gap Analysis

> **Basis of comparison:** Premation `dev` as of 2026-09-02 (every Premation claim
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
| AI integration | **65** typed tools (read 7 / write 24 / craft 21 / compose 13), deterministic Caster/Director runner | Sensei / Firefly (generative fill, Roto Brush 3) | Premation has native agentic automation |

## 2. Feature-by-Feature

### 2.1 Timeline & sequence editing

| Feature | Premation | AE 26.3 | Status |
|---|---|---|---|
| Layer/clip model | Multi-clip bars per track (start, duration, sourceIn/Out) | One source per layer, in/out trims | Parity (+ multi-clip per track) |
| Trim/split/slip/slide/**roll** | Visible **edit-tool modes** (2026-09-02, `timelineEditMode.ts`): Selection / Razor / Slip / Slide / Roll on `Shift+S/C/Y/U/R`, cursors, snapped razor line, `Shift`+click cuts every track, pointer HUD in frames; roll is a real two-sided trim bounded by both clips' source handles. Alt-drag slip/slide kept. Plus **ripple trim / ripple insert gap** | Same five, as tools | Parity |
| **Per-cut transitions** | Cross dissolve, dip to black, dip to white, wipe as document RECORDS (`core/timeline/transitions.ts`) that materialize into overlaps / opacity ramps / a keyframed wipe and dematerialize to an exact snapshot; drag a chip onto a cut, double-click it, or use the clip menu; grips resize live | Effect-based transitions; Premiere-style cut transitions absent | **Premation wins** vs AE (AE has no per-cut transition object) |
| **Source Monitor** | In/out in source seconds, JKL shuttle (1×/2×/4×), frame stepping, Insert / Overwrite / Add to end / New comp from range (`SourceMonitorPanel.tsx`, `sourceMonitorOps.ts`) | Footage panel with in/out; no three-point edit | Parity, closer to an NLE than AE is |
| **Assemble / new comp from clips** | Assemble from Footage — detect cuts, split, drop the runts, sequence with dissolves, **one undo** (`assembleFromFootage.ts`); New Composition from Selected Clips (`compFromClips.ts`) | Scene Edit Detection + manual precomp | Parity+ (one gesture vs several) |
| **Clip-edge snapping / fit** | Clips snap to other clips, playhead, markers, work area and comp bounds with a guide line; Fit Composition (`;`) / Fit Work Area (`Alt+;`) | Snapping + zoom-to-fit | Parity |
| Time remapping | `remapTime` curve, freeze, reverse, sequence bars | Time Remap + speed graph, stretch, freeze | Parity |
| Frame blending | Frame Mix + **Pixel Motion** (deterministic optical-flow warp) | Frame Mix + Pixel Motion | Parity |
| Responsive/protected time | `responsiveTime.ts` regions | Responsive Design — Time | Parity |
| Markers | Comp + layer markers, duration, color (`layerMarkers`, `markerShortcuts`) | Comp + layer markers, cue points | Parity |
| Interpret Footage | fps, PAR, alpha, looping, Separate Fields, **3:2 pulldown detect + Remove Pulldown** | Same | Parity |
| Layer property tree | Twirl-down tree built from the layer itself (`propertyTree.ts`): Text, Contents, Masks, Effects, Transform, Layer Styles, Material Options, Audio — every row present with its stopwatch before anything is keyed; Material Options keyframe via `readNodeMaterial(node, av)` | Same groups | Parity |
| **Quick Apply** | Command palette `+` (effects) / `*` (presets): fuzzy search, Enter applies to every selected layer (`quickApply.ts`) | 26.2 Quick Apply | Parity |
| **Effects & Presets favourites / Effect Controls labels** | Star effect types (`effectFavorites` pref); per-instance label colour swatch on Effect Controls (`Effect.labelColor`) | Favourites + label colours | Parity |
| **Scene Edit Detection** | Luma-histogram cut detector over the exact decode path, adaptive threshold, **plus dissolve detection** (steady-drift windows, reported at the midpoint) → markers or splits (`sceneEditDetect.ts`) | Sensei-based | Parity on cuts and dissolves |
| **Proportional Scrubbing** | Ordered property-row selection; a drag ramps 0 % → 100 % first→last (`propertySelectionStore.ts`) | 26.2 | Parity |
| **Adaptive Resolution** | Viewport drops to a floor (Half by default) during any drag, restores on release (`renderQualityStore.ts`) | Fast Previews ▸ Adaptive Resolution | Parity |
| Copy Frame to Clipboard | `comp.copyFrame` — deterministic still → clipboard PNG | 26.3 | Parity |
| Multi-Frame Rendering | Encode stage pipelined (`framePipeline.ts`): the desktop sink and the image-sequence export snapshot each frame and run up to cores−1 PNG/JPEG encodes + disk writes concurrently while the GPU renders the next frame; the per-frame render itself stays serial | Parallel frame rendering across cores | Foothold — the encode/IO half overlaps; parallel *rendering* needs worker-side scene graph + GPU backend |
| Mask animation | Mask Shape as a whole-shape track, plus per-path **Feather / Opacity / Expansion as independent numeric tracks** (`mask.<id>.<key>`, layered at render by `applyMaskPropertyTracks`) | Four independent properties per mask | Parity |

### 2.2 Keyframes & expressions

| Feature | Premation | AE 26.3 | Status |
|---|---|---|---|
| Interpolation | Linear, hold, bezier, continuous, **roving** (`interpolate.ts`), spatial auto-tangents | Same set | Parity |
| Graph editor | **One** editor (2026-09-02): the Motion panel's private copy is deleted and both surfaces host `Timeline/GraphEditor.tsx` — value + speed graphs, handle editing, Easy Ease, presets, **Animated / Selected** visibility modes, a frozen **reference curve**, rove, ease copy/paste and a saved-curve **ease library** | Same, incl. Show Animated / Selected | Parity |
| Keyframe assistants / menus | Interpolation submenu, **Keyframe Velocity…**, prev/next keyframe, The Smoother and The Wiggler as dialogs with live preview, onion-skin settings popover | Same set | Parity |
| **Stagger / modifier stacks / audio drivers** | Parametric stagger with order modes, swing, seed and a record that makes **Re-apply** replace the last one in one undo (`choreography.ts`); ordered per-property **modifier stacks** compiled to one expression (`modifierStack.ts`); audio-reactive drivers with band / attack / release / gate / range (`audioDriver.ts`); **bake dynamics** to keyframes | Sequence Layers + expressions; no modifier stack (Cavalry has one) | **Premation wins** — AE has no data-held modifier stack |
| Expression authoring | Caret **autocomplete** (ranked, member-aware, Ctrl+Space) in the expression editor | Expression language menu + autocomplete | Parity |
| Generators | Physics bounce (`bounce.ts`) | Keyframe assistants + expressions | Parity |
| Layer utilities | **Create Nulls From Path Points**, both directions — one-shot, and live **Points Follow Nulls** via a render-time binding (`Geometry.pointBindings`); **Create Shapes From Text** with the **font's own `glyf`/CFF outlines** (`openType.ts`, `fontOutlines.ts`) and a traced fallback when the face cannot be read; **Auto-trace** (layer alpha → add + subtract mask paths incl. holes, per-frame keyframes) | Same three | Parity (font-exact needs Local Font Access permission; web fonts fall back to trace) |
| Expression engine | ~50 identifiers incl. `wiggle`, `valueAtTime`, `velocityAtTime`, `loopOut` (with working `pingpong`), `sourceRectAtTime`, `key(n)`, `numKeys`, and `audio` | Full JS; 26.0 adds per-character styling via expressions | Parity for standard motion; no arbitrary JS by design |

### 2.3 Compositing, mattes, masks

| Feature | Premation | AE 26.3 | Status |
|---|---|---|---|
| Blend modes | **38** — all of AE's 38 (pinned by `blendMode.test.ts`) | 38 | Parity |
| Track mattes | Alpha/Luma ± inverted, decoupled from layer order | Decoupled pick-whip (since AE 2023) | Parity |
| Masks | Bezier, 7 modes, expansion, opacity, uniform + **variable-width per-vertex feather**; effect-scoped masks | Same | Parity |
| Layer styles | **10** = 9 in `LAYER_STYLE_LABEL` + backdrop `glass` | 9 Photoshop styles | Parity (+ backdrop glass) |
| Continuous rasterization | Collapse transforms, vector CR for precomps & SVG | Same toggle | Parity |
| Roto / segment | Roto Brush (flow-propagated mattes), GrabCut seed, **SAM-class click/box** (`samSegment.ts`); `onnxruntime-web` installed, model registered at boot from `VITE_SAM_MODEL_URL` | Roto Brush 3 / **Object Matte** (neural) | Classical shipped; neural needs only a hosted model URL |

### 2.4 Effects & color

| Feature | Premation | AE 26.3 | Status |
|---|---|---|---|
| Effect stack | **183** effects (`EffectType` union, completeness-tested) incl. **Unmult**, **CC Composite**, **CC RepeTile**, **CC Scatterize**, **CC Radial Fast Blur**, **CC Cross Blur**, **CC Scale Wipe**, **CC Plastic**, **Curl Noise** | 400+ (26.0 adds **Unmult** with 32-bit HDR) + third-party | High coverage of the used set |
| Keying | Full Keylight parameter set (`keylight.ts`) | Keylight 1.2 | Parity |
| Content-Aware Fill | PatchMatch still + **video bake with bidirectional temporal polish** | Content-Aware Fill | Classical foothold; Adobe quality open |
| Color spaces | ACEScg, linear sRGB, 16/32-bpc intermediates, ACES ODT, CUBE LUT (working-space sample; **not** full OCIO roles/displays/views); viewer LUT (session, post-ODT); **HDR10/HLG export with MaxCLL/MaxFALL + master-display SEI**; float EXR → GPU (`rgba32float`) | OCIO, 32-bpc, HDR delivery | Strong; libx265 availability still host-dependent |
| Extensibility | Sandboxed Web Worker plugins + custom WebGPU/WebGL2 shader effects | C++ AEGP/Effect SDK | Different models; Premation's is sandboxed |

### 2.5 Text & shapes

| Feature | Premation | AE 26.3 | Status |
|---|---|---|---|
| Text animators | Per-character 3D, range/wiggly selectors (`textSelectors.ts`) | Range/Wiggly/Expression selectors | Parity |
| Text on path | `textPath.ts` — margins, perpendicular, reverse | Same | Parity |
| **Variable fonts** | Keyframeable **wght** + **wdth/slnt** via `font-variation-settings` (`fontWidth` / `fontSlant`); font picker **Variable filter + badge** (`fvar` probe, `variableFontProbe.ts`) | 26.0: keyframeable weight/width/slant; 26.3: variable-font filter | Parity |
| SVG import | SVG parsing + continuous rasterization | **26.0: native SVG → editable shape layers with gradients** | Rough parity |
| Path operators | **9** chainable (`PathOpType` incl. **wiggleTransform**) | Same set | Parity |
| **Gradient editing** | On-canvas gizmo (`gradientHandles.ts` + `GradientHandleOverlay.tsx`): axis grips, stop diamonds, add / duplicate / delete stops, colour picker on double-click, per-fill chip | Gradient Ramp effect + shape gradient with on-canvas handles | Parity |
| **Knife / pathfinder** | Knife tool (`K`, `KnifeTool` in `tools/builtin.ts`) cuts shape paths exactly along a dragged line, cubics included, closed shapes capped into islands (`core/geometry/pathCut.ts`); Pathfinder section for boolean set ops | No knife; Merge Paths only | **Premation wins** (Illustrator-class cutting) |
| **Smart guides** | Distance badges, equal-spacing and equal-size detection **with snapping**, Alt-hover measuring, View Options toggle (`packages/workspace/src/snap/smartGuides.ts`) | Snapping to layer features; no measurement chrome | **Premation wins** (Figma-class) |

### 2.6 3D & rigging

| Feature | Premation | AE 26.3 | Status |
|---|---|---|---|
| Cameras | 1/2-node (`cameraOrientation`), DoF, **quad view**; **SfM + bundle adjust** camera solve (`sfmCamera.ts`, `bundleAdjust.ts`) | Same + denser commercial solver | Foothold shipped; COLMAP-grade open |
| Lights | 5 types (`LightType: point, ambient, spot, parallel, environment`), falloff, cone feather, Blinn-Phong, **light presets + Kelvin colour temperature** (`colorTemperature.ts`); **environment** is an SH irradiance probe (procedural sky presets **or any image / EXR asset**, projected to 9 coefficients, expressed as a derived ambient + up to six parallel lights — zero renderer changes) | 4 types + cast shadows | Parity, plus IBL AE has no equivalent of |
| **Reflections / IBL** | **Shipped 2026-09-02**: a prefiltered specular atlas built from the environment light's own sky (importance-sampled GGX, one level per roughness) + split-sum IBL with an analytic env-BRDF in **both** dialects (WGSL + GLSL), behind a Reflections row. Physical and Phong reflect; Toon deliberately does not. Gated so pre-existing scenes are byte-identical (`environmentReflections.test.ts`) | Advanced 3D image-based lighting + environment reflections | Parity on the reflection model; no ray-traced/screen-space reflections |
| **Materials** | Material section with a live shading preview, every reflectance parameter in one place, **per-face overrides**, and a persisted **material library** seeded from the built-in presets (`core/scene/material.ts`, `materialStore.ts`) | Material Options + Substance materials | Parity for the parameter set; no Substance graph |
| **World settings** | Composition Settings ▸ **World**: default environment for new lights, ground level for the grid, sky backdrop — all optional and absent until set, so old documents round-trip unchanged | Environment layer / renderer settings | Parity |
| Geometry | Extrusion + bevels (**angular / concave / convex**) + per-face materials (`FACE_SURFACE_IDS`); **real curved primitives** since 2026-09-02 — sphere, cylinder, cone, torus, capsule and box are mesh layers with editable segment counts and smooth per-vertex normals (`core/geometry/primitiveMesh.ts`), while cube and plane keep their bevel-capable extruded forms; **plus imported `.glb` / `.gltf` meshes** — a 3D null per node, a mesh layer per primitive, drawn through the same extrusion mesh render path, with CPU skinning against joint layers, morph-target blend shapes, baked animation clips, and 3D IK (CCD) over joint chains | Advanced 3D: glTF + parametric meshes + Substance PBR, height displacement, IBL | Narrowed to two items — meshes, curved primitives, skinning, morphs, baked clips, PBR maps and IBL+reflections all ship; **shadow maps shipped 2026-09-02** (opt-in per light, PCF, one mapped light per run); still open: **SSAO** (blocked by multisampled scene targets — no sampleable depth on either backend) and **height displacement** |
| **PBR texture maps** | **Shipped 2026-09-02** (`core/media/gltf.ts`): normal, metallic-roughness, occlusion and emissive on a separate `mesh3d-pbr` material, texture transforms baked into UVs, tangents from derivatives. External `.gltf` files import **with their sidecars**, refusing by naming the ones they cannot find. **File ▸ Import 3D Model** | Substance / glTF PBR maps | Parity for the glTF map set; no Substance graph or height displacement |
| **Shading model** | Phong (original) **or Physical: Cook-Torrance GGX + Smith-Schlick + Schlick Fresnel, roughness / metalness**, **or Toon** (cel shading, 2–8 bands), in all four 3D shade blocks (WGSL + GLSL, solid + textured); Specular Intensity scales dielectric F₀ (0.5 → 4 %); roughness keyframeable | PBR (roughness / metalness) | Parity on the reflectance model, plus Toon as a third model AE lacks natively; IBL now carries **both** halves — irradiance and split-sum specular reflections (Toon opts out by design) |
| Rigging | Bones, FK/IK with FABRIK, IK/FK blending, geodesic auto-weights, weight painting, ARAP puppet, bend pins | Puppet pins; bones via paid third-party | 🏆 Premation outclasses native AE |

### 2.7 Footage, audio, export

| Feature | Premation | AE 26.3 | Status |
|---|---|---|---|
| Decoding | WebCodecs exact path, mp4box demux, **WebM VP8/VP9 + dual-plane alpha** | Native importers | Done |
| **Import breadth** | Browser codecs + ffmpeg fallback; sequences; Lottie; **EXR + DPX + layered PSD**; **camera-raw stills (DNG/CR2/… via ffmpeg)**; **MXF/R3D/BRAW ingest attempt**; float EXR cache → GPU | **MXF, camera raw (R3D/BRAW/ARRIRAW)** as working float media | Partial — stills foothold + MXF transcode; vendor raw SDKs / float working copies still open |
| Tracking applies | Follow, Stabilize, Corner Pin, mask tracking, 2-point, Smooth Stabilize variants, planar/mesh (**RANSAC + temporal H smooth**), **SfM camera solve**, multi-plane nulls | Tracker panel + Warp Stabilizer VFX + 3D Camera Tracker | Classical column shipped |
| **Scopes** | Waveform (luma / RGB), RGB parade, vectorscope with 75 % targets, histogram (`core/video/scopes.ts`), fed from the RAM preview cache with the comp rect reconstructed out of the viewport, or from a synchronous render-loop tap (`frameTap.ts`) | **None** — AE has no scopes panel (Premiere/Lumetri does) | 🏆 **Premation wins** natively |
| **Transcript / text-based editing** | Transcribe the comp, click a word to seek, select a run and **delete its time range from every layer at once** (one ripple per range, not per layer), filler-word finder, transcript → captions, SRT/VTT export (`Transcript/`, `core/captions/transcriptEdit.ts`) | **None** in AE (Premiere has Text-Based Editing) | 🏆 **Premation wins** vs AE |
| Audio | Multi-voice engine + **time-remap / precomp-ancestor piecewise varispeed**; **silence removal** (detect dead air, split picture and sound at the same boundaries, close the gaps, one undo) and **ducking** as level keyframes with Re-duck (`silenceRemoval.ts`, `ducking.ts`) | Basic playback + keyframed levels; no silence removal or ducking | **Premation wins** on the edit verbs |
| Export | ProRes 4444, MP4, WebM, GIF, PNG/JPG, **EXR sequence (WebGL2/WebGPU linear RT readback)**, Lottie, **EDL / OTIO / FCPXML / ALE**, **`.mogrt.zip`**, HDR10/HLG, plus **chapters from labelled comp markers** on MP4/MOV (ffmetadata sidecar + `-map_chapters`) | AME formats incl. HEVC, EXR, true `.mogrt` / AAF | Strong; Adobe-native mogrt / binary AAF open |
| **Render queue pause / resume** | **Shipped 2026-09-02** (`renderQueueStore.ts`): Pause one job or Stop the queue — both keep the staged frames and a `resumeFrame`, and a resumed job keeps its progress; **Discard** is the separate destructive verb, and half-rendered jobs are picked up first. Session-scoped: the resume handle is a live sink and is never serialized | Pause / resume in the Render Queue and AME | Parity within a session; AE survives a relaunch |
| Caching | RAM preview + persistent content-addressed disk cache | Persistent global cache; **26.0 adds lossless compressed cache format** | Parity |
| Templates | Template fields + **`exportMogrtZip` (Premation package)** | Essential Graphics + Adobe `.mogrt` | Foothold shipped; Premiere-native open |

## 3. Gap Matrix (current)

**🔴 Tier 1 — high impact**
1. Neural rotoscoping (Roto Brush 3 / Object Matte) — classical + SAM hook + **`onnxruntime-web` + boot registration** shipped; needs only a hosted model URL (`VITE_SAM_MODEL_URL`)
1b. Multi-Frame Rendering — encode/IO stage pipelined; parallel *rendering* still needs a worker-side scene graph + GPU backend. Investigated and declined for now: 20+ render-path modules touch `document`/`window`, `AppTextureProvider` uses HTMLImage/HTMLVideo (19 sites), and page-loaded web fonts are invisible to a worker's OffscreenCanvas — a worker render would produce different pixels from the preview for any comp with text, which is the one failure the export pipeline is built to refuse
2. Vendor camera raw / MXF as **working float** media — DNG/CR2 stills + MXF transcode footholds shipped; R3D/BRAW need SDKs; float masters still open

**🟡 Tier 2 — pro workflow**
4. COLMAP-grade SfM / denser planar (Mocha product depth) — RANSAC + **temporal H smooth** + BA footholds shipped
5. Adobe-quality Content-Aware Fill (classical PatchMatch + bidirectional video shipped)
8. ~~glTF/3D model import~~ — **shipped 2026-09-01/02** (was "out of scope by design"; the user reversed that): `.glb` and `.gltf` — embedded **and external-file, with sidecars** — import as ordinary 3D layers (nulls per node, mesh layers per primitive) through the extrusion mesh render path, **plus CPU skinning against joint layers, morph-target blend shapes, baked animation clips, 3D IK (CCD) over joint chains, the full glTF PBR map set, and real curved primitives**. Nothing on this line is open any more; what replaces it is item 13 below

**🟢 Tier 3 — niche/finishing**
9. ~~3:2 pulldown removal~~ — shipped
10. ~~Variable-font wdth/slnt~~ — shipped
11. ~~HDR MaxCLL / master-display~~ — shipped; **libx265 probed** (falls back to tagged H.264 10-bit with UI note)
12. Adobe-native `.mogrt` / binary AAF — Premation `.mogrt.zip` + **ALE** + OTIO shipped; binary AAF open
13. **3D occlusion** — the one 3D column left open after 2026-09-02. **Shadow maps shipped** (`rendergraph/passes/shadowMap.ts`: opt-in per light, 3×3 PCF, packed linear-distance target, byte-identical when off; one mapped light per run, point lights along their aim). **SSAO is blocked** by the multisampled scene targets — neither backend can sample a multisampled depth, so it needs a linear-depth prepass bound before the run draws; **height displacement is not started**. A shadow catcher exists as Accepts Shadows ▸ Only
14. **Cross-layer DOF** — `coc-blur` (per-pixel radius from four corner CoCs) and `bokeh` (polygonal iris) ship in the renderer, but there is no sampleable depth buffer, so blur cannot gather across another layer's silhouette
15. **Render-queue resume across a relaunch** — pause/resume ships but is session-scoped; the resume handle is a live sink and is never serialized

**Removed from earlier drafts (shipped):** ExactVideoSource; point / stabilize / corner / mask tracking; disk cache; Wiggle Transform; Dissolve modes; field separation; variable-font weight; Pixel Motion; variable mask feather; Smooth Stabilize; Clone Stamp; subspace / RS; SfM + BA; Roto / GrabCut / SAM-class; CAF video; float EXR GPU + HDR10/HLG + MaxCLL; EXR/DPX/PSD; EDL/OTIO/FCPXML/**ALE**; mogrt.zip; font wdth/slnt; **WebGPU float RT readback**; **glTF import + skinning + morphs + PBR maps**; **environment reflections / IBL**; **curved primitives**; **timeline edit tools + per-cut transitions**; **source monitor**; **scopes**; **transcript editing**; **silence removal + ducking**; **render-queue pause/resume**; **one graph editor**; **modifier stacks**; **audio drivers**; **bake dynamics**; **knife + pathfinder**; **on-canvas gradient editor**; **smart guides**.

## 4. Roadmap (corrected)

**Phase 1 — neural priors:** host a SAM ONNX decoder and set `VITE_SAM_MODEL_URL` — the runtime and the boot call are in.

**Phase 2 — footage depth:** camera raw / MXF float pipelines.

**Phase 3 — ecosystem:** Adobe-compatible `.mogrt` binary layout; binary AAF (or rely on OTIO→AAF adapters + ALE).

---

*Sources for the AE side: Adobe release notes and coverage of AE 26.0–26.3
(January–June 2026). Premation side: this repository; counts are pinned by tests
(`blendMode.test.ts` = 38, `EffectType` = 183, AI tools = 65, `PathOpType` = 9,
`MaskMode` = 7, layer styles = 9+1). The `EffectType` and AI-tool figures were
both stale here on 2026-09-02 — 174 and 61 — which is the drift
`docPropagatedCounts.test.ts` exists to stop; that guard covers
`EDITOR_REFERENCE.md`, `README.md` and `ROADMAP.md`, and this file is outside
its scope, so re-derive from `scripts/featureCounts.cjs` before quoting these.*
