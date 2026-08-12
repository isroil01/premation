# Premation — Editor Reference

**Counts derived from source at `7e59fd0`; prose last verified 2026-08-11.**
Every count in §1 comes from `scripts/featureCounts.cjs`, which reads the
registries the product dispatches on, and is held there by a test.

**The prose is not under test — see §0.** A verification pass on 2026-08-10
found four false claims in §3/§4 and they are recorded in §5.

---

## 0. How this document is kept true

The previous reference (`PREMATION_COMPLETE_REFERENCE.md`, deleted) claimed
**38** effects in one table and **58** in another while `EffectType` held **73**.
It declared `trim` and `repeater` permanently outside the path-operator chain
months after they joined it. It listed continuous rasterization as the last
unbuilt gap when the feature ships with a renderer read path and an inspector
control. Three audits re-derived the same numbers by hand and got three
different answers.

So the numbers are no longer written by hand:

```bash
node scripts/featureCounts.cjs --verbose
```

`src/__tests__/docFeatureCounts.test.ts` parses the table in §1 and fails the
build when it disagrees with the registries. Adding an effect reddens the suite
until this file is updated — which is the point.

### What the pinning does NOT cover — read this before trusting a sentence

**Only the §1 table is under test. Every other line is prose, and prose is
where the errors actually were.**

This is not a hypothetical caveat. A verification pass run the day after this
document was written found **four** false claims in §3/§4 — a fabricated
template capability, a "dead" toggle that had already been deleted, an
architectural claim about lighting that was the opposite of the truth, and a
subsystem described as working that has no implementation. Two of them were
inherited verbatim from the deleted predecessor and restated here without being
checked, which is precisely the failure this document was created to end.

So the rule is narrower than it looks:

- A **number** in §1 is a number a test is holding down. Trust it.
- A **sentence** anywhere is a claim someone believed on the day they wrote it.
  Verify it against the code before acting on it, and if it disagrees with the
  code, the code wins and §5 gets a new row.

Prose cannot be pinned the way counts can. What §5 buys instead is that a claim,
once disproved, stays disproved — it is there so a superseded statement is not
rediscovered in git history and believed a second time.

---

## 1. Feature counts

<!-- FEATURE-COUNTS -->

| Registry | Count | Source of truth |
|---|---|---|
| Effects | 145 | `src/core/effects/effects.ts` → `EffectType` |
| Blend modes | 36 | `src/core/effects/blendMode.ts` → `LayerBlendMode` |
| Layer styles | 10 | `layerStyles.ts` → `LAYER_STYLE_LABEL` + `BACKDROP_STYLES` |
| Path operators | 8 | `src/core/scene/pathOps.ts` → `PathOpType` (less `none`) |
| Mask modes | 7 | `src/core/effects/mask.ts` → `MaskMode` |
| Light types | 4 | `src/core/scene/light.ts` → `LightType` |
| Canvas tools | 20 | `packages/workspace/src/tools/builtin.ts` |
| AI tools | 61 | `packages/ai-tools/src/tools/{read,write,craft,compose}.ts` |
| Export formats | 9 | `videoSink.ts` → `VideoFormat` + `exportManager.ts` → `ExportFormat` |
| Stores | 40 | `src/stores/*.ts` |
| Packages | 12 | `packages/*` |

<!-- /FEATURE-COUNTS -->

Layer styles come from **two** registries. Most compile to an effect and live in
`LAYER_STYLE_LABEL`; Glass cannot, because it is a function of what is
composited behind the layer and so resolves onto the renderable
(`glassResolve.ts`). It lives in `BACKDROP_STYLES`, and the script sums the two.

It used to append a literal `'glass'` instead — a hand-written number inside the
script that exists to eliminate hand-written numbers. A second backdrop-resolved
style would have left this table wrong with every test still green.

---

## 2. Architecture

```
Electron main ── IPC ──▶ renderer (React 19 + Vite)
                          │
                          ├── src/stores/*        40 Zustand stores
                          ├── src/core/*          41 subsystems (effects, scene, rig, text…)
                          └── packages/*          12 workspace packages
                                ├── scene       scene graph + components
                                ├── animation   tracks, easing, expressions
                                ├── renderer    WebGPU → WebGL2 → Null
                                ├── workspace   tools, selection, gizmos
                                ├── timeline    timeline model
                                ├── ai-tools    the 61-tool registry
                                ├── caster      deterministic technique caster
                                ├── technique-library
                                ├── product-motion, audio, design-system, render-tests
```

**One engine for preview and export.** `src/core/export/offlineRenderer.ts`
calls the same `createRenderBackend` + `buildSnapshot` pair the viewport uses,
on a fixed timestep (`frame index / fps`). There is no separate export renderer,
so the "final render looks different from the preview" class of bug does not
exist here. Backed by real-GPU golden-image tests in `packages/render-tests`.

**Backend selection** (`createRenderBackend.ts`): WebGPU when `navigator.gpu`
exists → WebGL2 → Null for headless/tests.

### The render path, end to end

```
scene graph ──▶ buildSnapshot ──▶ snapshotToFrameScene ──▶ rendergraph passes
   (nodes)        (per-frame        (render structs)         Clear · Background
                   sampling of                               Composition · Mask
                   every track)                              Effect · Selection · Overlay
```

`buildSnapshot` is where per-frame resolution happens — it samples every
animated track, resolves expressions, computes shading multipliers and DOF blur,
and folds the result into a content hash used for raster caching.

---

## 3. What the editor does

Verified present with a reader in the render path, not merely declared.

### Animation model
Keyframes with bezier/hold/linear interpolation, a **value + speed graph
editor**, keyframe-selection time scaling, roving, and Easy Ease assistants.
Expressions are a **hand-written language** (`packages/animation/src/expressions.ts`,
~970 lines) with cycle detection and a depth cap — not `new Function`, which is
what lets them run under the app's CSP. Step and depth budgets guard against
main-thread DoS from nested `wiggle()` octaves.

**The expression API is much wider than "curated" suggests** — ~50 identifiers,
not the "~18 functions" earlier docs claimed. It includes the whole
time-sampling set the AE idiom library is built on: `valueAtTime`,
**`velocityAtTime`**, `velocity`, `speed`, `key(n)`, `nearestKey()`, `numKeys`,
`timeToFrames`, `framesToTime`, `loopIn`/`loopOut`, `sourceRectAtTime`,
`posterizeTime`, `seedRandom`/`gaussRandom`, vector maths
(`add`/`sub`/`mul`/`div`/`dot`/`cross`/`normalize`/`length`), layer-space
conversion, `thisLayer`/`thisProperty`/`thisComp`, markers and `audio`.

That matters more than the count: the standard AE bounce expression, inertial
follow and delayed-child rigs are all built on `velocityAtTime` + `key()` +
`numKeys`, and **all three primitives are present**, so that class of expression
ports as-is. There is no architectural limit on sampling a track away from the
current frame — `sampleRaw` reads keyframes only, deliberately bypassing the
expression so `valueAtTime` cannot recurse through itself.

There is still **no named easing-preset registry**: easing is bezier handles plus
the assistants in `keyframeAssistants.ts`. `BOUNCE_EASE` in
`animationPresets.ts` is a single cubic-bezier (`0.175, 0.885, 0.32, 1.275`)
commented "Elastic bounce" — a bezier has one overshoot and cannot express a
decaying bounce, so the name overstates it.

**Bounce is a keyframe assistant** (`bounceTracks` / `bounceKeyframes`, menu:
Bounce Keyframes), not an ease — it generates decaying keys with amplitude *and*
duration both scaled by decay, which is what separates gravity from a flutter.

### Compositing
36 layer blend modes on one GPU shader path (`BLEND_COMBINE`), including the
four Stencil/Silhouette modes. Bezier masks with all 7 AE modes (`none`
included), effect-scoped masking, and protected time regions. Track mattes
(alpha/luma ± invert), decoupled from stacking order. Precomps with nesting and
**continuous rasterization** (`continuousRaster.ts` → `buildSnapshot` →
`MotionRendererBackend` → `AppTextureProvider`, control in `PrecompControl.tsx`).

### Motion blur
Shutter angle, shutter **phase**, and **adaptive sampling** — all three.

### Shapes
Eight **chainable** path operators: `zigzag`, `roundCorners`, `pucker`, `twist`,
`offset`, `roughen`, `trim`, `repeater`. The chain reorders, and the schema-1.3.0
migration re-keys keyframe tracks onto the new operator ids. AE permits one trim
and one repeater per shape; so does this (`pathOps.ts` resolves each with
`find`), which is parity rather than a limit.

