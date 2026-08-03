# Feature Audit — remaining After Effects parity

**Date:** 2026-08-03
**Branch:** `docs/feature-audit` off `dev` @ `5e672a7`
**Scope:** the remaining AE feature set, excluding motion tracking (out of scope by direction).
**Method:** code only. `docs/COMPOSITING_PLAN.md` was not consulted; the M-numbers below (M5 / M8c / M9 / M7) were re-derived from source and commit subjects.

> **Corrected 2026-08-03, after reading the plan.** Two of the reconstructions
> were wrong, both in the same direction — they under-read what was already
> decided.
>
> 1. **M5's gate is scoped as PIPELINE determinism, not preview≡export.** The
>    plan (§0, "A byte-identical determinism gate exists") records that the
>    harness already re-renders for byte-identical output, but from the *same
>    snapshot object* — so it gates the back half (renderFrame → GPU → readback)
>    and is structurally blind to the front half. A Dissolve seeded from
>    wall-clock would be sampled once into that snapshot and pass every time.
>    M5 is therefore "extend the existing gate from renderer-determinism to
>    pipeline-determinism", a smaller job than building one. Every use of
>    "preview ≡ export" below is that narrower reading and should be read as
>    pipeline determinism instead.
> 2. **M-F10 was already scheduled as M5's prerequisite**, for the same reason
>    this audit later re-derived. That conclusion converged; it was not new.
>
> The classification table and sizing are unaffected — they came from the code.

---

## Headline

**The prediction held.** Of the 23 items scoped for this run, **17 are already fully implemented and reachable in the real UI**, 4 are partial, and only **2 are genuinely absent**.

Every item in the Phase-2 prior ordering — graph editor, parenting, expressions, trim paths, text animators, motion blur — is **already shipped**, with model, UI, and tests. The ordering prior is therefore not just mis-ranked, it is mostly moot. What actually remains is the parked compositing work the prior ranked *last*, plus a short tail of shape-operator completeness.

This is the same failure mode as decoupled track mattes: the plan describes a build that already happened.

| | Count | After the four commits below |
|---|---|---|
| ✅ implemented | 17 | **21** |
| ⚠️ partial | 4 | **1** |
| ❌ missing | 2 | **1** |

> **Shipped immediately after this audit was written.** Four of the six open
> items landed within days, which is the same pattern the audit itself is about:
> the plan describes a build that already happened, and by the time the
> description is written it has moved again. Marked inline below as **✅ shipped**
> rather than rewritten, so the audit still reads as the snapshot it was.
>
> | Item | Commit |
> |---|---|
> | M8c — Stencil / Silhouette | `045cd09` |
> | Keyframe-selection time scale | `59e6f9c` |
> | Wiggle Paths (temporal) | `61fc1fc` |
> | Repeater — the missing three parameters | `a0edf7a` |

---

## 1. Classification table

### Parked compositing

| Item | Status | Evidence |
|---|---|---|
| **M5 — Dissolve / Dancing Dissolve** | ❌ missing | `LayerBlendMode` union has no `dissolve`/`dancing-dissolve` — [blendMode.ts:34](src/core/effects/blendMode.ts:34). `BLEND_MODES` lists **32** modes, [blendMode.ts:90](src/core/effects/blendMode.ts:90). Shader mode ids run 1–28 with no dither branch — [builtin.ts:429](packages/renderer/src/shaders/builtin.ts:429). |
| **M5 — pipeline-determinism gate** | ❌ missing | No shared preview-vs-export determinism assertion exists for a per-pixel stochastic mode. Dissolve is the first mode whose output depends on a random source, so nothing today forces preview and export to agree on it. |
| **M8c — Stencil / Silhouette** | ✅ **shipped** (`045cd09`) | Was: absent from the union ([blendMode.ts:34](src/core/effects/blendMode.ts:34)) and from `bChan`/`bHSL` ([builtin.ts:436-505](packages/renderer/src/shaders/builtin.ts:436)). Landed as **36 of AE's 38** — the remaining two are the Dissolve pair above, which need the determinism gate first. |
| **M9 — variable-width mask feather** | ❌ missing | Feather is a **single scalar per path**, not per-point: `MaskPath.feather` at [mask.ts:58](src/core/effects/mask.ts:58); `MaskPoint` carries only x/y and bezier handles, no feather field — [mask.ts:39-50](src/core/effects/mask.ts:39). Uniform feather itself *is* implemented and rendered. |

