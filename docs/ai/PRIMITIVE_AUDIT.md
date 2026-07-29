# Phase 0 — Primitive Audit

**Date:** 2026-07-28
**Registry size at audit:** 45 tools (7 `read`, 25 `write`, 13 `compose`)
**Verdict:** the expressiveness ceiling is **not** in the engine. It is in the
**tool surface** and in the **absence of an authored library**.

---

## Executive summary — read this before planning Phase 1

The re-architecture spec assumed three things that are false here:

1. **"`set_easing` may be preset-only — if so it is the highest-priority fix in
   the entire project."** It is not preset-only. It accepts four bezier control
   floats, per keyframe, per property, and the sampler produces **true value
   overshoot** (`interpolate.ts:100` multiplies the value delta by an eased
   parameter that `cubicBezierEase` deliberately does not clamp). The single
   highest-priority fix does not exist. Phase 1.1 is nearly a no-op.

2. **"`set_keyframes` may not write 3+ keyframes with per-segment easing."** It
   writes up to 200, each with its own `easing` + `bezier`, across multiple
   nodes and properties in one call.

3. **"Track mattes / blend modes / adjustment layers / 3D / lights / DOF /
   gradients / displacement / curves are missing entirely."** All are present.
   Mattes and blend modes ship on `update_layer`; adjustment and light are
   `create_layer` kinds; the camera has keyframable `focusDistance` /
   `dofAperture`; `gradient-ramp`, `fractal-noise`, `displacement-map` and
   `curves` are registered effects.

**What is actually missing** falls into two buckets, and the distinction matters
because they cost very different amounts:

| Bucket | Meaning | Cost |
|---|---|---|
| **UNEXPOSED** | The engine does it. No tool reaches it. | Hours — write a schema + handler over an existing call. |
| **ABSENT** | Nothing in the engine does it. | Days-to-weeks — real implementation. |

Nine of the spec's "missing entirely" items are **UNEXPOSED**, not ABSENT. The
one genuinely expensive gap is audio analysis (Tier D), and the one genuinely
load-bearing gap for product motion is the spring solver.

**Revised conclusion:** Phase 1 is ~4 days of schema-and-handler work plus one
real primitive (`set_spring`), not 2–3 weeks. The bottleneck is Phases 2 / 2B /
2C — the authored libraries — exactly as the spec's own thesis predicts.

---

## A. `set_easing` — **PRESENT**

Definition `packages/ai-tools/src/tools/write.ts:223`, handler
`src/core/ai/toolHandlers.ts:446`.

| Question | Answer | Evidence |
|---|---|---|
| Four bezier control floats, or a preset enum? | **Both.** `bezier: [x1,y1,x2,y2]` alongside a 10-member `easing` enum. | `write.ts:247`, `write.ts:17-28` |
| Per-property easing on one layer? | **Yes.** The target key is `(nodeId, prop, t)` — position and scale are independent tracks. | `write.ts:241`, `AnimationEngine.ts:278` |
| Can a value overshoot (`y > 1`)? | **Yes, genuinely.** `cubicBezierEase` clamps the *parameter* `s`, never the returned `y` (`interpolate.ts:28`), and `sampleTrack` applies it as `a.value + (b.value - a.value) * eased` (`interpolate.ts:100`). `y2 = 1.56` overshoots the target value by 56% of the delta. | `interpolate.ts:13-29`, `interpolate.ts:100` |

Notes:

- `setBezier` **auto-promotes** `easing` to `'bezier'` (`AnimationEngine.ts:281`),
  so a bezier can never be silently ignored because the kind was left at linear.
- `setBezier` no-ops when no keyframe exists at exactly `t`
  (`AnimationEngine.ts:279-280`). The handler pre-checks and reports the times
  that *do* exist (`toolHandlers.ts:455-457`) — a good model-facing failure.
- **Real gap:** there is no *segment* addressing. Easing is attached to the
  keyframe that starts a segment, which is AE's model and is fine, but the
  spec's `segments: [{fromKf, toKf, bezier}]` shape does not exist and does not
  need to.

**Action: none.** Phase 1.1's `set_easing` rewrite is unnecessary and would be a
regression in expressiveness (it drops `roving` and the preset enum).

---

## B. `set_keyframes` — **PRESENT**

Definition `write.ts:151`, handler `toolHandlers.ts:374`.