The chain's currency is a **list** of `PolyRun`s, not one polyline — that is what
lets trim live in it, since trimming produces multiple open arcs.

### Text
Full animator selector stack, multiple selectors, wiggly selector, per-character
3D, rich text, paragraph text, text-on-path. `textPath` is correctly *not* a path
operator: it consumes a mask and emits glyph placement, so it neither accepts nor
produces the chain's currency. AE models this the same way (Text → Path Options).

### 3D
Classic 3D: cameras, 4 light types (point/ambient/spot/parallel) with AE falloff
curves and cone feather, extrusion with bevels, face materials, ortho views,
quad view. See §4 for what "3D" does **not** mean here.

### Rigging
Bone skeleton with **FK, IK and FABRIK**, weight painting, vertex weight editing,
plus an **ARAP puppet** with pins and sketch. Both compose on the same layer and
are GPU-deformed. AE has no skeleton at all — its users buy DUIK.

### Particles
`particleSim.ts` — a deterministic closed-form emitter. Particle *i* is born at
`i / birthRate`, its randoms hash from `i`, position is the closed-form ballistic
`p0 + v0·age + ½g·age²`. No frame stepping and no accumulated state, so scrubbing
to any time gives the identical frame. See §4 for the cost of that choice.

### Composition background and export alpha

Composition background and pasteboard are separate at every layer: store
(`background` + `transparent`), transport (`snapshotToFrameScene`), render
(`BackgroundPass`, clipped to the comp rect) and UI. A transparent comp is a
real hole in the canvas; the viewport shows a checkerboard clipped to the comp
rect behind it (`Workspace.module.css .transparencyGrid` — a DOM element, so no
render-path or export involvement). The background ColorPicker exposes alpha, so
**partial** alpha is user-reachable, not only expressible in the model.

What actually reaches each export format — verified against the encoder args,
because the dialog previously claimed all of them kept alpha:

| Format | Alpha | How |
|---|---|---|
| `mov` | ✅ | ProRes 4444, `yuva444p10le` |
| `webm` | ✅ | VP9 `yuva420p` + `-auto-alt-ref 0`, PNG staging |
| `png`, `png-sequence` | ✅ | staged as PNG |
| `mp4` | ❌ | libx264 `yuv420p` — flattened over **black** |
| `gif` | ❌ | palettegen/paletteuse requests no transparency (the format *has* 1-bit transparency; the graph does not ask) |
| `jpg-sequence` | ❌ | JPEG has none |
| `json`, `lottie` | n/a | carry no comp background at all |

### Import / export
Lottie **import and export**, SVG import including SMIL and CSS animation,
image sequences, video with audio. Nine export formats: `mp4`, `webm`, `gif`,
`mov`, `png`, `png-sequence`, `jpg-sequence`, `json`, `lottie`. mp4/mov need the
desktop app (ffmpeg); the browser gets WebM or a PNG sequence.

### Templates
Exposed fields (`templateFields.ts`), **5** field kinds (`text`, `color`,
`number`, `image`, `media`), media slots (`mediaSlots.ts`), responsive time and
protected time regions (`responsiveTime.ts` → `TimelineController` →
`ResponsiveTimeSection.tsx`). 12 test files.

**There is no data binding.** `dataBinding`, `dataSource` and `csvBind` have
zero hits repo-wide. It was listed here as shipped; it does not exist, and
building it is greenfield work rather than a remainder.

### AI
61 typed tools over a deterministic caster and a hand-authored technique
library, with a validator that assumes the model lies, a self-critique pass using
rendered-frame evidence, and a hard *one prompt = one undo entry* contract.
**Server edition only** — `aiEnabled()` is `isServerEdition()`, and the panel,
renderers, settings tab and Electron IPC registration are each gated
independently (pinned by `editionAiSurface.test.ts`).

### Plugins
Worker sandbox with `fetch`/`localStorage`/DOM removed, permissions shown before
any code is downloaded, signed packages, heartbeat termination, declared-host
network access proxied through the main process, and API 4 shader effects that
can draw pixels. Every plugin mutation is one undo entry. This is the most
actively developed area of the repo — 211 of the last 211 commits touch it.

---

## 4. The honest gap against After Effects

The question this section answers: **can a user build a complex, high-design
motion video here?** For 2D motion design — kinetic typography, logo stings,
product and UI motion, shape animation, rigged 2D character work — yes. The core
compositing and animation model is at genuine parity.

The gaps are not in the engine. They are in the layer above it.

### Tier 1 — categorical exclusions

**No motion tracking, no camera tracking, no rotoscoping.** Zero hits for
`tracker` or `rotoscop` across `src/` and `packages/`. Any work that composites
onto filmed footage — screen replacements, set extensions, object removal — is
impossible, not merely awkward. This is the single largest excluded category and
it is out of scope by direction.

Re-verified 2026-08-11 and widened: `stabiliz`, `warpStabil`, `mocha`,
`featurePoint`, `solveCamera`, `rotoBrush`, `contentAware`, `refineEdge` and
`opticalFlow` are **all zero hits** too. So it is not only the 3D camera tracker
that is absent — the whole AE footage-repair column is: point/planar tracking,
Warp Stabilizer, Roto Brush, Refine Edge, Content-Aware Fill. What *does* ship
for footage work is keying (`keylight`, with despill/choke/softness, plus
`linear-color-key`, `simple-choker`, `set-matte`, `shift-channels`) and
`corner-pin` / `bezier-warp` — i.e. you can key and you can pin a corner **by
hand**, but nothing solves the motion for you.

**The footage decode path is an `HTMLVideoElement`, not a decoder.**
`videoFrameCache.ts` says so in its own header, deliberately: a real
`VideoDecoder` would give true random access and exact frame boundaries, but it
needs a container demuxer (mp4box or equivalent) — "a subsystem, not a change".
So seeking is `seek → onseeked → repaint`, and frame boundaries are approximate
and browser-dependent. That is the remaining ceiling on treating this as a video
editor rather than a motion tool, and it is upstream of tracking: a tracker
cannot be more frame-accurate than the decoder feeding it.

**Read the next two paragraphs before repeating the older version of this
claim.** Proxies and footage interpretation both **exist**, and the frame-rate
limit this section used to assert has been fixed — see §5's 2026-08-11 row.

`src/core/assets/proxy.ts` is a measured proxy system (seek is 97.6 % of the cost
at 4K; proxies win on resolution *and* GOP length, hence `-g 12`), and its
export invariant is enforced by **polarity** rather than vigilance: `useProxies`
defaults absent/false and only the interactive viewport ever sets it true, so
export, the offline renderer and the render-test harness cannot opt in by
forgetting. Proven against encoded output in `proxyExport.test.ts`.

`src/core/source/sourceInfo.ts` holds a real `FootageInterpretation`, stored
per-**asset** rather than per-layer: `conformFps`, `alpha` (premultiplied
interpretation, read by the renderer), `loopCount`, PAR. A proxy substitutes
pixels only — every timing and geometry fact keeps reading the original asset's
`metadata` and `interpret` through `sourceOf`, so a proxy cannot drift out of
alignment with its source by construction.

What genuinely remains missing from this column: **pulldown removal**, and a
placeholder/offline-media workflow.

**Depth of field is per-layer, not per-pixel.** `dofEffectOf` (`buildSnapshot
.ts`) computes one blur value from a layer's depth and pushes it as an ordinary
`blur` effect. A layer that spans depth — a ground plane, a steeply tilted card
— gets a single uniform blur across its whole surface. There is no DOF code in
`packages/renderer` at all. This is the difference between "3D-ish" and
cinematic.

Corrected 2026-08-12: this used to name "a long extruded title" as the second
example, and for an **extruded** layer it is no longer true. Every synthesized
face carries its own `depth`, so each takes its own DOF radius now that faces
carry effects at all — an extruded solid defocuses across its depth, within the
face budget in `faceEffects.ts`. What stays per-layer is a *single* quad that
spans depth, which face synthesis cannot help. See the ledger entry below.

Added 2026-08-11: it is also a **Gaussian** blur, so there is no bokeh. AE's
camera carries Iris Shape, Blades, Roundness, Aspect, Rotation, Diffraction
Fringe and Highlight Gain/Threshold/Saturation — the parameters that turn
defocused speculars into readable discs. None of them exist here (`bokeh`,
`blades`, `iris` hit only transitions and AI prompt text), and the highlight
bloom in particular is what makes a defocused background read as *filmed*
rather than as blurred. A per-pixel DOF pass should be specified with the
iris and highlight parameters, not just a depth-varying blur radius.

