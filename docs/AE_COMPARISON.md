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
| Time remapping | Speed section: **Normal / Speed % / Frame Number** (Twixtor / Timewarp's two modes), in-inspector speed curve, per-point ramp style, 7 velocity presets, footage budget + Fit to footage; freeze, reverse, stretch | Time Remap + speed graph, Timewarp effect, stretch, freeze | Parity+ |
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
| Effect stack | **204** effects (`EffectType` union, completeness-tested) incl. **Unmult**, **CC Composite**, **CC RepeTile**, **CC Scatterize**, **CC Radial Fast Blur**, **CC Cross Blur**, **CC Scale Wipe**, **CC Plastic**, **Curl Noise**; round seven (2026-09-06) adds **CC Particle Systems II**, **CC Bubbles**, **Fractal**, **3D Glasses**, **CC Kernel**, **CC Block Load**, **Color Difference Key**, **CC Simple Wire Removal**, **Broadcast Colors**, **Noise HLS**, **CC Color Offset**, **CC Threshold RGB**, **Cineon Converter**, **CC Tiler**, **CC Ripple Pulse**, **CC Radial ScaleWipe**, **CC Glass Wipe**, **CC Image Wipe** | 400+ (26.0 adds **Unmult** with 32-bit HDR) + third-party | High coverage of the used set |
| Keying | Full Keylight parameter set (`keylight.ts`) | Keylight 1.2 | Parity |
| Content-Aware Fill | PatchMatch still + **video bake with bidirectional temporal polish** | Content-Aware Fill | Classical foothold; Adobe quality open |
| Color spaces | ACEScg, linear sRGB, 16/32-bpc intermediates, ACES ODT, CUBE LUT (working-space sample; **not** full OCIO roles/displays/views); viewer LUT (session, post-ODT); **HDR10/HLG export with MaxCLL/MaxFALL + master-display SEI**; float EXR → GPU (`rgba32float`) | OCIO, 32-bpc, HDR delivery | Strong; libx265 availability still host-dependent |
| Extensibility | Sandboxed Web Worker plugins + custom WebGPU/WebGL2 shader effects | C++ AEGP/Effect SDK | Different models; Premation's is sandboxed |

### 2.5 Text & shapes

| Feature | Premation | AE 26.3 | Status |
|---|---|---|---|
| Text animators | Per-character 3D, range/wiggly selectors (`textSelectors.ts`); **2-D animator Blur (2026-09-14)** — `ta.<i>.blur`/`ta.<i>.blurY`, absent-means-linked so old documents hash identically; anisotropic X≠Y painted via a squash→blur→stretch composite | Range/Wiggly/Expression selectors; Blur is [x, y] with a link toggle | Parity |
| **Per-character 3D + extrusion** | **One extruded solid per glyph (2026-09-14)** — each glyph plane carries its own body mesh (`::ch<i>::ext-mesh`) on the same world matrix, so animators scattering glyphs in Z / tumbling them keep every front attached to its solid; meshes shared between repeated characters, cached across frames | AE 26 extrudes each character as its own solid | Parity |
| Text on path | `textPath.ts` — margins, perpendicular, reverse | Same | Parity |
| **Variable fonts** | Keyframeable **wght** + **wdth/slnt** via `font-variation-settings` (`fontWidth` / `fontSlant`); font picker **Variable filter + badge** (`fvar` probe, `variableFontProbe.ts`) | 26.0: keyframeable weight/width/slant; 26.3: variable-font filter | Parity |
| SVG import | SVG parsing + continuous rasterization; **SVG paste ✅ (2026-09-08)** — Ctrl/Cmd+V with `image/svg+xml`, HTML-wrapped or plain-text SVG (Illustrator) on the clipboard takes the same importer as a dropped .svg (`clipboard.ts` → `insertSvgDocument`) | **26.0: native SVG → editable shape layers with gradients; 26.3: Illustrator/SVG paste** | Parity |
| Path operators | **9** chainable (`PathOpType` incl. **wiggleTransform**); **Offset Paths with real joins (2026-09-14)** — miter (animatable Miter Limit) / round / bevel, self-intersection cleanup, islands on a split | Same set | Parity |
| **Parametric Polystar** | Polygon / Star tools create parametric layers (`core/scene/polystar.ts`): type, points, rotation, radii, roundness — all keyframeable (`polystar.*` tracks), recomputed per frame before the operator chain; AE's segment-proportional roundness; exports as native Lottie `sr` | Polystar Path group | Parity (whole-point counts; AE also draws fractional points mid-interpolation) |
| **Gradient editing** | On-canvas gizmo (`gradientHandles.ts` + `GradientHandleOverlay.tsx`): axis grips, stop diamonds, add / duplicate / delete stops, colour picker on double-click, per-fill chip | Gradient Ramp effect + shape gradient with on-canvas handles | Parity |
| **Knife / pathfinder** | Knife tool (`Shift+K`, `KnifeTool` in `tools/builtin.ts`) cuts shape paths exactly along a dragged line, cubics included, closed shapes capped into islands (`core/geometry/pathCut.ts`); Pathfinder section for boolean set ops | No knife; Merge Paths only | **Premation wins** (Illustrator-class cutting) |
| **Smart guides** | Distance badges, equal-spacing and equal-size detection **with snapping**, Alt-hover measuring, View Options toggle (`packages/workspace/src/snap/smartGuides.ts`) | Snapping to layer features; no measurement chrome | **Premation wins** (Figma-class) |

### 2.6 3D & rigging

| Feature | Premation | AE 26.3 | Status |
|---|---|---|---|
| Cameras | 1/2-node (`cameraOrientation`), DoF, **quad view**; **SfM + bundle adjust** camera solve (`sfmCamera.ts`, `bundleAdjust.ts`); **Layer ▸ Camera verbs** (2026-09-05, `core/scene/cameraCommands.ts`): Create Orbit Null, Set Focus Distance to Layer (axial depth — the number `dofBlurPx` compares against), Link Focus Distance to Layer / to Point of Interest as expressions; View ▸ Viewport ▸ 3D View: Look at Selected / All Layers aim a custom view; cameras and lights have a layer space so `thisLayer.toWorld` works on them; **2026-09-10**: Camera Options / Light Options twirls in the timeline (Zoom, orbit, POI, DOF, intensity, cone… as stopwatched rows via `propertyMeta`), Layer ▸ New ▸ Camera…/Light… open the option dialogs (`Ctrl+Alt+Shift+C`/`L`), **Distribute Layers in Z** (stack-ordered depth ladder, size-compensated against the active camera so framing holds until the camera moves), and a Camera preset folder (Push In, Pull Out, Orbit Sweep, Drift Parallax, Dolly Zoom, Handheld); the View menu and every 2-up / 4-up pane list **each camera by name** to look through (`camera:<id>` views — projection, DOF and camera motion blur from that camera; a deleted or disabled one falls back to Active Camera), and new cameras / lights are numbered (`Camera 2`, not a second `Camera 1`) ; a sealed comp instance renders its 3D through its own camera and lights (depth, lighting, shadow maps — SSAO not yet); **2026-09-14**: **Unified Camera tool** (C cycles it first; left orbits, middle tracks XY, right dollies — right-drag suppresses the context menu only while armed), **orbit pivot modes** (Orbit Around Cursor — ray-picked frontmost 3D layer plane → ground plane → POI-distance plane — / Around Scene / Around Camera POI), and the **full AE iris set as keyframeable Camera Options** (Iris Rotation, Iris Aspect Ratio, Highlight Threshold, Highlight Saturation, Iris Diffraction Fringe — neutral defaults render byte-identically; threaded through `bokeh`, `coc-blur` and `dof-gather` in both shader dialects) | Same + denser commercial solver | Verbs and camera views at parity; COLMAP-grade solve open |
| Lights | 5 types (`LightType: point, ambient, spot, parallel, environment`), falloff, cone feather, Blinn-Phong, **light presets + Kelvin colour temperature** (`colorTemperature.ts`); **environment** is an SH irradiance probe (procedural sky presets **or any image / EXR asset**, projected to 9 coefficients, expressed as a derived ambient + up to six parallel lights — zero renderer changes) | 4 types + cast shadows | Parity, plus IBL AE has no equivalent of |
| **Reflections / IBL** | **Shipped 2026-09-02**: a prefiltered specular atlas built from the environment light's own sky (importance-sampled GGX, one level per roughness) + split-sum IBL with an analytic env-BRDF in **both** dialects (WGSL + GLSL), behind a Reflections row. Physical and Phong reflect; Toon deliberately does not. Gated so pre-existing scenes are byte-identical (`environmentReflections.test.ts`). **2026-09-14: AE's per-material reflection axes** — Reflection Intensity (scales the env term), Reflection Sharpness (samples the atlas at roughness × (1 − sharpness)) and Reflection Rolloff (Schlick view-angle weight, F0 from the material's IOR) — keyframeable Material Options, defaults byte-identical. *Appears in Reflections* is deliberately omitted: it only means anything to a layer-to-layer reflection pass, which does not exist here | Advanced 3D image-based lighting + environment reflections; Appears in Reflections (On/Off/Only) | Parity on the reflection model and its material axes; no ray-traced/screen-space (layer-to-layer) reflections, so no Appears-in-Reflections switch |
| **Materials** | Material section with a live shading preview, every reflectance parameter in one place, **per-face overrides**, and a persisted **material library** seeded from the built-in presets (`core/scene/material.ts`, `materialStore.ts`); **2026-09-14: the Advanced-3D axes** — Reflection Intensity / Sharpness / Rolloff (on the IBL env term), **Transparency + Transparency Rolloff + Index of Refraction** (view-dependent Fresnel-weighted alpha at the shading stage — Schlick, F0 from the IOR; facing transmits more than grazing, the glass look) — all keyframeable, all exact identities at defaults. Like Specular, they render on the lit depth-tested GPU path (Accepts Lights on, ≥1 light). No refraction pass — IOR shapes the Fresnel only | Material Options (incl. Transparency/IOR with refraction render) + Substance materials | Parity for the parameter set (transparency is Fresnel-faded alpha, not refracted); no Substance graph |
| **World settings** | Composition Settings ▸ **World**: default environment for new lights, ground level for the grid, sky backdrop — all optional and absent until set, so old documents round-trip unchanged | Environment layer / renderer settings | Parity |
| Geometry | Extrusion + bevels (**angular / concave / convex**) + per-face materials (`FACE_SURFACE_IDS`); **real curved primitives** since 2026-09-02 — sphere, cylinder, cone, torus, capsule and box are mesh layers with editable segment counts and smooth per-vertex normals (`core/geometry/primitiveMesh.ts`), while cube and plane keep their bevel-capable extruded forms; **plus imported `.glb` / `.gltf` meshes** — a 3D null per node, a mesh layer per primitive, drawn through the same extrusion mesh render path, with CPU skinning against joint layers, morph-target blend shapes, baked animation clips, and 3D IK (CCD) over joint chains | Advanced 3D: glTF + parametric meshes + Substance PBR, height displacement, IBL | Narrowed to two items — meshes, curved primitives, skinning, morphs, baked clips, PBR maps and IBL+reflections all ship; **shadow maps shipped 2026-09-02** (opt-in per light, PCF, two mapped lights per run since 2026-09-09); ~~SSAO~~ — **SSAO shipped** (`rendergraph/passes/ssao.ts`: linear-depth prepass + hemisphere AO + depth-aware blur, Composition Settings ▸ World — see item 13 below, which recorded it first while this row lagged) and ~~height displacement~~ — **height displacement shipped 2026-09-09** (Material Options ▸ Displacement: any image asset as a height map, keyframeable amount, 0–3 subdivisions, recomputed normals; extrusions, primitives and glTF meshes alike) |
| **PBR texture maps** | **Shipped 2026-09-02** (`core/media/gltf.ts`): normal, metallic-roughness, occlusion and emissive on a separate `mesh3d-pbr` material, texture transforms baked into UVs, tangents from derivatives. External `.gltf` files import **with their sidecars**, refusing by naming the ones they cannot find. **File ▸ Import 3D Model** | Substance / glTF PBR maps | Parity for the glTF map set plus height displacement (2026-09-09); no Substance graph |
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
| **Audio engine** | Multi-voice + **time-remap / precomp-ancestor piecewise varispeed**; per-layer **Pan** (`StereoPannerNode`, keyframeable, byte-identical when centred); dB levels and pan share ONE ramp builder with the offline mixdown, so preview and export cannot drift | Keyframed stereo Audio Levels | Parity, plus varispeed AE lacks |
| **Audio edit verbs** | **Silence removal**, **ducking** with Re-duck, **noise gate**, **fades**, beat grid, audio-reactive property driver — all baked to `audioLevelDb` keyframes you can see and drag | None of these | 🏆 **Premation wins** |
| **Audio effects** | All 10 AE classics **plus AE 26.3's Compressor, Distortion (6 curves + bitcrusher) and De-esser**; EQ 3 bands, Tone 5 tones + white noise, Flange & Chorus multi-voice, Reverb diffusion/brightness, Modulator AM+FM. Native nodes only, each with an offline twin | 13 effects incl. Gate | Parity on 13 of 14; **Gate** is a baked verb here (no native expander), and AE's Auto Release / Downsample need a worklet |
| **Audio UI** | **Audio panel (Ctrl+4)** — VU with clip indicators + peak hold, two faders editing the selected layer, Units and Slider Minimum; speaker switch in the layer column; `L` / `LL` reveal; **audio-only preview** (Numpad .); tap markers (Numpad *); Preferences ▸ Audio (output device, latency) | Audio panel, A/V Features, L/LL, Numpad . | Parity |
| **Audio visualizers** | Audio Spectrum + Audio Waveform with **Use Polar Path**, mask **Path**, Start/End Point, Side Options, Softness, Hue Interpolation, Audio Duration/Offset, Displayed Samples, Mono/L/R | Same parameter set | Parity (the Waveform effect drew nothing at all before 2026-09-12 — its resolved samples were never written) |
| Export | ProRes 4444, MP4, WebM, GIF, PNG/JPG, **EXR sequence (WebGL2/WebGPU linear RT readback)**, Lottie, **EDL / OTIO / FCPXML / ALE**, **`.mogrt.zip`**, HDR10/HLG, plus **chapters from labelled comp markers** on MP4/MOV (ffmetadata sidecar + `-map_chapters`) | AME formats incl. HEVC, EXR, true `.mogrt` / AAF | Strong; Adobe-native mogrt / binary AAF open |
| **Render queue pause / resume** | **Shipped 2026-09-02** (`renderQueueStore.ts`): Pause one job or Stop the queue — both keep the staged frames and a `resumeFrame`, and a resumed job keeps its progress; **Discard** is the separate destructive verb, and half-rendered jobs are picked up first. **Survives a relaunch ✅ (2026-09-08)**: each job's spec, output path, `status` and `resumeFrame` are persisted (`renderQueuePersist.ts`, key `renderQueue.jobs`) and its staging dir is found again through its manifest; restored jobs come back paused, never auto-start, and a job whose frames or composition are gone is flagged rather than silently restarted | Pause / resume in the Render Queue and AME | Parity, including across a relaunch |
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
13. **3D occlusion** — **Shadow maps shipped** (`rendergraph/passes/shadowMap.ts`: opt-in per light, 3×3 PCF, packed linear-distance target, byte-identical when off; **one mapped light per run** — the remaining limit; point lights along their aim). **SSAO shipped** (`rendergraph/passes/ssao.ts`: a camera-axis linear-depth PREPASS reusing the shadow-caster shaders, half/full-res hemisphere AO + depth-aware blur, Composition Settings ▸ World). ~~Still open: height displacement~~ **Height displacement shipped 2026-09-09** (`core/scene/heightDisplacement.ts`); **a second shadow-mapped light shipped 2026-09-09** (bindings 13/14, its own tail block; a third still projects). A shadow catcher exists as Accepts Shadows ▸ Only
14. ~~Cross-layer DOF~~ — **shipped** as the per-pixel depth-buffer DOF gather for 3D groups (see `motion-editor-dof-gather`); `coc-blur` / `bokeh` remain for flat layers
15. ~~Render-queue resume across a relaunch~~ — **shipped 2026-09-08**: `status` + `resumeFrame` + output path persisted per job, staging dir re-adopted on launch, restored jobs paused with Resume / Remove and a needs-attention flag when the frames or the composition are missing

**Removed from earlier drafts (shipped):** ExactVideoSource; point / stabilize / corner / mask tracking; disk cache; Wiggle Transform; Dissolve modes; field separation; variable-font weight; Pixel Motion; variable mask feather; Smooth Stabilize; Clone Stamp; subspace / RS; SfM + BA; Roto / GrabCut / SAM-class; CAF video; float EXR GPU + HDR10/HLG + MaxCLL; EXR/DPX/PSD; EDL/OTIO/FCPXML/**ALE**; mogrt.zip; font wdth/slnt; **WebGPU float RT readback**; **glTF import + skinning + morphs + PBR maps**; **environment reflections / IBL**; **curved primitives**; **timeline edit tools + per-cut transitions**; **source monitor**; **scopes**; **transcript editing**; **silence removal + ducking**; **render-queue pause/resume**; **one graph editor**; **modifier stacks**; **audio drivers**; **bake dynamics**; **knife + pathfinder**; **on-canvas gradient editor**; **smart guides**.

## 3b. Addendum — 2026-09-07/08

- **Object Matte is bundled**: the SlimSAM encoder/decoder pair ships inside the app (`samBundled.ts`, `samPipeline.ts`); neural segmentation works with no download. Tier 1 item 1 is closed. The slimsam export has no box embeddings — a drawn box prompts with its centre and constrains the mask (`promptsForSam`, `segmentSam`).
- **Tracker instrument** at AE parity: marquee pick (box → search region), on-footage feature/search box resize, magnifier loupe, "Parent to null" after apply, numbered nulls; the dead-pick state bug (overlay required the source layer in the selection) is fixed.
- **Path-following effects**: Write-on and Vegas take a mask path (`pathMaskId`, resolved per frame from the animated mask) — tracked masks move the effect. **Draw around object → mask** produces a decimated (≤48-pt) `none`-mode path from the exact frame.
- **Apply-to-"this layer" guard** (✅ 2026-09-08, `trackMotion/applyTargetGuard.ts`): choosing the tracked footage itself as the Apply target now raises one confirm that says the footage would move under its own track and offers **Create null & apply** instead; every other target applies as before.
- **Mask-tracker vertex cap** (✅ 2026-09-08, `maskVertexSampling.ts`): Track mask no longer refuses paths over 64 vertices — it tracks an arc-length-even subset of ≤64 and moves every other vertex with its two nearest tracked neighbours along the path; within the cap the write is unchanged.
- **Deep Glow + Energy Beam** (✅ 2026-09-08, `deepGlow.ts` / `beamPath.ts`): the two plugin-class looks AE needs Plugin Everything and Video Copilot for — an octave-pyramid physically based glow, and a Saber-class beam (core + inverse-power glow + curl distortion + flicker, Start/End reveal, taper) along a mask path, a text outline or a line, on the GPU; `lightning` follows a mask path too. The tracker demo now closes end to end: draw around the wheel → tracked mask → Energy Beam on the path.
- **Particles v2** (✅ 2026-09-09, `particleSim.ts`): sphere (ball) emitter with depth, camera-lens-aware perspective for 3D particle layers, sprite/sprite-sheet particles from any image asset, exact closed-form drag, mid-point size/opacity/colour ramps, continuous parent→child emission and velocity streaks — all still pure functions of (config, time), so scrubbing and export stay byte-identical. Not done: particles sorting against other 3D layers or taking the camera DOF per particle (the field is one card), fluids.
- **Plexus** (✅ 2026-09-09, `plexus.ts`): the Rowbyte-class point/line network as a Generate effect (drifting point cloud or a mask path's vertices; distance-faded links, triangles, points) and as a Particle-section option over live particles.
- **Height displacement** (✅ 2026-09-09, `heightDisplacement.ts`): AE 26.2's displacement for 3D materials — an image asset's luma pushes extrusions, primitives and imported meshes along their normals (keyframeable amount, 0–3 subdivisions, normals recomputed), Material Options ▸ Displacement.
- **Second shadow-mapped light** (✅ 2026-09-09): two lights per 3D run cast geometric shadows from their own maps, each darkening only its own lamp; a third still takes the projected copy.
- **Cryptomatte on EXR import** (✅ 2026-09-09, `media/cryptomatte.ts`): the manifest and rank channels are read at import; Track Matte ▸ Matte Source offers "ID matte: <object>", which bakes the object's coverage to a grey matte layer above the EXR and wires it as the luma matte.
- The next-step argument (glow, energy beam, particles v2, plexus, displacement) lives in [`ENGINE_STRENGTH_PLAN.md`](ENGINE_STRENGTH_PLAN.md).

## 4. Roadmap (corrected)

**Phase 1 — neural priors:** host a SAM ONNX decoder and set `VITE_SAM_MODEL_URL` — the runtime and the boot call are in.

**Phase 2 — footage depth:** camera raw / MXF float pipelines.

**Phase 3 — ecosystem:** Adobe-compatible `.mogrt` binary layout; binary AAF (or rely on OTIO→AAF adapters + ALE).

---

*Sources for the AE side: Adobe release notes and coverage of AE 26.0–26.3
(January–June 2026). Premation side: this repository; counts are pinned by tests
(`blendMode.test.ts` = 38, `EffectType` = 204, AI tools = 65, `PathOpType` = 9,
`MaskMode` = 7, layer styles = 9+1). The `EffectType` and AI-tool figures were
both stale here on 2026-09-02 — 174 and 61 — which is the drift
`docPropagatedCounts.test.ts` exists to stop; that guard covers
`EDITOR_REFERENCE.md`, `README.md` and `ROADMAP.md`, and this file is outside
its scope, so re-derive from `scripts/featureCounts.cjs` before quoting these.*
