# Premation — Editor Reference

**Counts derived from source at `7e59fd0`; prose last verified 2026-08-10.**
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
| Effects | 73 | `src/core/effects/effects.ts` → `EffectType` |
| Blend modes | 36 | `src/core/effects/blendMode.ts` → `LayerBlendMode` |
| Layer styles | 10 | `layerStyles.ts` → `LAYER_STYLE_LABEL` + `BACKDROP_STYLES` |
| Path operators | 8 | `src/core/scene/pathOps.ts` → `PathOpType` (less `none`) |
| Mask modes | 7 | `src/core/effects/mask.ts` → `MaskMode` |
| Light types | 4 | `src/core/scene/light.ts` → `LightType` |
| Canvas tools | 20 | `packages/workspace/src/tools/builtin.ts` |
| AI tools | 61 | `packages/ai-tools/src/tools/{read,write,craft,compose}.ts` |
| Export formats | 9 | `videoSink.ts` → `VideoFormat` + `exportManager.ts` → `ExportFormat` |
| Stores | 39 | `src/stores/*.ts` |
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
                          ├── src/stores/*        39 Zustand stores
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

**No bounce/overshoot easing preset**, though. There is no named easing-preset
registry at all: easing is bezier handles plus the Easy Ease assistants in
`keyframeAssistants.ts`. `BOUNCE_EASE` in `animationPresets.ts` is a single
cubic-bezier (`0.175, 0.885, 0.32, 1.275`) used by one preset and commented
"Elastic bounce" — a cubic-bezier has one overshoot and cannot express a decaying
bounce. A real one belongs beside `easyEaseAll` as a **keyframe assistant** that
generates decaying keys — preset authoring, not engine work, as suspected.

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

**Depth of field is per-layer, not per-pixel.** `buildSnapshot.ts:984`
(`dofEffectOf`) computes one blur value from a layer's depth and pushes it as an
ordinary `blur` effect. A layer that spans depth — a ground plane, a long
extruded title — gets a single uniform blur across its whole surface. There is no
DOF code in `packages/renderer` at all. This is the difference between "3D-ish"
and cinematic.

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

**Particles are structurally limited by the determinism choice.** 253 lines:
3 emitter types, 4 shapes (circle/square/line/star), gravity, spin, and
size/colour/opacity ramps. There is **no turbulence or wind field, no collisions,
no sub-emitters, no trails, no layer-as-particle, and no 3D particles.** Exact
scrubbing is a genuinely valuable property, but closed-form position is precisely
what forbids the interacting, stateful behaviour that Trapcode Particular, Form
and Plexus are bought for. Lifting this ceiling means giving up the closed form.

**No imported 3D models, PBR or HDRI.** "3D" here means 2D layers with extrusion
placed in a 3D space — not a rendered 3D scene. Out of scope by direction.

### Tier 2 — ceilings on visual density

**Effect breadth: 73 vs AE's 400+.** The raw count misleads in both directions —
nobody uses 400, and the 73 present are properly parameterised (Levels, Curves,
Channel Mixer, Keylight with despill/choke/softness). What matters is the missing
*classes*, not the delta: no volumetric light rays (Shine), no optical-flare
system worth the name (`lens-flare` is basic), no 3D Stroke, no Form/Plexus, no
Element 3D. The dense, expensive-looking AE frame is usually five to eight
stacked third-party effects, and that stack has no equivalent here.

**Uniform mask feather only.** `MaskPoint` carries x/y plus handles and one
scalar feather per path. AE's variable-width feather — the tool for organic
matte blending — has nowhere to store its per-point width.

**No Wiggle Transform shape operator.** The `wiggle()` *expression* is complete;
the shape operator is a different feature and is absent.

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

1. **Particle system** — the largest single unlock, and it requires accepting a
   stateful simulation with a seeded-replay contract in place of the closed form.
2. **Per-pixel depth of field** — a real renderer pass, not a per-layer blur.
   Fixes the "3D looks flat" complaint at its root, alongside per-pixel lighting.
3. **A focused effect pass on the light/glow/flare family** — the cheapest route
   to frames that read as expensive.

Motion tracking is a much larger project serving a different audience and should
not be sequenced against these.

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
| `SelectionPass` draws the selection chrome | It does **not**. `snapshotToFrameScene` sets `selection: []` unconditionally, so the pass never draws in preview or export; the real outline and handles are 2D-canvas overlay chrome in `useWorkspace.ts` (~1734), on a fixed `ACCENT` |
| The boot CSP error was cosmetic | It broke a feature: `media="print"` never flipped to `all`, so **no user-selectable document font ever loaded**. The UI looked right because its own faces come from a different `@import` |

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