**Lighting is per-fragment on the depth path, per-quad only as a fallback.**
This entry previously claimed the opposite. The depth-tested 3D path runs real
per-fragment Lambert **plus Blinn-Phong specular** in the shader
(`builtin.ts` `fn shade3d`), using a world-position varying
(`o.world = obj.model * vec4(pos,0,1)`); `shadeLayer`'s per-quad RGB multiplier
is the `quadGain` **fallback** for branches that cannot shade per-fragment
(`FrameScene.ts` — matte, adjustment, precomp, advanced blend, glass, motion
blur, deformed mesh). Extruded geometry is shaded **per face**, each face being
its own renderable with its own normal.

What remains true: **2D layers receive no Lambert shading at all**
(`buildSnapshot.ts` gates it on `is3D`), non-depth-eligible layers still fall
back to per-quad, and shadows are 2.5D projections rather than geometry-aware
cast shadows.

Sharpened 2026-08-11 — "per-fragment" is doing less work than it sounds like.
`fn shade3d` opens with `let N = normalize(obj.model[2].xyz)`: the normal is the
**renderable's Z axis, constant across the whole surface**. What varies per pixel
is the light vector, distance attenuation and falloff, via the world-position
varying. So a large layer near a point light does get a real gradient, but no
layer can have surface *detail* — there are no normal maps (`normalMap`: 1 hit,
`envMap` / `roughness` / `metalness` / `hdri` / `pbr`: zero), and extrusion is
shaded per **face**, each face flat. Likewise `shadowCatcher`, `environmentLight`
and `imageBased` are all zero hits, so there is no image-based lighting and no
way to land a 3D element on a real plate.

**Particles are structurally limited by the determinism choice.** 253 lines:
3 emitter types, 4 shapes (circle/square/line/star), gravity, spin, and
size/colour/opacity ramps. There is **no turbulence or wind field, no collisions,
no sub-emitters, no trails, no layer-as-particle, and no 3D particles.** Exact
scrubbing is a genuinely valuable property, but closed-form position is precisely
what forbids the interacting, stateful behaviour that Trapcode Particular, Form
and Plexus are bought for. Lifting this ceiling means giving up the closed form.

**No imported 3D models, PBR or HDRI.** "3D" here means 2D layers with extrusion
placed in a 3D space — not a rendered 3D scene. Out of scope by direction.

**No colour management, and no linear working space.** Added 2026-08-11. The
float *precision* work shipped — `rgba16float` compositing intermediates
(`rendergraph/passes/index.ts`), WebGL2 gated on `EXT_color_buffer_float` — but
step 5 of that plan, linear light, did not. There is no sRGB decode on input, no
encode on output, no project working space, no 32-bpc depth, no LUT/ACES/ODT and
no HDR output. (`colorSpace`, `colorManagement`, `acescg`, `bitDepth`: zero hits.
The `linearColor` hits are the Linear Color Key effect, unrelated.)

AE has had 8/16/32 bpc plus a project working space for over a decade. The
consequence here is not abstract: every add/screen/overlay blend, every glow and
every blur composites in **gamma space**, which is a large part of why a
gamma-space glow reads as dirty in the falloff where AE's reads as lit. It
belongs in Tier 1 rather than Tier 2 because it is not a missing feature the user
can route around — it is the colour behaviour of every pixel the app produces.

The blocker is the **alpha invariant**: textures are premultiplied at upload *in
sRGB* (`gpu/types.ts`), and you cannot cheaply re-premultiply in linear after
sampling premultiplied-sRGB texels. Doing this properly changes the appearance of
every blend mode and every alpha edge in existing projects, so it needs a
deliberate render-test golden rebaseline, not a flag.

### Tier 2 — ceilings on visual density

**Effect breadth: 145 effects vs AE's 400+.** The raw count misleads in both
directions — nobody uses 400, and the 145 effects present are properly
parameterised (Levels, Curves, Channel Mixer, Keylight with
despill/choke/softness). What matters is the missing *classes*, not the delta:
no 3D Stroke, no Form/Plexus, no Element 3D. The dense, expensive-looking AE
frame is usually five to eight stacked third-party effects, and that stack has
no equivalent here.

Corrected 2026-08-12, twice over. The number said **73** — the count when the
sentence was written, left behind by registry growth, and the value every brief
written against this document inherited. And the missing *classes* named "no
volumetric light rays (Shine)" and "no optical-flare system worth the name":
`light-rays`, `lens-flare`, `light-sweep` and `beam` all ship, each with a
registry def, a Canvas2D implementation and a Generate entry in the effects
browser. They are CPU passes rather than shaders, which is a performance fact
(see the GPU-porting work) and not an absence. The count is now phrased as "145
effects" rather than as a bare figure specifically so that
`docPropagatedCounts.test.ts` can check it.

**Uniform mask feather only.** `MaskPoint` carries x/y plus handles and one
scalar feather per path. AE's variable-width feather — the tool for organic
matte blending — has nowhere to store its per-point width.

**No Wiggle Transform shape operator.** The `wiggle()` *expression* is complete;
the shape operator is a different feature and is absent. **Wiggle Paths, listed
here earlier the same day, DOES exist** — stored as `roughen`, which is why a
grep for `wigglePath` found nothing. See §5's correction; it gained the
Correlation parameter it had been missing.

**Frame blending is Frame Mix only.** Added 2026-08-11. `buildSnapshot.ts:1796`
returns `undefined` unless `frameBlend === 'mix'`; `pixel motion` and
`opticalFlow` are zero hits. AE offers Frame Mix *and* Pixel Motion, and Pixel
Motion is the one people actually reach for on retimed footage. Every slow-motion
shot here therefore gets AE's worse mode — which is a shame, because the rest of
the retiming stack (spatial tangents, roving keys, `timeRemap` sampling on
precomps, and now a real source frame rate) is well built. Note the dependency:
real optical flow wants exact source frames, so it sits behind the decoder
problem in Tier 1.

**Two blend modes short:** Dissolve and Dancing Dissolve. Both are per-pixel
stochastic, and the real cost is a preview↔export determinism contract, not the
blend maths. Classic Color Burn/Dodge/Difference currently render identically to
their modern counterparts — kept for round-tripping and picker parity, and
documented as such rather than silently wrong.

**No 3D gizmo snapping** — as a *feature*. The half-built switch this entry used
to describe is gone: `gizmo3dSnapping` was deleted with nine sibling symbols and
`src/stores/__tests__/deadLayoutState.test.ts` keeps it deleted.

### Tier 3 — friction on long or complex projects

- Render queue **Stop** discards progress; real pause/resume is unbuilt. The
  offline loop itself is resumable in principle — fixed timestep, `index / fps`,
  an existing `startFrame`/`endFrame` range, no accumulated state — but the sink
  is disposed on abort and takes its ffmpeg staging directory with it.
- **No local project browser** in the OSS edition — it opens straight into the
  editor. Of the two foundations this entry used to call ready:
  `RecentProjects` (persisted MRU) and `bundle/VersionStore.ts` (local,
  bundle-backed history) are **real and tested**, but the SQLite `LocalIndex` is
  **not an implementation** — `better-sqlite3` is absent from `package.json`, so
  `index:available` is permanently false and `getLocalIndex()` always returns
  `MemoryLocalIndex`, and nothing in `src/` ever calls `upsertProject` or
  `addRecovery`, so the index would be empty even with the driver present.
- **Essential Properties — BUILT 2026-08-11**, same day this line first
  recorded it as missing. Two instances of one comp can now differ:
  `compInstanceOverrides.ts` stores per-instance overrides of the numeric
  Transform set, keyed `<sourceNodeId>/<prop>`, edited in
  `CompOverridesSection.tsx` on the placed-composition inspector branch. There
  is still **no promotion step** — AE has you publish a property in the source
  comp first, whereas every source layer here offers the whole overridable set,
  and only the referenced comp's DIRECT children are listed. Extending the
  overridable set beyond numbers needs a second look, because `evaluateNode`
  returns `Map<PropPath, number>` and a colour or text override does not travel
  that path at all.
- **The frame cache is memory-only.** `renderCache.ts` and `videoFrameCache.ts`
  are both in-process and budgeted; `diskCache` is zero hits and nothing survives
  a restart. AE's disk cache is what makes iterating on a heavy comp bearable on
  day three.