| Question | Answer | Evidence |
|---|---|---|
| 3+ keyframes in one call with distinct per-segment easing? | **Yes.** `minItems: 1, maxItems: 200`; every item carries its own `easing` + `bezier`. | `write.ts:164-189` |
| Frames or ms? Sub-frame possible? | **Composition seconds**, as a float. Sub-frame is possible arithmetically; the *renderer* samples at frame boundaries, so sub-frame timing shifts the interpolated value at the sampled frame rather than producing a sub-frame event. | `write.ts:175`, `toolHandlers.ts:400` |
| Two properties offset by an arbitrary delta in one round-trip? | **Yes.** Each array item names its own `nodeId` and `prop`, so one call authors a whole multi-layer, multi-property, offset gesture. | `write.ts:171-173` |

Notes:

- Times are comp seconds; the handler converts to layer time through
  `ctx.time.toLayerTime` on the same line that writes the value
  (`toolHandlers.ts:400-403`), which is what stops a value and its easing
  landing at two different times.
- The handler already warns when a property ends up with a single keyframe
  (`toolHandlers.ts:409-413`) — a constant masquerading as an animation.

**Action:** none required. The spec's `offsetMs` sugar is redundant (the caller
computes `t` anyway) and would add a second, competing time axis. Skipped
deliberately.

---

## C. `text_animator` — **PARTIAL**

Definition `write.ts:330`, handler `toolHandlers.ts` (animator section),
capabilities readback `toolHandlers.ts:207`.

| Question | Answer | Evidence |
|---|---|---|
| Range selectors (start / end / offset, units)? | **Yes**, percentages. | `write.ts:347-349` |
| Per-character / word / line granularity? | **Yes** — `basedOn: characters \| words \| lines`. | `write.ts:345` |
| Can the selector be animated? | **Yes**, by keyframing `ta.<index>.offset`. Costs a second call (`text_animator` then `set_keyframes`); the spec's inline `selectorKeyframes` would make it one. | `write.ts:337`, `toolContext.ts:82` |
| Advanced selector shapes? | **Shapes yes** (`square, rampUp, rampDown, triangle, round, smooth`). **`randomSeed` / randomize order: ABSENT.** | `write.ts:346` |
| Animatable properties | `x, y, scale, rotation, opacity, tracking`. **`blur` and `skew`: ABSENT.** | `write.ts:350-355` |

**Action (small):** add `randomSeed`, `blur`, `skew`, and inline
`selectorKeyframes`. This is the only one of the three where Phase 1.1 has real
work, and it is a half-day.

---

## D. The "missing entirely" list — mostly UNEXPOSED, not ABSENT