Note: `MaskMode` already includes AE's 7th mode `none` ([mask.ts:52](src/core/effects/mask.ts:52)), and effect-scoped masking (M6) and protected time regions (M7) are both landed — so the mask model is further along than the feather gap suggests.

### Keyframe and timing — **all implemented**

| Item | Status | Evidence |
|---|---|---|
| Multi-select + range ops on keyframes | ✅ implemented | Marquee hit-testing [marqueeSelection.ts:88](src/layout/Timeline/marqueeSelection.ts:88); selection state + multi-drag commit [Timeline.tsx:736-844](src/layout/Timeline/Timeline.tsx:736); shared selection store `keyframeSelectionStore.ts`; snapping with dragged keys excluded from their own snap targets [Timeline.tsx:796-800](src/layout/Timeline/Timeline.tsx:796); copy/paste of a selection [clipboard.ts](src/core/commands/clipboard.ts). |
| Graph editor — bezier handles, value **and speed** | ✅ implemented | [GraphEditor.tsx](src/layout/Timeline/GraphEditor.tsx) (713 lines): handle drag works on linear keys too [:298](src/layout/Timeline/GraphEditor.tsx:298), tangent alignment [:94](src/layout/Timeline/GraphEditor.tsx:94). Speed-curve maths are a separate tested module — `outgoingSpeed`/`withIncomingSpeed`/`influences` [speedGraph.ts:45-100](src/layout/Timeline/speedGraph.ts:45). Mounted and toggleable: [BottomTimeline.tsx:569](src/layout/BottomTimeline/BottomTimeline.tsx:569), menu item [:160](src/layout/BottomTimeline/BottomTimeline.tsx:160). |
| Roving keyframes | ✅ implemented | `Keyframe.roving` in the schema; `setRoving` on the engine; UI in two places — context menu [App.tsx:1047](src/App.tsx:1047) and [MotionEditorPanel.tsx:222](src/layout/Motion/MotionEditorPanel.tsx:222). |
| Easing presets + per-keyframe interpolation | ✅ implemented | `EasingPreset` = Linear/Ease/EaseIn/EaseOut/Hold [keyframeAssistants.ts:243](src/core/animation/keyframeAssistants.ts:243); applied to the live selection [easingSelection.ts:20](src/core/animation/easingSelection.ts:20). Per-key `easing` + `bezier` + linked-tangent flag in `Keyframe` (packages/animation/src/types.ts:28). Spatial bezier tangents also present. |