- **No render-settings or output-module templates** (`renderSettings`: zero;
  `outputModule`: 2). Every queue entry is configured from scratch.
- **Pre-1.0**, with breaking `.motion` format changes still expected.
- **No collaboration** — removed by choice, but still a loss against Rive/Jitter.
- **No ecosystem**: no plugin market with content in it, no template marketplace,
  no tutorials, no hiring pool. This compounds the effect-breadth gap, because
  complex AE work is normally assembled from acquired presets and templates.

### Where it beats AE

Skeleton rigging (AE has none), the AI layer, plugin security, one engine for
preview and export, the open content-addressed `.motion` bundle format, built-in
Lottie export, and price.

### Highest-leverage work, if the goal is complex output

1. **Linear-light colour** — reordered to first on 2026-08-11. The precision
   foundation is already merged, so this is step 5 of a plan that is mostly done,
   and it improves every glow, blur and additive blend at once rather than adding
   one more thing to reach for. Cost is the alpha-invariant decision and a
   deliberate golden rebaseline, not new architecture.
2. **Particle system** — the largest single *feature* unlock, and it requires
   accepting a stateful simulation with a seeded-replay contract in place of the
   closed form.
3. **Per-pixel depth of field with an iris model** — a real renderer pass, not a
   per-layer blur. Fixes the "3D looks flat" complaint at its root.
4. **Essential Properties on precomps** — cheapest large win, because the
   template machinery it needs already exists.
5. **A focused effect pass on the light/glow/flare family** — the cheapest route
   to frames that read as expensive, and it compounds with (1).

Motion tracking is a much larger project serving a different audience and should
not be sequenced against these. Note also that it is **gated behind the decoder**
(Tier 1): a tracker cannot be more frame-accurate than the `HTMLVideoElement`
feeding it, so "add tracking" is really "add a demuxer, then add tracking".

---

## 5. Corrections this rewrite made

Recorded so the same claims are not reconstructed from git history and believed.

| Previous claim | Reality at `40ad98a` |
|---|---|
| "38 effects" / "58 effects" (same file, two tables) | **73** |
| "Chainable path operators — `trim` and `rep` remain single-slot", recorded as a permanent decision | Both **are** chain entries in `PathOpType` |
| "Continuous rasterization — the one remaining gap" | **Shipped**, with a renderer read path and an inspector control |
| "62 AI tools" | **61** |
| "47 Zustand stores" | **39** |
| "Cameras / lights / shadows — parity" | Shading is per-fragment on the depth path (see the 2026-08-10 row below); shadows really are 2.5D projections |
| Depth of field implied working | Per-layer uniform blur; no DOF in the renderer |

The pattern across all seven: a number or a status written once by hand, then
never re-derived. §0 exists to stop the next one.

### Corrected 2026-08-10, by a verification pass over this document

The five below were found by checking **this file's own prose** against the
code. Four were wrong. Two of the four were inherited verbatim from the deleted
predecessor and restated here without being checked — so the rewrite reduced the
propagation problem without ending it, which is why §0 now says plainly that
only the §1 counts are under test.

| This document said | Reality at `7e59fd0` |
|---|---|
| §4 "Lighting is a flat per-quad multiplier… no gradient across a large layer" | **Backwards.** Per-fragment Lambert + Blinn-Phong ship on the depth-tested path (`builtin.ts` `fn shade3d`, world-position varying); per-quad `quadGain` is the documented **fallback** (`FrameScene.ts`). Extrusion is shaded per face |
| §3 Templates include "data binding" | **Does not exist** — zero hits repo-wide for `dataBinding` / `dataSource` / `csvBind`. The other five capabilities are real and tested |
| §4 "No 3D gizmo snapping… a switch wired to nothing" | **Already deleted**, with `deadLayoutState.test.ts` keeping it deleted |
| §4 "the SQLite local index and version store both exist and are tested" | **Half true, and the wrong half was load-bearing.** The version store is real; `LocalIndex` is a declared interface with no implementation — `better-sqlite3` is not a dependency, so `index:available` is permanently false, and no caller ever writes a row |
| §4 "no DOF code in `packages/renderer`" | **Still true.** `dofEffectOf` (`buildSnapshot.ts`) remains a per-layer blur. Retained, not corrected |

Two defects were fixed rather than merely recorded, and both were the same
shape — a value honoured at one end of a boundary and silently dropped at the
other:

- **Three light parameters stopped at the CPU.** `coneFeather`, the AE falloff
  curves and a light's Point of Interest were read by `shadeLayer` and absent
  from `ShaderLight`, so the shader hardcoded a 20 % feather, degraded every
  falloff curve to linear, and tested the spot cone with a 2D aim no POI could
  reach. `lightShaderParity.test.ts` now fails if a field the CPU reads does not
  reach the GPU producer.
- **A spot light's cone did nothing on a 2D layer.** Every type rasterized to
  the same isotropic circle and the wash texture was cached on colour alone —
  which was a collision, not just a narrow key. Cone angle, cone feather and
  light angle were three shipped inspector controls with no visual effect.

### Corrected 2026-08-10 (second pass)

| Claim | Reality |
|---|---|
| Expressions are a small "curated" API, "~18 functions" | **~50 identifiers**, including `velocityAtTime`, `key(n)`, `numKeys` — so the AE bounce/inertia idiom class ports as-is. No architectural limit on sampling away from the current frame |
| §3 "easing presets" | There is **no easing-preset registry**. Bezier handles + Easy Ease assistants; `BOUNCE_EASE` is one cubic-bezier used by one preset and cannot express a decaying bounce |
| The transparency checkerboard was missing | It **existed**, as a full-bleed `.stageTransparent` on the stage — which is why a transparent comp looked like the surrounding panel had changed. Now clipped to the comp rect. (The earlier "only the Checkerboard effect exists" finding was a truncated grep, not a fact) |
| Layer label colours are unbuilt | **Already ship**: a 12-entry palette on `custom.labelColor` (`labelColor.ts`), persisted through `sceneProjectIO`, read by Scene rows, timeline track headers and clip bars |
| `SelectionPass` draws the selection chrome | It does **not**. `snapshotToFrameScene` sets `selection: []` unconditionally, so the pass never draws in preview or export; the real outline and handles are 2D-canvas overlay chrome in `useWorkspace.ts`. That overlay now tints each outline with its layer's **label colour** (dark halo underneath for contrast); handles follow only when exactly one layer is selected |
| The boot CSP error was cosmetic | It broke a feature: `media="print"` never flipped to `all`, so **no user-selectable document font ever loaded**. The UI looked right because its own faces come from a different `@import` |

### Corrected 2026-08-10 (third pass — camera)

The first two rows are corrections to **this** file's descendants rather than to
itself, and they are the reason `retiredDocClaims.test.ts` now exists: §5 was a
ledger inside one document, so a claim retired here stayed live wherever it had
been copied. The guard is repo-wide; this table remains the exemption, because
retiring a claim requires quoting it.

| Claim | Reality |
|---|---|
| `README.md` and `ROADMAP.md`: "58 effects" | **73**, from `featureCounts.cjs`, the same extractor §1 uses. The count guard existed but was scoped to this file's marked table, so the number was corrected here and left wrong in the two most-read files in the repo |
| `CAMERA_SYSTEM.md` §8.2 restated the retired per-quad lighting claim | Retired the day before, in the 2026-08-10 row above. Corrected there; the **shadow** half of that sentence (2.5D projections) was and is true and was kept |
| Cameras have no in-place X/Y rotation, so a tripod pan is inexpressible | **Was true, now built.** `orientationX`/`orientationY` are Transform scalars composed as OFFSETS onto the base aim in `cameraFromNode`, so they also work on a two-node camera without breaking its tracking. `Rx`/`Ry` were already in the `world → camera` matrix, driven only by orbit/look-at — the matrix alone did not reveal that, the value trace did |
| The camera orbit/pan/dolly tools are keyboard-only | **They are not.** Three visible toolbar buttons in `SceneControls.tsx` (`CAMERA_TOOLS`), plus the C-key cycle and a Tools-menu entry. Believed missing anyway, which is a discoverability lesson rather than a code one |
| Auto-Orient "Along Path" is meaningful on a camera | **It was offered and did nothing. Fixed 2026-08-11, and it was wider than reported** — see the row below |

### Corrected 2026-08-11 (fourth pass — the footage column)