| # | Item | Status | Where it lives / what's missing |
|---|---|---|---|
| 1 | Track / alpha mattes | **PRESENT** | `update_layer.matte { mode: alpha\|luma\|alpha-inv\|luma-inv, sourceId }` — `write.ts:134-144` |
| 2 | Blend modes | **PRESENT** | `update_layer.blendMode`, 17 modes — `write.ts:125-133` |
| 3 | Adjustment layers | **PRESENT** | `create_layer kind: 'adjustment'` → real `insertAdjustmentLayer` — `write.ts:52`, `toolContext.ts:197` |
| 4 | Precomps as nestable units | **UNEXPOSED** | `precomposeSelected()` at `src/core/scene/sceneInsert.ts:1021`; `PrecompControl.tsx` drives it in the UI. **No AI tool.** `add_scene` is a time-window helper, not nesting — spec is right about that. |
| 5 | Time remapping | **UNEXPOSED (partial)** | `timeRemap` / `precompTime` are animatable (`toolContext.ts:63`) and the renderer samples them (`buildSnapshot.ts:393-400, 525, 1183-1197`). Reachable *today* via `set_keyframes` on `'timeRemap'`, but nothing tells the model that, and there is no tool to *enable* remap on a group. |
| 6 | Motion blur (shutter + samples) | **UNEXPOSED (partial)** | Per-layer opt-in is `update_layer.motionBlur` (`write.ts:124`). Shutter angle / phase / samples / adaptive limit are **composition-level** and live in `src/stores/motionBlurStore.ts` — real, defaulted to 180° / 8 samples, persisted, and **invisible to the AI**. |
| 7 | 3D layer flag, z-position | **PRESENT** | `update_layer.threeD` (`write.ts:123`); `z, rotationX, rotationY` animatable via `THREE_D_PROPS` (`toolContext.ts:108`) |
| 8 | Lights | **PRESENT** | `create_layer kind: 'light'` → `insertLight` (`toolContext.ts:196`). **Light params (colour, intensity, cone, shadows) are not settable by any tool** — only position. So: layer PRESENT, control UNEXPOSED. |
| 9 | Depth of field | **PRESENT** | Camera props `dofStrength, focusDistance, dofAperture`, all keyframable — `toolContext.ts:69-79`. Rack focus is authorable **today**. |
| 10 | Gradients / ramps | **PRESENT (as effects)** | `gradient-ramp`, `four-color-gradient` — `write.ts:299-306`. No OKLCH interpolation and no mesh gradient. |
| 11 | Displacement, turbulence, fractal noise | **PRESENT** | `displacement-map`, `fractal-noise`, `noise` — `write.ts:299-306` |
| 12 | Colour grading — curves | **PRESENT** | `curves`, `levels`, `channel-mixer`, `hue-saturation`, `tint` — `write.ts:299-306` |
| 12b | Colour grading — LUT | **ABSENT** | No LUT load/apply anywhere in `src/core/effects`. |
| 13 | Null objects + expression-linked rigs | **PRESENT** | `create_layer kind: 'null'`; `reparent_layer`; `set_expression` exposes `layer(name, prop)`, `thisComp`, `ctrl(name)` — `write.ts:256-275` |
| 14 | Audio track | **UNEXPOSED** | `src/core/audio/` has `AudioEngine`, `audioLevels`, `audioKeyframes`, `audioWaveformGen`, `audioMixdown`. Audio is placeable via `create_media`, and `audio` is an expression binding — but **no analysis tool.** |
| 14b | BPM / beat grid / onsets | **ABSENT** | No `bpm`, `onset`, or `beatGrid` anywhere in `src/core`. Genuinely new work. |
| 15 | Spring physics | **ABSENT** | Nothing solves a spring. `EASING_ENUM` is bezier-family only. **This is the real Phase 1 primitive** and the spec is right to move it to step 4. |
| 16 | Layered shadow stacks | **ABSENT** | `drop-shadow` is a single-layer effect. A three-layer elevation stack needs three effect instances with no tool to author them as a unit. |
| 17 | Backdrop blur / glass | **ABSENT** | `blur` blurs the layer, not what is behind it. |
| 18 | Corner smoothing (squircle) | **ABSENT** | No continuous-curvature radius. |
| 19 | Grain as a composition treatment | **PARTIAL** | `noise` effect exists per-layer; nothing applies a frame-wide grain pass. Composable today via an adjustment layer + `noise` — but no tool does it. |
| 20 | SVG / vector import | **UNEXPOSED** | The hybrid SVG importer exists (`docs/ANIMATED_SVG_PIPELINE.md`) but is user-driven. `create_media` places only already-imported assets. |
| 21 | Generative imagery (`fal`) | **ABSENT** | `fal` is in the endpoint allowlist with **no tool consuming it**. Confirmed aspirational. |
| 22 | GLTF / 3D scene (`tripo`, `meshy`) | **ABSENT** | Same — allowlisted endpoints, no `scene3d` layer kind to place a mesh in. |
| 23 | Grid / baseline binding | **ABSENT** | Every layer is free-positioned in comp px. |
| 24 | Optical alignment (cap-height centring) | **ABSENT** | — |

---

## Classification table

| PRESENT (14) | UNEXPOSED (7) | ABSENT (11) |
|---|---|---|
| `set_easing` bezier + overshoot | precomp / nesting | spring solver |
| `set_keyframes` N-key, per-segment | time-remap enable | BPM / beat grid / onsets |
| text range selectors + shapes | motion-blur shutter/samples | LUT grading |
| track mattes | light parameters | layered shadow stacks |
| blend modes (17) | audio analysis | backdrop blur / glass |
| adjustment layers | SVG import | corner smoothing (squircle) |
| 3D flag, z, rotX/rotY | composition grain pass | grid / baseline binding |
| lights (as layers) | | optical alignment |
| camera DOF + focus pull | | generative imagery (`fal`) |
| gradients, noise, displacement | | GLTF / 3D scene |
| curves / levels / channel mixer | | mesh gradients, OKLCH interpolation |
| nulls + expression rigs | | |
| masks (rect / ellipse, feather) | | |
| path ops, repeater, trim path | | |

---

## Exit criteria — met

Every checklist item above has a yes/no and a `file:line`, and every item is
classified PRESENT / PARTIAL(→UNEXPOSED) / ABSENT.

## What this changes about the plan

1. **Phase 1.1 shrinks to `text_animator` only.** `set_easing` and
   `set_keyframes` need no change; rewriting them to the spec's proposed
   signatures would lose `roving`, the preset enum, and multi-node batching.