✅ **Shipped** (`59e6f9c`). Was: there is no *time-scale* of a keyframe selection (AE's Alt-drag on a selection range to stretch it proportionally). `stretchTracks` existed but operated on **all** tracks of a node ([keyframeAssistants.ts:67](src/core/animation/keyframeAssistants.ts:67)), not on the selected subset.

### Transform and hierarchy — **all implemented**

| Item | Status | Evidence |
|---|---|---|
| Parenting / null objects | ✅ implemented | [parenting.ts](src/core/scene/parenting.ts): `canReparent` rejects loops [:54](src/core/scene/parenting.ts:54), `reparentNode` compensates the local transform so the layer does not move [:74](src/core/scene/parenting.ts:74), `eligibleParents` [:126](src/core/scene/parenting.ts:126), `insertNull` [:145](src/core/scene/parenting.ts:145). Null layers have their own inspector branch [DemoPanels.tsx:1323](src/layout/EditorLayout/DemoPanels.tsx:1323). Tests: `parenting.test.ts`. |
| Anchor point tooling | ✅ implemented | `moveAnchorCompensated` + `anchorCompensation` [anchor.ts:57-96](src/core/scene/anchor.ts:57). Real **PanBehindTool** — drag to place the anchor without moving the layer, AE semantics including "dragging the body moves the anchor too" [builtin.ts:1153-1198](packages/workspace/src/tools/builtin.ts:1153). Rotate spins about the anchor [:1133](packages/workspace/src/tools/builtin.ts:1133). |
| Motion blur — per-layer, shutter angle, samples | ✅ implemented | [motionBlur.ts](src/core/effects/motionBlur.ts): `motionBlurSampleTimes` with shutter **angle and phase** (AE −90 default) [:36](src/core/effects/motionBlur.ts:36), `adaptiveMotionBlurSamples` [:64](src/core/effects/motionBlur.ts:64), per-layer opt-in on `fx` [:74](src/core/effects/motionBlur.ts:74). Comp-level gate + persistence in `motionBlurStore.ts`. Two-level AE gating (comp enables, layer opts in) is correct. |

This is more complete than the prior assumed — shutter *phase* and adaptive sampling are both beyond the stated ask.

### Shape layers — mostly implemented

| Item | Status | Evidence |
|---|---|---|
| Trim Paths | ✅ implemented | [trimPath.ts](src/core/scene/trimPath.ts): `trimSegments` handles the wrap-past-end two-arc case [:50](src/core/scene/trimPath.ts:50), arc-length table + `trimPolyline` [:114-187](src/core/scene/trimPath.ts:114). Keyframeable — `trim.start`/`.end`/`.offset` prop paths [:35](src/core/scene/trimPath.ts:35). UI: `TrimPathControls.tsx`. |
| Repeater | ✅ **shipped** (`a0edf7a`) | [repeater.ts](src/core/scene/repeater.ts): copies + position/rotation/scale/opacity offsets, cumulative in each copy's rotated frame [:68](src/core/scene/repeater.ts:68), all six params keyframeable [:43](src/core/scene/repeater.ts:43). UI: `RepeaterControls.tsx`. Was missing vs AE: per-copy anchor point, start-offset (fractional first copy), and composite order (Above/Below) — all three landed. |
| Offset Paths | ✅ implemented | `offsetPath` [pathOps.ts:201](src/core/scene/pathOps.ts:201), exposed as the `'offset'` operator type. |
| Merge Paths | ✅ implemented | [mergePaths.ts](src/core/scene/mergePaths.ts): all four AE ops (union/subtract/intersect/exclude) [:29](src/core/scene/mergePaths.ts:29), polygon booleans [:142](src/core/scene/mergePaths.ts:142), and a **live** (non-destructive) boolean evaluated at render [:182](src/core/scene/mergePaths.ts:182) as well as a destructive merge [:362](src/core/scene/mergePaths.ts:362). Wired into the menus (commit `9f2ca6d`). |
| Wiggle Paths | ✅ **shipped** (`61fc1fc`) | `roughen` [pathOps.ts:230](src/core/scene/pathOps.ts:230) subdivides and displaces along the normal — the *spatial* half of AE's Wiggle Paths. Its noise was seeded by **point index only** ([:246](src/core/scene/pathOps.ts:246)) with no time term, so the wiggle was frozen. Wiggles/Second, temporal phase and correlation landed; it wiggles. |
| Wiggle Transform | ❌ missing | No hit anywhere in `src`/`packages`. Note the *expression* `wiggle()` exists and is fully implemented — that is a different feature and does not cover the shape-layer operator. |
| Path operators generally | ✅ **shipped** (schema 1.3.0) | Seven operators exist and all are reachable — `zigzag`, `roundCorners`, `pucker`, `twist`, `offset`, `roughen` [pathOps.ts:18](src/core/scene/pathOps.ts:18). The structural gap this recorded — *one operator per node, not a stack* — is closed: `fx.pathOps` is an ordered array applied top-down, operators carry a stable id so keyframes survive a reorder, and `v1_2_0_to_v1_3_0` re-keys the tracks. **Still single-slot:** `trim`, `rep`, `textPath`. |

### Text — **all implemented**

| Item | Status | Evidence |
|---|---|---|
| Text animators with range selectors (start/end/offset) | ✅ implemented | [textAnimators.ts](src/core/text/textAnimators.ts): selector params include `start`/`end`/`offset` plus `amount`, `smoothness`, `easeHigh`, `easeLow` [:124](src/core/text/textAnimators.ts:124) — i.e. AE's full Advanced options, not just the range. **Multiple selectors per animator** (`selectors[]`, with `basedOn` migrated off the deprecated top-level field [:206](src/core/text/textAnimators.ts:206)). A wiggly selector is present (`wiggleFreq`, [:110](src/core/text/textAnimators.ts:110)). UI: `TextAnimatorControls.tsx` (710 lines), mounted at [DemoPanels.tsx:1049](src/layout/EditorLayout/DemoPanels.tsx:1049). |
| Per-character and per-word animation | ✅ implemented | `basedOn: RangeBasedOn` with a per-`basedOn` unit map cached per string [textAnimators.ts:449-456](src/core/text/textAnimators.ts:449). Per-glyph transforms land on `PlacedGlyph.animator` [textLayout.ts:85](src/core/text/textLayout.ts:85). Per-character 3D is a separate landed module (`perChar3D.ts`). Ready-made rigs: typewriter, bounce-in-words, spin-fade-characters, tracking reveal [keyframeAssistants.ts:143-242](src/core/animation/keyframeAssistants.ts:143). |
| Path text | ✅ implemented | [textPath.ts](src/core/text/textPath.ts): `applyTextPath` places glyphs by arc length with tangent rotation [:119](src/core/text/textPath.ts:119), driven by a **mask path** as the spine [:193](src/core/text/textPath.ts:193), `firstMargin` keyframeable [:36](src/core/text/textPath.ts:36). Tests: `textPath.test.ts`. |

### Expressions — **implemented, and architecturally sound**

| Item | Status | Evidence |
|---|---|---|
| Property linking / scripting | ✅ implemented | Engine: `setExpression`/`removeExpression`/`getExpressionError` [AnimationEngine.ts:731-756](packages/animation/src/AnimationEngine.ts:731); expressions override the sampled value per frame [:428-461](packages/animation/src/AnimationEngine.ts:428). API surface [expressions.ts:112](packages/animation/src/expressions.ts:112): `time`, `value`, `wiggle`, `loopIn/Out`, `valueAtTime`, `velocity`, `speed`, `linear`, `ease`, `clamp`, `layer`, `thisComp`, `thisLayer`, `thisProperty`, plus `audio` and `ctrl()` for rig controls. UI: `ExpressionEditor.tsx`, with tokenizer + bracket matching for highlighting [:346-381](packages/animation/src/expressions.ts:346). |
| Evaluation model — can it carry dependencies? | ✅ **yes, already does** | Cross-layer reads are live: `layerAt(name, prop, t)` [expressions.ts:44](packages/animation/src/expressions.ts:44), resolved by the engine with **cycle detection** [AnimationEngine.ts:451](packages/animation/src/AnimationEngine.ts:451) and a **depth-16 chain cap** [:517](packages/animation/src/AnimationEngine.ts:517). Self-reference is structurally prevented: `selfAt` samples keyframes only, never the expression-adjusted value, so `valueAtTime` cannot recurse through its own expression [expressions.ts:37-41](packages/animation/src/expressions.ts:37). |

Two things worth flagging as *good* news for the prior's "decide early, it's invasive" concern:

1. **The invasive decision was already made correctly.** Property dependencies exist, are cycle-safe, and are demand-evaluated per (node, prop, t) — there is no property graph to restructure.
2. **It is not `new Function`.** There is a hand-written lexer/parser/evaluator (`exprLang.ts`, 438 lines: `parseExpression` [:305](packages/animation/src/exprLang.ts:305), `evalNode` [:339](packages/animation/src/exprLang.ts:339), callee safety check [:318](packages/animation/src/exprLang.ts:318)). That is what makes expressions work under the packaged CSP — the same constraint that previously killed `set_expression` on the AI path.

### Templates (D3) — **confirmed, do not rebuild**

| Item | Status | Evidence |
|---|---|---|
| Exposed-property controls, field kinds, data binding | ✅ implemented | Field kinds drive the panel control [templateTypes.ts:14](src/core/template/templateTypes.ts:14); a template is "an authored scene + its exposed fields" [:74](src/core/template/templateTypes.ts:74); read/write against the **live** graph in `templateFields.ts`. Authoring path in `templateAuthoring.ts`. Tests assert every exposed field targets a real node+component+prop and that **only** exposed props change (`template.test.ts:17`). Media slots are a separate landed subsystem (`mediaSlots.ts`). |
| M7 — protected time regions | ✅ implemented | `responsiveTime.ts` + `responsiveTimeStore.ts` + marking UI (commits `b603ae4`, `12ee37c`). Covered; nothing to add. |

---

## 2. Sizing

Sized against what exists, not generic estimates.

| Item | Size | Reasoning |
|---|---|---|
| M8c Stencil / Silhouette | **M** | 4 modes, but a **different topology** from every mode shipped so far. `bChan`/`bHSL` return a colour; stencil/silhouette instead multiply the *accumulated backdrop's alpha* by the layer's alpha or luma, affecting every layer below. The plumbing that makes this cheap already exists — `layerIntoTarget` with blend override and full-comp targets [CompositionPass.ts:258-271](packages/renderer/src/rendergraph/passes/CompositionPass.ts:258) — but it needs an alpha-write path the combine shader does not currently have, plus the Canvas2D fallback. |
| M5 Dissolve + Dancing Dissolve | **M** | Two modes, one new shader branch. The cost is not the blend — it is the **determinism gate**: dissolve is the first per-pixel stochastic mode, so preview and export must produce bit-identical noise. Needs a seeded hash keyed on (pixel, frame, layer) with no reliance on GPU-side RNG, and Dancing Dissolve must re-seed per frame while Dissolve must not. Determinism test is most of the work. |
| M9 Variable-width mask feather | **L** | The only item here that is a genuine **schema change**. Feather moves from `MaskPath.feather: number` to per-point feather with inner/outer split — that is a version bump + migration ([mask.ts:58](src/core/effects/mask.ts:58)), a new rasterization strategy (current uniform feather is a blur-by-half; variable width needs a distance-field or swept-outline approach), *and* on-canvas feather-handle editing, which does not exist. |
| Wiggle Transform | **M** | Genuinely new, but sits directly on `repeaterCopies` [repeater.ts:68](src/core/scene/repeater.ts:68) — a per-copy random transform is a decorator over the existing copy list. Deterministic-seed discipline is already established in `roughen`. |
| Wiggle Paths — temporal | **S** | Add a time term and a wiggles/second param to `roughen`'s seed [pathOps.ts:246](src/core/scene/pathOps.ts:246), thread `t` through `applyPathOp`/`resolvePathOp`. The geometry is done. |
| Path-operator **stack** | **L** | Structural. `fx.pathOp` single slot → ordered list, with prop paths becoming indexed (`pathop[i].amount`). Touches the schema (bump + migration), the keyframe prop-path namespace, the inspector, and the render read path. The same change would naturally generalise `trim`/`rep`. |
| Repeater param completeness | **S** | Anchor point, start offset, composite order — three params on an existing tested structure. |
| Keyframe selection time-scale | **S** | `stretchTracks` exists [keyframeAssistants.ts:67](src/core/animation/keyframeAssistants.ts:67); needs a selection-scoped variant plus the drag affordance in `Timeline.tsx`, which already owns multi-drag. |
| Trim "Individually / Simultaneously" | **S** | One mode flag; only meaningful once a layer holds multiple shapes. |

**Too large for this run:** none individually. The **path-operator stack (L)** and **variable-width feather (L)** are the two that carry schema-migration risk and should not be attempted in the same milestone as each other.

---

## 3. Dependency graph

```
M8c Stencil/Silhouette ──┐
                         ├──> 38/38 blend modes complete
M5 Dissolve/Dancing ─────┘
   └── requires: pipeline-determinism gate (preview ≡ export)
                 └── reusable by: Wiggle Transform, temporal Wiggle Paths
                     (all three need one seeded-noise contract, not three)

Path-operator stack (schema bump + migration)
   ├──> stacked Offset/Zigzag/Roughen chains
   ├──> generalises to trim[] / rep[] single slots
   └──> should land BEFORE Repeater param completeness
        (otherwise repeater params get written twice)

Variable-width feather (schema bump + migration)
   └── independent of everything above; touches only the mask model
       + rasterizer + a new on-canvas editing affordance

Keyframe selection time-scale ── independent, no dependencies
Trim Individually/Simultaneously ── independent
```

Two migrations are in play (path-op stack, feather). They touch disjoint parts of the schema, so they can ship in either order — but **not in the same version bump**, or a failed migration cannot be bisected.

---

## 4. Stack ranking — user value per unit of effort

| # | Item | Size | Why here |
|---|---|---|---|
| 1 | **Temporal Wiggle Paths** | S | Highest ratio on the board. Organic path motion is the single most-reached-for shape effect, the geometry is already written and tested, and it is a seed change plus a param. |
| 2 | **Keyframe selection time-scale** | S | Completes the one real gap in an otherwise finished keyframe editor. Retiming a selection is a daily action; everything it needs already exists. |
| 3 | **Repeater param completeness** | S | Anchor point and composite order are what make a repeater usable for radial/burst layouts rather than just linear rows. Three params on tested code. |
| 4 | **M8c Stencil / Silhouette** | M | Real compositing capability (luma-keyed reveals, type-as-cutout) that nothing else can express, *and* closes 38/38. Ranked above M5 because it is deterministic — no new correctness contract. |
| 5 | **M5 Dissolve + determinism gate** | M | The modes are minor; the **gate is the asset**. It is the prerequisite for every future stochastic effect, and it is exactly a §2·0 site — noise with two independent readers (preview, export) and nothing today forcing agreement. Worth building for the gate alone. |
| 6 | **Wiggle Transform** | M | Genuinely new capability, but narrower reach than the above and it should reuse #5's seed contract rather than invent one. |
| 7 | **Trim Individually/Simultaneously** | S | Small, but near-zero value until multi-shape layers are common. |
| 8 | **Path-operator stack** | L | High ceiling — chained operators are where shape layers get expressive — but it is a migration, and the seven existing operators already cover most single-operator use. Defer until the S-tier is clear. |
| 9 | **Variable-width feather** | L | Lowest ratio. Largest single item (schema + new rasterization + new canvas editing), and uniform feather already covers the common case. Genuine completeness work, not user impact. |

**Reasoning on the ordering shift from the prior:** items 1–6 of the prior list (graph editor, parenting, expressions, trim paths, text animators, motion blur) are all ✅ and drop out entirely. The prior ranked parked compositing *last* as "completeness, not user impact" — but with everything above it already built, M8c/M5 move up by default, and M5's determinism gate turns out to be infrastructure rather than polish. The prior's instinct that expressions were the architecturally invasive decision was right in principle and moot in fact: it was already made, and made well.

---

## 4a. Phase 2 progress (2026-08-03)

Landed on `dev`, in ranking order:

| # | Item | State |
|---|---|---|
| 1 | Temporal Wiggle Paths | ✅ merged |
| 2 | Keyframe selection time-scale | ✅ merged |
| 3 | Repeater param completeness | ✅ merged |
| 4 | M8c Stencil / Silhouette | ✅ merged; pixel gate green, all four scenes registered |
| 5 | M5 Dissolve + determinism gate | **UNBLOCKED** — F10/F12 fixed |

M8c cost an M, not the L the estimate implied: the "compositing-group boundary"
it was said to need already existed. The advanced-blend path renders the layer
to one target, copies the accumulated backdrop to another, and overwrites the
group's out target with a function of the two — the exact topology a stencil
needs — and precomps already isolate into their own target.

### F12 — F10 is broader than recorded · **FIXED**

F10 recorded the trigger as "a transparent comp AND an advanced-blend layer,
both required". The four Matte scenes use an **opaque** comp and failed anyway,
because the transparency is produced *by the blend itself*. That ruled the comp
out and pointed at partial alpha in the final composite.

**Cause, confirmed.** `EffectPass` blits the offscreen scene target onto the
SURFACE with source-over, but `ClearPass.writes` is
`[EffectPass.activeColorTarget]` — so when that pass is enabled the per-frame
clear goes to `SCENE_COLOR_TARGET` and nothing clears the surface, which the
blit is the only writer of. Partial alpha therefore mixed in the previous frame
and converged toward opacity. Opaque frames were unaffected, since source-over
at a = 1 is a replace. The blit now replaces. Fixed in `EffectPass.ts`.

The suspect carried over from the original diagnosis — `activeColorTarget` as a
mutable static behind a memoized `compile()` — **is not implicated**. Routing was
correct throughout; the destination was simply never cleared.

**Blast radius, re-measured** at the wider characterisation (report-not-throw,
four renders per scene, full suite, parked scenes registered): the four Matte
scenes plus `blend-alpha-add-seam`. **No committed golden affected**, and none
re-blessed — only the five new ones, each verified on its defining properties
first via the new `scripts/verify-matte-modes.mjs`.

Sized **L**, cost **S**. The L assumed changing pass ordering or target routing
on a path 30+ goldens depend on.

### Two things the fix made visible

- **The seam scene did not demonstrate its own claim.** Its rectangles abutted
  exactly, so no pixel had both layers contributing and Alpha Add had nothing to
  sum — it measured 128 with a coverage *dip* to 108, never the 191-vs-255
  distinction it exists to show. They now overlap by 10 px and the overlap reads
  255. Undetectable while F10 meant the scene could never run.
- **F13 (logged, not fixed):** the backends read back under different
  conventions. WebGL2 reads the drawing buffer and yields premultiplied bytes;
  the WebGPU path goes through `drawImage` + `getImageData`, which
  unpremultiplies. Same engine output, different encoding — the verifier detects
  which it has rather than assuming. Worth checking how much of the standing
  webgpu-vs-webgl2 parity gap on partial-alpha scenes this accounts for.

### `BLEND_MODES.group` · **FIXED**

Documented as "load bearing for the picker's section headers" and read by
neither consumer — both flat-mapped the table, so the AE ordering was invisible.
Both pickers now build from one place (`blendMenu.ts`), headers included, tested
against the table so a section cannot go missing silently.

---

## 5. Notes for Phase 2

- **§2·0 watch.** The determinism gate (#5) is a textbook instance: one noise source, two readers (preview path and `offlineRenderer`), nothing forcing agreement. Build the gate as an assertion, not a golden — a wrong dissolve looks like a plausible dissolve.
- **Two migrations, two version bumps.** Path-op stack and feather must not share one.
- **UI alongside model.** Every ✅ item above has its UI wired, which is why they were verifiable at all. `TrimPathControls`/`RepeaterControls`/`PathOpControls` are the pattern to copy.
- **Uncommitted state on `dev`** (reported, not touched): the working tree carries 10 modified files of in-flight F11 lint-suppression and release-signing work, plus a `stash@{0}: f11-wip`. Not part of this audit; flagged so it is not lost or accidentally swept into a feature branch.

### Caveat on the M-numbers

`docs/COMPOSITING_PLAN.md` was **not** read, per the standing instruction not to read `.md` files. The M5 / M8c / M9 scopes above were reconstructed from source and commit subjects. The mapping is well-corroborated — 32 shipped modes + 2 dissolve + 4 stencil/silhouette is exactly the "38 of 38" the brief cites, and M6/M7 match landed commits `1e2b955`/`b603ae4` — but if the plan defines M5's "pipeline-determinism gate" as something broader than preview≡export for stochastic modes, that scope should be corrected before building it.

Note also that the plan file is one of the 10 uncommitted-modified files above, so the on-disk copy is not what was last committed either way.