These four were written into §4 **earlier the same day** and were wrong within
hours. Recording them in full because the failure mode is new and worth naming:
the first three came from **absence greps** — one candidate name per feature,
zero hits, claim written — and the fourth from quoting a **stale comment inside
a source file** as if it were current behaviour. §0 warns that prose is not under
test; it did not occur to me that a code *comment* is prose too.

| §4 claimed (2026-08-11, morning) | Reality |
|---|---|
| "No proxies. All 74 `proxy` hits are *network* proxy" | **False.** `src/core/assets/proxy.ts` + `proxyManager.ts` + three test files are a measured proxy system with an export-polarity invariant. The "all network" claim came from listing the first ten alphabetical matches, which happened to be `aiTransport.ts` / `csp.ts` — a sampling artifact stated as a census |
| "No footage interpretation — no alpha interpretation, conform-frame-rate or loop count" | **False.** `sourceInfo.ts` holds `FootageInterpretation` with exactly those fields, stored per-asset. **Pulldown removal** is the only named item genuinely absent |
| "The source frame rate is unknown" (Tier 1) | **False, and fixed 12 days before it was written.** `mediaProbe.ts` (2026-07-30) defines three tiers — `probed` (desktop + ffprobe: rate, duration, PAR, codec, audio inventory), `elementOnly`, `none`. It is *wired*: `buildSnapshot.ts:1811` reads `footageSourceOf(node)?.fps ?? fps`. Verifying the read path, not just the existence of the module, is what settled this |
| Quoted `videoFrameCache.ts`'s "KNOWN LIMIT" header as current | The header was written 2026-07-21 and **superseded 2026-07-30**. The file's own `bracketFrames` already takes `fps` as a parameter; the caller supplies the probed rate. A comment describing a limit is not evidence the limit still holds |

### Fixed 2026-08-11 — Auto-Orient, and the dead-control class

The camera row above understated it. `autoOrient` has exactly **two** readers,
both inside `buildSnapshot`'s drawn-layer loop — and that loop `continue`s past
`group`/`null`/`camera`/`audio` at its top and diverts `light` a few lines
later. So the dropdown was dead on **five kinds**, not one. `null` is the one
that stings: auto-orienting a null with children parented to it is a standard AE
rig, and the control looked available.

Fixed by giving the concept the predicate `threeD.ts` already models — one
`canAutoOrient(node)`, so "a switch never lights up without pixels changing".
Motion Path is deliberately **not** gated on it: smoothing a camera's position
keys is real, only the derived rotation was dead.

`autoOrientKindParity.test.ts` guards it, and it does the thing §0 asks for —
it **derives** the dead set by parsing the skip list out of `buildSnapshot.ts`
rather than restating it, so editing that loop fails the test until the
predicate agrees. Falsified before being trusted: dropping `null` from the set
fails the parity assertion.

This is the **fourth** control of this exact shape in the repo — after the spot
cone that did nothing on a 2D layer, three light params that stopped at the CPU,
and `frameBlend` writing a flag no renderer read. Each was cheap to keep and
cost nothing to run, which is why each survived. The open question is not this
control but the class: nothing yet scans for *the fifth*.

### Built 2026-08-11 — audio effects, and the parity they had to satisfy

AE ships ten audio effects; this app shipped **none** — audio was levels,
automation, waveform, spectrum and mixdown, i.e. playback and analysis with no
processing. Four now exist: **Parametric EQ**, **Bass & Treble**, **High-Low
Pass** and **Delay**.

The design constraint was already written down. `audioParams.ts` says level was
"the first property through this seam; pan, fades and **audio-effect parameters
are the same shape and should reuse `buildParamRamp`** rather than growing a
second scheduling path" — because a mix that sounds right while scrubbing and
renders differently is discoverable only by exporting a file and listening to
all of it.

So there is exactly one builder, `connectAudioEffects`, called by both
`AudioEngine` (live) and `audioMixdown` (offline). It takes a
**`BaseAudioContext`**, not an `AudioContext`, specifically because typing it
the narrower way is how a live-only path gets written by accident: the offline
call would fail to compile and get "fixed" with a second implementation.
`audioEffects.test.ts` reads both call sites and fails if either stops going
through it — falsified by un-wiring the export path, which reddens exactly that
assertion.

Chosen for having an exact Web Audio node and therefore structural parity: the
biquad family is the same object with the same maths in both context types. The
six not built are decisions, not oversights — **Reverb** needs a ConvolverNode
and an impulse response to ship with it, **Flange & Chorus** a modulated delay,
**Backwards** is a buffer transform belonging where decoding happens, **Tone** is
a generator with no input, **Modulator** is ring modulation, and **Stereo Mixer**
interacts with the mixdown's channel handling.

Two details worth keeping: **delay is dry/wet in parallel, summed** — a
DelayNode in series is latency, not an echo — with feedback capped below unity
so an offline render cannot ring forever; and an empty chain returns the input
node untouched, so a project without effects builds the graph it always did.

### Investigated 2026-08-11 — the `clamp01` consolidation, and what actually broke

There are ~17 hand-written `clamp01` copies across `src/core`, and they do not
agree. Most are `v < 0 ? 0 : v > 1 ? 1 : v`, which **returns NaN for NaN** —
both comparisons are false, so the value falls through untouched. Two guard it
explicitly and return 0.

Consolidating them onto the NaN-safe form looked like an obvious cleanup. It
moved **112 render-test scenes and lost fidelity on 49** (from a baseline of 3
regressions and 0 losses). Reverted in full; the gate is back to 3/0.

**RESOLVED the same day. The first explanation here was wrong**: it said NaN
propagation must be load-bearing. It is not.

A second experiment isolated the variable. A variant differing from the original
**only on NaN** (`v !== v ? 0 : …`), applied to all 12 files, left the gate at
its **3/0 baseline**. So NaN was never involved. The two forms differ on a
second input nobody was thinking about:

```
naive:    v < 0 ? 0 : v > 1 ? 1 : v      →  undefined  ⟹  undefined
NaN-safe: v > 0 ? (v > 1 ? 1 : v) : 0    →  undefined  ⟹  0
```

`undefined` satisfies neither comparison, so the naive form **returns it
untouched**. At `vectorDraw.ts` `applyStrokeStyle`, `ctx.globalAlpha *=
clamp01(stroke.opacity)` then assigns `NaN` — and the Canvas2D spec says a
non-finite `globalAlpha` assignment is **ignored**, so the previous value
stands and the stroke draws fully opaque. Map `undefined` to `0` instead and the
alpha really is 0: the stroke disappears. That is the 112 scenes.

So the rendered result of a missing stroke opacity rests on a coincidence of two
unrelated leniencies — a clamp that passes non-numbers through, and a canvas
that discards NaN. Neither is a decision anyone made.
`strokeOpacityGuard.test.ts` pins the mechanism (including the exact
substitution that broke it) so it is not rediscovered by running the GPU suite.

**Both were then done, in that order.** `applyStrokeStyle` now says
`Number.isFinite(stroke.opacity) ? stroke.opacity : 1` — a stroke with no stated
opacity is opaque *because the code says so*, which reproduces the old
accidental result exactly. With that in place, **14 of the 17 `clamp01` copies
collapsed onto one** in `@utils/lang`, and the render gate stayed at **3/0**.

Three copies remain, each for a reason rather than by neglect:

| File | Why it stays |
|---|---|
| `sceneInsert.ts` | Signature is `number \| undefined` — a different contract, not a duplicate |
| `templatePreview.ts` | Local shape; left pending its own check |
| `packages/design-system/src/color.ts` | Different package; `@utils` is an app-level alias it cannot reach |

The lesson worth keeping: the duplication was never the bug. A permissive
expression at **one** call site was, and the seventeen copies only made it
expensive to find. Unifying first and asking later cost 112 scenes; fixing the
call site first made the same change a no-op.

A second lesson, cheaper: the consolidation was done with a regex whose optional
`(?:/\*\*[\s\S]*?\*/\n)?` docblock group matched from the **module** docblock all
the way to the target function, deleting everything between — 579 lines from
`layerStyles.ts`, 42 from `waveform.ts`, and the whole parser from `cubeLut.ts`.
`git checkout` recovered the tracked files; the untracked one had to be
rewritten. Bulk edits across many files want per-file verification, not one
regex and a green typecheck at the end.

### Corrected 2026-08-11 — "No Wiggle Paths" was wrong, twice over