2. **Tier A shrinks to exposure work.** `set_track_matte`, `set_blend_mode`,
   `create_adjustment_layer` and `create_null` are already reachable — they get
   *ergonomic* aliases at best. The real Tier A work is `create_precomp`,
   `set_time_remap`, and `set_motion_blur` (shutter/samples).
3. **`set_spring` is the one genuinely new motion primitive**, and it is
   load-bearing for all of Phase 2C. Bake-to-keyframes is the correct shape
   because it preserves the deterministic-render invariant — the exporter never
   learns springs exist.
4. **Tier C (design primitives) is where the real ABSENT list clusters**:
   shadow stacks, backdrop blur, squircles, grid binding, optical alignment,
   OKLCH. That is Phase 2B's prerequisite set, which is why the spec's ordering
   (design before motion) is correct.
5. **The compose-ratio metric is measuring the wrong thing**, and the audit
   confirms why: with 13 generic recipes, a high `compose` ratio means every
   output came from the same 13 shapes.

---

## Addendum — what shipped (2026-07-28)

Recorded here rather than in a separate file, because the audit's numbers are the
baseline every later count is measured against.

### Registry

| | Before | After |
|---|---:|---:|
| `read` | 7 | 7 |
| `write` | 25 | 34 |
| `compose` | 13 | 13 |
| **Total** | **45** | **54** |

Nine new `write` tools: `set_spring`, `set_motion_blur`, `create_precomp`,
`set_time_remap`, `update_effect_param`, `set_light`, `set_shadow_stack`,
`add_surface_treatment`, `create_gradient`.

Not 75–85. The audit's central finding was that most of the spec's "missing"
list was already in the engine and merely **unreachable**, so much of Tier A
turned out to be schema fields on existing tools rather than new tools:
`cornerRadius`, `backdropBlur`, `fontFamily`, `letterSpacing`, `lineHeight` and
`align` went onto `update_layer`; `blur`, `skew`, `fillOpacity`,
`characterOffset`, `scaleY`, `lineSpacing`, `color` and an inline `sweep` went
onto `text_animator`. Counting those as separate tools would have hit the target
number while making the surface worse.

Two additions were **withdrawn** after checking the engine:

- **`set_corner_smoothing`** — squircles do not exist. `cornerRadius` is
  rasterized as a plain arc and there is no smoothing parameter anywhere in the
  render path, so the tool would have written a prop nothing reads.
- **`randomSeed` on `text_animator`** — range selectors have no randomize-order.
  The engine has a `wiggly` selector kind, which is a different thing.

### Also found present, contrary to the audit's own first pass

- `backdropBlur` is fully wired and unit-tested (`RenderBackend.ts:147`,
  `backdropBlur.test.ts`) — glass surfaces were reachable all along.
- The effect registry has ~40 types; the AI enum exposed 28. `inner-shadow`,
  `bevel`, `directional-blur`, `turbulent-displace`, `wave-warp`, `linear-wipe`,
  `transform` and `posterize-time` remain UNEXPOSED.
- `add_effect`'s own description told the model to use `update_effect_param` —
  a tool that did not exist until now.

### One structural addition the audit did not anticipate

**Caller-supplied layer handles.** `create_layer` had no `id` field and
`additionalProperties: false`, so a batch of calls could not reference what it
had just created — the engine assigns ids at execution time. That is fatal for a
library emitter, which produces its whole `ToolCall[]` up front with no model in
the loop. `id` is now an optional handle on every creating tool, and
`ToolRegistry.execute` resolves handles to real ids at one choke point before any
handler runs.

---

## Addendum 2 — Phase 3.4 cuts, and what the coverage expansion found

### The cuts

Two generative pipelines were deleted, both of them the arrangement the caster
replaces — an LLM authoring keyframes — and both of them sitting *behind* a path
that already worked.

| Deleted | Lines | Was it running? |
|---|---|---|
| `src/core/ai/pipeline/` (orchestrator, context, 6 schemas, 7 stages) | ~2,165 | Yes, as the third generative fallback |
| `motion-back` `evaluation-engine/` | 1,532 | **No** — injected, never called |
| `motion-back` `motion-engine/` | 2,010 | **No** — injected, never called |
| `motion-back` `design-engine/` | 1,392 | **No** — injected, never called |
| `motion-back` `taste/` | 942 | **No** — injected, never called |
| `motion-back` `knowledge/` | 735 | **No** — seeded five graphs at boot; nothing queried them |