§4 listed Wiggle Paths as a missing shape operator, on the strength of a grep
for `wigglePath` returning zero. It returns zero because the operator is
**stored as `roughen` and labelled "Wiggle Paths"** — `PathOpControls.tsx` says
so in a comment, and `pathOps.ts`'s own module header says "Roughen (AE's
Wiggle Paths)". A complete second operator was written before the label was
noticed: two entries in one menu, both named Wiggle Paths. That is the fifth
absence-grep error in one day, and the first that would have shipped a
**duplicate feature** rather than a wrong sentence.

What was genuinely missing was one parameter. AE's **Roughen** displaces along
the normal with every point independent; AE's **Wiggle Paths** adds
**Correlation** — how alike neighbouring points move — and that is the whole
character of the operator. Without it, the thing carrying the name was the other
effect: uncorrelated noise shreds an outline, correlated noise makes it undulate
like something with stiffness.

Correlation now exists on the operator, keyframeable (unlike `seed`, where
interpolating scrubs through unrelated noise fields), clamped 0..100, and
**defaulting to 0 — byte-identical to the previous output**. AE defaults it to
50; matching that would have re-shaped every Wiggle Paths already in a project.
`wigglePathsCorrelation.test.ts` pins the no-op default separately and first,
and asserts that only ONE operator wears the name.

Remaining honest difference from AE: displacement is still along the **normal**
only. AE's Wiggle Paths moves points in 2D. That is a separate change with a
real visual consequence, so it is recorded rather than smuggled in.

### Built 2026-08-11 — a physical lens model, and why per-pixel DOF is blocked

**Per-pixel DOF cannot be built today, for a reason worth writing down before
someone plans a sprint around it.** A depth-driven post-process needs a
*sampleable* depth buffer, and neither backend has one:

- **WebGL2** attaches depth as a `WebGLRenderbuffer`
  (`renderbufferStorageMultisample`, `DEPTH_COMPONENT24`). A renderbuffer cannot
  be sampled, by construction.
- **WebGPU** creates its depth texture with `usage: TEX.RENDER_ATTACHMENT` and
  no `TEXTURE_BINDING`, so it cannot be bound either.

Fixing that means a depth-texture path on both backends **plus** an MSAA-depth
resolve story (WebGL2 cannot resolve a multisampled depth texture directly), and
the render-test gate runs on the harder backend. It is a project, not a pass.

So the maths was fixed instead, which is the half that was actually wrong.
`dofBlurPx` was `|d − S| / S × aperture` — a normalised-distance ramp, not a
circle of confusion, and **symmetric**: a layer the same distance in front of
the focal plane blurred exactly like one behind it, background blur grew without
bound, and focal length changed nothing at all.

There is now a thin-lens model, `CoC = A·f·|d − S| / (d·(S − f))` with
`A = f/N`, selected by the **presence** of an `fStop` on the camera. Absent ⇒
the legacy ramp, unchanged, so no existing project is re-graded — the same
opt-in shape as `lightFalloffAt`'s `'none'`. It is asymmetric, it saturates
behind the focal plane (a distant and a very distant backdrop finally look
alike), and a long lens is now shallower than a wide one at the same f-number.
Degenerate rigs — focus inside the focal length, zero f-stop, zero depth —
resolve to the Blur Level cap rather than to `NaN`, because a NaN radius does
not throw, it silently blanks the layer.

**No iris, blades, roundness or highlight-gain parameters were added.** The
per-layer blur cannot honour them, so they would have been five more dead
controls. They belong with the per-pixel pass, whenever the depth-buffer work
above is done.

### Built 2026-08-11 — Compound Blur

`compound-blur` (effect **75**) blurs a layer by the LUMINANCE of another layer:
the third member of the read-a-second-layer family after Displace and Set Matte,
built on the same shape — a second texture at binding 3, the same target UV, the
same borrow of `MATTE_TARGET`, the same self-fallback when the map is unset.

**One pass with a scaled kernel, not a separable blur.** A separable Gaussian is
two passes sharing one radius, and the whole point of this effect is a radius
that differs per pixel — there is no pair of 1D passes that produces a spatially
varying kernel. So it samples a 13-tap golden-angle rosette whose SPACING scales
with the local radius: constant cost, and quality that degrades at large radii
into a slightly noisy blur rather than a smooth one. That is what "Max Blur"
being a ceiling rather than a promise means; on high-frequency periodic content
the residual reads as grain.

**It shipped inert for an hour, and the reason is worth keeping.** The type went
into the `EffectType` union and every downstream piece was built — shader,
material, uniform packer, renderer branch, scene — while the entry in
`EFFECT_DEFS` was missed. `tsc` stayed clean and the suite stayed green, because
almost everything downstream keys off the DEFINITION rather than the type:
`GPU_ONLY_EFFECTS` is `EFFECT_DEFS.filter(d => d.gpuOnly)`, so an effect with no
def is not GPU-only, and `extractSpatialEffects` therefore dropped it on every
baked layer. `effectRegistryComplete.test.ts` now checks the registry against
`EFFECT_CATEGORY`, which the compiler already forces to be exhaustive.

### Built 2026-08-11 — Apply Color LUT, and a miscount in the counter

`apply-color-lut` (effect **74**) parses `.cube` 3D and 1D LUTs and samples them
trilinearly — the one colour tool per-channel curves cannot stand in for, since
a 3D LUT can rotate one hue while its neighbour holds still. Filed under Color
Correction rather than AE's Utility folder, because a one-item folder is worse
than a slightly wrong one.

**It samples in whatever space the pixels arrive in, and this renderer is not
linear-light.** A log-space LUT will therefore not match its author's intent
until that work lands. Recorded in `cubeLut.ts` as well, so it is not
rediscovered as a bug.

Adding it exposed a **bug in `featureCounts.cjs` itself**: `unionMembers`
regex-matched `'…'` runs in the union body *without stripping comments*, so the
apostrophe in a comment reading "AE's Apply Color LUT" opened a quote that
closed on the next real member — inventing one member and eating another. One
new effect moved the count by **two**, which is the only reason it was caught;
a comment worded slightly differently would have moved it by zero and
under-reported silently, forever. This is the worst version of the bug the
script exists to prevent: the number that is supposed to be beyond
hand-miscounting, miscounted.

Fixed by stripping comments first, and `unionMembersIn` is now split from its
file wrapper — the same shape as `objectKeysIn` — so `docFeatureCounts.test.ts`
can splice a union and prove that prose does not move the count while a real
member does. Falsified: reverting the strip fails five assertions and returns
the bogus 75.

### Built 2026-08-11 — Essential Properties, and the trap in it

An override has **two halves**, and building either alone ships a dead control:

- **static** — `expandCompInstances` patches the clone's components.
- **animated** — `buildSnapshot`'s `anim` shim drops the overridden prop, so the
  SOURCE node's track stops outvoting that patch on every frame.

With only the first, an override works on a static layer and silently does
nothing the moment anyone keyframes it. Three further traps, each caught by a
failing test rather than by reading:

1. **`materializeForFrame` is a whitelist.** `__overriddenProps` was dropped in
   transit until it was named there, exactly as `__instanceSource` must be.
2. **A sealed instance never expands.** Collapsed instances expand inline and
   get patched clones; a sealed one — the default — is rendered by a recursive
   pass over the referenced comp's REAL nodes, where no clone exists. It needed
   `comp.compOverrides` handed down, replacing rather than inheriting through
   `...comp` so an outer instance cannot leak into a nested one.
3. **The prop is not always on the Transform.** `readBase` is last-write-wins
   and `opacity` lives on **Style**, so patching Transform lost every time.
   Overrides now target the last component that already declares the prop.

Falsified before being trusted: disabling the shim fails exactly the two
animated assertions and nothing else.

Also fixed: `videoFrameCache.ts`'s "KNOWN LIMIT — we do not know the source's
frame rate" header, resolved twelve days earlier and still asserted in the
present tense. It is corrected in place rather than deleted, and says why it was
kept — a stale comment is prose, and §0's warning applies to it too.

What survived the recheck, verified rather than assumed: decode really is
`HTMLVideoElement` + seek and deliberately not WebCodecs (`document
.createElement('video')` in both `videoFrameCache.ts` and `AppTextureProvider
.ts`); `normalMap`'s single hit is a **plugin test fixture**
(`depthPluginRebuild.test.ts`), not a renderer feature; `outputModule` has no
hits in `.ts`/`.tsx` at all; and `aces` at 255 hits was pure substring noise —
"surfaces", "traces", "interfaces" — with no ACES anywhere.

---

### Fixed 2026-08-12 — Compound Blur drew nothing on the primary backend

250 scenes rendered on WebGPU and **not one pixel of it was gated**. The parity
dashboard printed a number, labelled "measured, NOT gated", and never failed.

What the number was hiding: `effect-compound-blur` sat at **87.8%** divergence
against a reference blessed from the GPU, because its WGSL failed to compile.
`textureSample` computes implicit derivatives, which WGSL permits only in
uniform control flow, and the shader's `radius < 0.34` early return makes the
sampling loop non-uniform. So the pipeline was invalid and the effect drew
**nothing** on the product's primary backend, while rendering correctly on
WebGL2, whose GLSL twin has no such rule. The harness printed
`ERROR: 'textureSample' must only be called from uniform control flow` on every
run, next to a divergence figure that nothing acted on.

`textureSampleLevel(..., 0.0)` fixes it. Not a compromise: every source here is
a non-mipmapped render target, so LOD 0 is the level implicit sampling would
have chosen, and the WebGL2 path is untouched. Divergence 87.8% → **53.3%** —
it now draws, and what remains is a real WebGPU-vs-WebGL2 disagreement in the
same scene that has **not** been diagnosed. Recorded as a debt, not explained.

The gate is a **ratchet**, deliberately, rather than a threshold. Byte equality
between two hardware rasterizers is not a reasonable demand — the extrusion
scenes measure 0.16–0.27% between backends, all of it edge antialiasing — so
`webgpu-baseline.json` records a ceiling per divergent frame and the gate fails
when a frame exceeds its ceiling, or when an unlisted frame exceeds 1%. 26
entries today.

That baseline is **a list of debts, not of blessings**: every entry is a
disagreement nobody has diagnosed. It is deliberately not the `divergence`
mechanism used for known Canvas2D gaps, which requires a stated mechanism per
scene — demanding 42 diagnoses before any gate could exist is how the suite
ended up with no gate at all. The run names frames that have improved enough to
tighten, and `--update-backend-baseline` is a separate flag from `--update` so
that re-blessing a reference cannot silently forgive a backend regression.

Also: a missing WebGPU adapter is now a **hard failure in CI**. It was a skip,
with the reasoning that hosted runners have no adapter. True, and beside the
point — a runner that renders no WebGPU turns every WebGPU gate (alpha
semantics, 3D styles, plugin effects, extrusion reach, and now this ratchet)
into a no-op that reports success. `HARNESS_REQUIRE_WEBGPU=0` waives it
explicitly for anyone who accepts the hole.

### Corrected 2026-08-12 — the same count drifted into the same files, twice

`EffectType` reached **145** while four places went on asserting **73**: §4's
"Effect breadth", `README.md`, `ROADMAP.md`, and — a fifth nobody had named —
the §2 architecture diagram, which put the Zustand store count at 39 against a
real 40.

(That sentence is phrased around the number rather than before it because the
new guard flagged the first draft of this very paragraph. Which is the intended
behaviour: a superseded count written as "N *registry*" in live prose is caught
wherever it appears, including inside the entry announcing the guard.)

A row below records this happening ALREADY, at 58 → 73, together with the
diagnosis: "the count guard existed but was scoped to this file's marked table,
so the number was corrected here and left wrong in the two most-read files in
the repo". The scope was never widened. One registry growth later the identical
drift reappeared in the identical two files, and from there into every brief
written against this document.

So the guard is now repo-wide: `docPropagatedCounts.test.ts` checks
`EDITOR_REFERENCE.md`, `README.md` and `ROADMAP.md` for any claim of the form
"N *registry*" and fails when N is not that registry's size.

The rule is deliberately narrow — a digit immediately followed by a registry's
name. The obvious alternative, flagging any number in a paragraph that mentions
a registry, was measured against these three documents and produced 39 hits,
almost all noise: dates, millisecond measurements, effect indices, `3D`. A guard
needing a 39-entry allow-list is one that gets silenced the first time it fires.
The cost of the narrowness is that an oblique phrasing still escapes, and §4's
did — "Effect breadth: 73 vs AE's 400+" puts no noun after the number. That was
rewritten into the checkable form rather than the regex being widened to chase
it. Prose stating a count should say "145 effects".

Ledger table ROWS in this section are exempt, structurally rather than by a list
of phrases: quoting a superseded number is what a corrections ledger is for, and
a per-phrase list would mean every new entry here also had to edit a test. Prose
in §5 — including every "Fixed …" narrative — is still checked.

Corrected in the same pass, because the paragraph was being rewritten anyway:
§4 listed "no volumetric light rays (Shine)" and "no optical-flare system worth
the name" among the missing *classes*. `light-rays`, `lens-flare`, `light-sweep`
and `beam` all ship, each with a registry def, a Canvas2D implementation and a
Generate entry in the effects browser. They are CPU passes rather than shaders —
a performance fact, not an absence.

---

### Fixed 2026-08-12 — an extrusion's faces carried no effects at all

`buildSnapshot` synthesized every extra face of an extruded layer with
`effects: undefined`. Thirteen of fourteen renderables therefore dropped the
layer's entire effect stack, and two separate user-visible symptoms came out of
that one line:

| Symptom | Measured at `938dc23` | After |
|---|---|---|
| An effect applies to the **front face only** | `invert` changed **58.6%** of the solid's pixels — its front face, and nothing else | **100.0%** (WebGPU) / 99.9% (WebGL2) |
| **DOF does nothing** on extruded objects | **0.0%** of wall pixels beyond a front-face blur's reach changed when DOF was switched on — the walls were byte-identical | **50.4%** changed; the wall's own outer edge spreads **11×** wider than sharp |

The scrub's stated reason was legitimate and is preserved: shadow-casting
effects would stack N times inside the body, and CPU-baked ones cost a full
rasterization per face. Those are now denied **by name** rather than by taking
the whole list — see `faceEffects.ts`, which also records why the exterior set
is exactly the one `FACE_SURFACE_IDS` already chose for layer styles, and why
layer styles are excluded from the filter entirely (the overlays reach faces
through `styledSurfaceFill` and would otherwise apply twice).

Spatial effects are bounded rather than banned. Measured on this machine, the
marginal cost of one more effect-laden face is **~368 ms on WebGL2** against
**~2 ms on WebGPU** — a ~180× gap, both linear in face count. The budget is a
single backend-agnostic constant (16 faces) because a face list that varied by
backend would be a path that runs in one engine and not the other; it admits the
box (5 faces) and the bevelled box (13) and excludes the populations that are
large by construction — text slices (45), gradient wall strips (81), curved
outlines (21+).

Held by `ext-fx-invert` / `ext-dof-wall` and their controls, gated through
`verify-extrusion.mjs`. Deliberately **not** held by a golden alone: the front
face is most of what a solid shows, so a reference blessed while the bug was
live would have certified front-face-only forever, and every symptom of it
passes a presence check.

Known and accepted: each face is its own quad and its own effect resolve, so a
blur does not bleed **across** a seam. Measured, not assumed — the blurred body
steps at most **7.5 levels** between adjacent rows where the sharp control steps
**74.7**, so the join is a soft ridge and not a discontinuity. Removing it needs
the faces resolved into one offscreen, which is a renderer change.

### Fixed 2026-08-12 — every box was wound as if it had no far side

`extrusion.ts` gave the left wall the same `Ry(90°)` as the right, and the
bottom the same `Rx(90°)` as the top. A quad's normal is its own +Z axis, so
each pair carried an **identical** normal, and since the two walls of a pair sit
on opposite sides of the body, one of every pair pointed **into** the solid.
Verified before the fix: `r` at x = +50 and `l` at x = −50 both reported normal
`(1, 0, 0)`; `t` at y = −30 and `b` at y = +30 both reported `(0, −1, 0)`.

Two things kept it invisible for as long as it existed:

- **Lighting is two-sided.** `lightShading.ts` and all twelve `abs(dot(…))`
  sites in `builtin.ts` cannot tell a normal from its negation, so the wrong
  sign produced the same gain as the right one. A box lit hard from one side
  came out lit identically on both — which is what "it doesn't read as a solid"
  actually was.
- **Every assertion was about corners.** Mirroring a quad within its own plane
  moves no corner, so all 70 extrusion tests passed before the fix and all 70
  passed after it. Confirmed by reintroducing the bug: the six new winding
  assertions fail, and *"left wall: d×h plane on the x = −w/2 plane"* still
  passes.