`grep` for `this.motionEngineService.` and its five siblings returned nothing.
Six of `DirectorService`'s eight constructor parameters were unreferenced, so
Nest wired a class that *looked* like it consulted a knowledge graph and a taste
board before directing anything. It consulted neither.

Nothing in TypeScript can catch that — an unused constructor parameter is legal,
and Nest resolves providers at runtime. `src/ai/ai.module.spec.ts` now compiles
the real module graph with only Prisma and the cache stubbed, and asserts
`DirectorService.length === 2`.

### What was NOT cut, and why

The spec's Phase 3.4 also lists the **six-director fan-out** (~838 lines plus
composers and planners). It is still there, and it is still the fallback behind
the caster.

The reason is in the AgentLoop comment: a path that has shipped is worth more
than a path that has only passed tests. The caster's craft floor is deterministic
and its linters are green on 100% of library output, but it has not carried real
traffic. When it has, this is the next thing to delete — and at that point the
`/ai/director/run` endpoint goes with it.

### The stage checklist was describing a pipeline that no longer existed

`PIPELINE_STAGE_LABELS` in `useAiChat.ts` listed ten stages of the deleted client
orchestrator. `matchStageIndex` returned -1 for every label the run actually
emitted, so the progress panel silently never rendered. Nothing connects a string
literal in one file to a string literal in another, so
`layout/Workspace/pipelineStages.test.ts` now reads the runner's `onActivity`
literals out of the source and asserts each one lands on a stage.

### Coverage

| Library | Before | After | M2 target |
|---|---|---|---|
| Motion techniques | 22 | **39** | 70 |
| Product techniques | 17 | **26** | 40 |
| Layout templates | 17 | 17 | 40 |
| UI components | 22 | 22 | 45 |

The bar for a new technique is that it differs **structurally**, not
parametrically — a different set of properties, a different relationship between
them, a different order of arrival. A rise with a bigger travel is not a
technique; it is `rise_settle` with different params, and the caster can already
vary those.

### Three defects the expansion surfaced, all of them general

**1. Overlapping tracks on one channel merge, and the merge disagrees with
itself.** `line_push_stack` emitted a separate `y` track each time a later line
shoved an earlier one. They overlapped in time; merged, the key list zig-zagged
inside a single frame. `word_swap` had the same shape — an arrival track and an
exit track over the same interval. The rule is one timeline per node+property,
built whole and emitted once.

**2. Mixing offset and un-offset origins makes keys non-monotonic.** Measuring
the head of a move from `offsetFor(ctx, 'y', at)` and its tail from bare `at`
works until the property lead exceeds the move length — then the sorted result
runs backwards. Every key on a channel comes from one origin.

**3. Declaring more roles than a technique can orchestrate.** A technique listing
four roles is handed eight to ten layers by a full layout, and `staggerAt` has to
compress them into the slot — which piles the last three within 20ms of each
other. This is the same defect `rolesTargets` was written for, arriving from the
other direction.

### The forbid list was the wrong mechanism

`LookPack.forbid` named every editorial technique a product pack must refuse, by
id, by hand. It was correct for exactly as long as the library did not grow: the
day it went from 22 techniques to 39, both product packs silently began offering
`kinetic_type.line_push_stack` and `exit.scatter_out` for a dashboard.

Nobody forgot to update a list — the list was the wrong mechanism. Packs now
carry `forbidCategories` and `forbidAboveEnergy`, and `packPermits()` checks id,
then category, then energy ceiling. A rule covers techniques that do not exist
yet; `product.test.ts` asserts the rule rather than list membership, and includes
a case for a technique invented in the test body.

### The linters caught four claims in the new product techniques

Worth recording because each was an argument for an exception that the rule was
right to refuse:

- `ui.badge_pulse` was written with `bouncy` and a 1.22 peak on the argument that
  a badge is the one control allowed a big overshoot. `UI_LIMITS.maxOvershoot` is
  4% and it applies to indicators too. What makes a badge noticeable is that it
  comes from nothing, not that it boings.
- `ui.filter_reflow` multiplied the row gap by the number of items removed above
  it, putting the third survivor at 60px against a 32px ceiling. Real reflow
  scrolls the container; the rows barely move.
- `ui.segmented_slide` clamped to the travel limit and *then* applied seed
  variation, so a 1.15× seed took a value already at the ceiling over it.
- `ui.drag_lift` grew its stagger interval per index, so the gap between the
  fourth and fifth rows exceeded the 60ms ceiling.