The chamfer rings were always correct, and they are where the intended pattern
was written: `cfr` Ry(135°) against `cfl` Ry(225°) — the far member of a pair is
the near one plus 180°. The walls now follow the rings.

Pixel movement: **none**, and necessarily so. `abs()` makes the sign
unobservable, so this changes no frame today; the render gate stayed green with
no reference touched. It is what makes one-sided shading expressible at all.

**Decision on `abs()`, recorded rather than deferred silently.** The choice is
to **branch**, not to remove it globally. Removing it globally is not merely
disruptive, it is wrong: `planeNormalOf` returns the plane's +Z, and +Z is
*away from the viewer* (`project3d.ts`), so a front-facing layer under a front
light has `dot(N, L) < 0`. Clamping instead of taking the absolute value would
render every front-lit 3D layer **black**. Two-sided is also genuinely right for
the app's primitive — a 2D layer in space has no inside, and a layer seen from
behind should still light.

So one-sidedness applies to exactly the faces that bound a volume: the
synthesized **walls and back cap** of a geometric extrusion. Explicitly not the
front face (it is the layer itself, and its outward direction is −Z, the
opposite of the convention) and not the depth **slices** of a text extrusion
(their normals are all +Z, so one-sided shading would black them out under a
front light).

Not yet implemented. Sized: the flag slot already exists — `eyeLit.w` is the
lit flag, `0`/`1` today, and a third value costs no uniform-layout change — so
the work is `packShade3D`, the `Shade3D`/`FrameScene` types, the twelve
`abs(dot(…))` sites across the four 3D shade blocks in both WGSL and GLSL, the
CPU twin in `lightShading.ts`, and an extension to `lightShaderParity.test.ts`.
It will move every lit-3D golden, so it belongs in its own change.

### Fixed 2026-08-12 — a rounded card's front face floated inside its own outline

`buildSnapshot` computed its front-face inset as `clampBevel(w, h, d, request)`
for **any** rect and shrank the emitted front face by it. But the rounded branch
of `extrusionFaces` returns before the bevel path and emits no chamfer ring — so
a rounded card with `bevelDepth: 12` drew a front face 24 px narrower than its
own outline, meeting a ring that did not exist, and the darker back cap showed
through the ring-shaped gap all the way around.

The root cause was a **contract**, not arithmetic. `extrusion.ts` recorded the
deliberate choice to ignore a bevel on a rounded outline — a bevel on a rounded
corner is a torus section, which a flat-quad wall model cannot express, so the
rounded body is emitted un-bevelled rather than silently square-cornered — and
never told the caller.

So the geometry now REPORTS what it emitted: `extrusionGeometry` returns
`{ faces, bevel }` and `extrusionFaces` is a thin reader over it. The bevel and
the faces come from the same decision and cannot drift. Explicitly not fixed by
giving `buildSnapshot` a "is this shape rounded?" predicate — that is the same
coupling again, with a second copy of the branch logic to keep in step.

### Fixed 2026-08-12 — deep extruded text combed instead of extruding

Text and complex shapes extrude as a stack of thin plates. The slice count was
capped at 45 with a 1.5 px step, and the **shape of that bug is not what the
code suggests**: the stack always spanned the full depth, because `sliceStep` is
`extrusionDepth / sliceCount`. Nothing was truncated. What saturated was
DENSITY — past 45 × 1.5 = 67.5 px the same 45 plates simply moved apart:

    depth  40   → 27 slices, 1.48 px apart
    depth  67.5 → 45 slices, 1.50 px      ← the ceiling binds
    depth 300   → 45 slices, 6.67 px      ← 4.3 px gaps at 40° yaw

Worth stating plainly because a brief written against this described the fix as
"scale `stepPx` with depth so 45 slices always span the full extrusion" — which
is what the code already did. The real choice was raise-the-cap versus building
wall geometry from the glyph outline.

Why the cap was 45: **nothing records one.** It entered as a bare literal in a
bulk `feat:updated` commit. Measured now — a slice is a flat quad in the shared
depth pass with no offscreen resolve, and all slices of a layer share a
`contentHash` and therefore one rasterized texture, so slices are far cheaper
than the effect-laden faces `faceEffects.ts` has to budget:

    slices    WebGL2    WebGPU
       45      471 ms    102 ms
      400      934 ms    154 ms

~1.3 ms per extra slice on WebGL2, ~0.15 ms on WebGPU. The cap is now 400,
holding the intended 1.5 px spacing to **600 px of depth**. Measured on the
trailing-edge roughness of `ext-text-depth-300`: **1.193 px → 0.700 px**,
against 0.835 px for the depth-40 control — the deep body is now smoother than
the shallow one.

Still an approximation of a solid by a stack of plates. The real fix is wall
geometry from the glyph outline, as the rect path already does; this bounds the
visible defect and the numbers above are what such a proposal should be measured
against.

### Fixed 2026-08-12 — an extruded solid could split across two render paths

`depthEligible3D` is asked per RENDERABLE, but an extrusion is one OBJECT spread
across up to fourteen of them. `glass` and `backdropBlur` are excluded from the
depth group — correctly, they read what is composited beneath — and reached the
front face and the back cap but **not** the four walls, because those two were
built by spreading `...layer` while the walls were constructed field-by-field.
`CompositionPass.renderList` collects contiguous runs of eligible renderables,
so the body went to the depth-tested group and the caps to the affine painter
path, which has no depth state at all. The glass panel detached from the solid.

Fixed in two halves, because it is two problems:

- **The construction asymmetry.** The backdrop-sampling fields are scrubbed from
  every synthesized face, on both the geometric and the slice paths. Glass was
  the observed case and was never the only candidate — ANY `RenderLayer` field
  outside the walls' explicit list reached the back cap alone.
- **The object-level disagreement.** Scrubbing is only half an answer, because
  the front face IS the layer and legitimately keeps its glass. So
  `enforceExtrusionPathAgreement` (snapshot adapter) keeps every face of one
  object on whichever path the object as a whole takes, by asking the REAL
  `depthEligible3D` rather than restating its rules — a future exclusion added
  to that predicate is honoured automatically, which is the property the glass
  case did not have. It only ever moves an object OUT of the depth group: glass
  genuinely cannot be depth-tested, so the fix is to stop the body splitting,
  not to pretend the exclusion was wrong.

Guarded by `extrusionDepthGroupParity.test.ts` — eleven assertions in the
`lightShaderParity.test.ts` idiom, including that the resolution moves toward
the painter path and that one glass extrusion does not exempt an unrelated one
beside it. Three of them failed before the fix. It also recurses into sealed
precomps, where a body coming apart is exactly where nobody would look.

---

## 6. Where to look

| Concern | Path |
|---|---|
| Effects registry, time-dependent set | `src/core/effects/effects.ts` |
| Blend modes → shader selector | `src/core/effects/blendMode.ts` |
| Per-frame resolution, DOF, shading, content hash | `src/core/rendering/buildSnapshot.ts` |
| Render passes | `packages/renderer/src/rendergraph/passes/` |
| Backend selection | `src/core/rendering/createRenderBackend.ts` |
| Shape operator chain | `src/core/scene/pathOps.ts` |
| Expressions language | `packages/animation/src/expressions.ts` |
| Rig (IK/FABRIK/ARAP) | `src/core/rig/` |
| Particles | `src/core/particles/particleSim.ts` |
| Export, offline render loop | `src/core/export/` |
| Canvas tools | `packages/workspace/src/tools/builtin.ts` |
| AI tool registry | `packages/ai-tools/src/` |
| Plugins | `docs/PLUGINS.md` + `src/core/plugins/` |

**The commit bodies are this repo's delta ledger. When a `.md` and the code
disagree, the code wins — and then the `.md` gets fixed.**

### Other docs

`PLUGINS.md` (reasoning), `PLUGIN_SYSTEM_REFERENCE.md` (current state) and
`PLUGIN_SYSTEM_FOR_AI.md` (condensed agent map) are a deliberate three-tier split
of the actively-developed plugin system and are current. `3d-layer-model.md`,
`AI_ARCHITECTURE_FULL.md`, `ANIMATED_SVG_PIPELINE.md` and
`BONE_AND_PUPPET_RIGGING.md` are subsystem deep-dives. `COMPOSITING_PLAN.md` is
a **historical delivery ledger**, retained only because four source files cite
its F-numbers — it is not a statement of current state.
