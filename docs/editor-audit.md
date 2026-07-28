# Motion Editor — Quality Audit (Phase 0)

**Date:** 2026-07-27
**Scope:** the whole editor, benchmarked against After Effects.
**Status:** audit complete; the work it recommended has since been done.
Parts A and B describe the code **as it was on 2026-07-27** and are a
historical record. The **Outcome** section at the end states current status
per item, and the **Performance addendum** was measured after the work.

---

## 0. Method, and how to read this

Every claim below is cited to a file and line and was verified by reading the
code. Where I could not verify something at runtime I say so rather than
guessing.

**Two things about the brief that turned out to be wrong, and they change the
plan materially:**

1. **The styling system is not "border / borderColor / boxShadow /
   backgroundColor / align".** Those five properties do not exist in this
   codebase at all — `grep` for them outside CSS modules returns nothing in the
   domain layer. What exists instead is a considerably deeper vector paint
   model: a **multi-fill stack** with solid / linear / radial gradients and
   multi-stop ramps (`src/core/paint/fill.ts:22-80`), a **multi-stroke stack**
   with width, opacity, alignment, dash arrays, caps, joins and gradient paint
   (`src/core/paint/stroke.ts:25-40`), 17 blend modes
   (`src/core/effects/blendMode.ts`), corner radius, backdrop blur, and a
   16-preset composed-look registry (`src/core/style/stylePresets.ts:84`).
   Alignment is already an *operation* that writes Position, not a stored
   property (`src/core/scene/alignNodes.ts:20`).

2. **Most of the Phase 5 "new capability" list already exists.** Trim paths,
   repeater, parenting, null objects, precomp, adjustment layers, motion blur
   with shutter angle *and* phase, time stretch/reverse/freeze, time remapping,
   track mattes, text animators with range **and** wiggly selectors, animation
   presets, expression controls, and a full expression language are all
   implemented and wired. Building them again would be the single most
   expensive mistake available here.

So the real work is much more heavily weighted toward **Phase 4 (fix what's
poor)** than the brief assumed, plus a small number of genuine Phase 5 gaps.
My recommended order at the end differs from the brief's for that reason.

**Screenshots — not captured.** Two blockers: (a) the Browser pane is not
displayed in this session, so every `screenshot` call times out with *"the page
is not compositing frames"*; (b) the app is behind a hard auth gate
(`src/routes/RequireAuth.tsx:15`) that validates a token against the
`motion-back` service, and I will not enter credentials. I started the dev
server on :5277 and confirmed the app builds and serves (it renders the sign-in
page), then stopped it. **If you display the Browser pane and sign in, I will
capture the four requested screenshots in a follow-up pass.** Everything in
this document is code-verified and does not depend on them.

---

# Part A — Inventory

## A1. Scene object inventory

Layer kind is a string prop (`__kind`) on a node's component, read by
`readNodeKind` (`src/core/scene/sceneDerive.ts:13`). The union is declared at
`src/core/scene/seedDefaultScene.ts:17`:

| Kind | Renders as | Notes |
|---|---|---|
| `shape` | rect / ellipse / polystar / free bezier path | `Geometry.points` (bezier), or `shapeType` + `radius` |
| `text` | rasterized glyph run | `Canvas2DVectorRasterizer.ts:200-225`, per-char runs supported |
| `image` | texture | |
| `video` | texture from `videoFrameCache` | |
| `svg` | stored vector document → texture (`KIND_TO_ENGINE_TYPE` maps it to `image`, `SceneGraph.ts:40`) | static SVGs stay one intact layer |
| `group` | nothing of its own; box = union of children | `geometry.ts:80-103` |
| `null` | 60×60 gizmo box, no pixels | AE null object |
| `camera` | gizmo | 3D |
| `light` | gizmo | 3D, casts shadows |
| `adjustment` | invisible full-frame; effects apply beneath | `src/core/effects/adjustment.ts` |
| `particle` | emitter | `src/core/particles` |
| `comp` | precomp / comp instance, full-frame box | `src/core/scene/compInstance.ts` |
| `audio` | no visual | excluded from `isDrawableKind` (`geometry.ts:59`) |

There is **no dedicated solid-layer kind** — a solid is a shape with
`fx.solid = true` (`SceneGraph.ts:499`), pinned to comp size in
`buildSnapshot.ts:770`. Guide layers do not exist.

Properties live in two places, which is the central structural fact of this
codebase:

* **Base/authoring values** — plain props on `Component.props` records, written
  through `SceneGraph.writeProp` (`SceneGraph.ts:360`).
* **Layer feature data** — a catch-all `fx` component holding ~25 keys
  (mask, matte, trim, repeater, fills, strokes, layerStyles, motionBlur, time,
  precomp, particle, paint, …), each with its own `setX` method
  (`SceneGraph.ts:398-548`).

## A2. Property model

**Storage is split. Read this carefully — it is the root of most of the
`present-poor` findings.**

| | Storage | Keyframeable? | Easing? |
|---|---|---|---|
| Transform (x, y, z, scaleX/Y/Z, rotation*, anchorX/Y/Z, opacity) | Component props | **Yes**, scalar tracks | Full |
| Effect params (numeric) | `fx.effects[].params` | **Yes**, `effect.<id>.<key>` (`EffectStack.tsx:191`) | Full |
| Effect params (color) | same | **Yes**, decomposed `_r/_g/_b/_a` tracks (`EffectStack.tsx:69-88`) | Full |
| Fill / stroke color | `fx.fill` / `fx.stroke` | **Yes**, `ColorKfRow.tsx` decomposed channels | Full |
| Gradient stops | `fx.fill.stops` | **Yes**, `fill.stops` data track (`AppearanceSection.tsx:124`) | **None — linear only** |
| Mask / shape path points | `fx.maskAnim`, `path.points` | **Yes**, `points` data track | **None — linear only** |
| Source text | `text.source` data track | **Yes** | Hold (correct) |
| Trim path start/end/offset | `fx.trim` | **Yes** (`TrimPathControls.tsx:42-56`) | Full |
| Repeater params | `fx.repeater` | **Yes** (`RepeaterControls.tsx:51-65`) | Full |
| Time remap | `timeRemap` track | **Yes** (`PrecompControl.tsx:25-41`) | Full |
| **Layer styles (drop shadow, outer glow)** | `fx.layerStyles` | **No stopwatch anywhere** (`LayerStylesControls.tsx` — no `isAnimated`/`setKeyframe` calls at all) | — |
| **Stroke width / dash / cap / join / align** | `fx.stroke` | **No** | — |
| **Blend mode, mask mode, matte type** | `fx.*` | **No** (enum, matches AE) | — |
| **Corner radius, backdrop blur** | Component props | Not exposed to stopwatch | — |

**Is the keyframe mechanism generic?** Yes for scalars — `AnimationEngine`
(`packages/animation/src/AnimationEngine.ts:73`) is keyed by
`(nodeId, propPath)` with no per-property special-casing, so any property that
can be reduced to a number is animatable for free. Non-scalars go through a
**second, weaker system**: `DataTrack`
(`packages/animation/src/dataTracks.ts:43-49`), whose `DataKeyframe` is
`{ t, value }` — **no easing, no bezier, no hold, no tangents**
(`dataTracks.ts:212-227` interpolates strictly linearly). This is the biggest
architectural asymmetry in the property model.

**Interpolation curve types** (`packages/animation/src/types.ts:13-23`):
`linear | step | ease | easeIn | easeOut | easeInOut | bezier | hold |
autoBezier | continuousBezier`. That is a superset of AE's.

**Property tree/group concept:** partial. The timeline synthesises groups
(Anchor Point / Position / Scale / Rotation as pseudo-rows with placeholders,
`src/App.tsx:355-380`) and has collapsible categories, but the underlying model
is a **flat `Map<prop, Track>` per node** — there is no `Property<T>` object,
no group nodes, no per-property `type`/`min`/`max`/`unit` metadata. Units and
labels are re-derived per surface from ad-hoc lookup tables
(`App.tsx:255-272` is a 17-deep nested ternary mapping prop names to labels).

## A3. Transform

| AE property | Exists | Name(s) | Animatable | Relative to |
|---|---|---|---|---|
| Anchor Point | Yes | `anchorX`, `anchorY`, `anchorZ` | Yes | px offset from layer **centre** (0,0 = centre), `src/core/scene/anchor.ts:8-11` |
| Position | Yes | `x`, `y`, `z` | Yes | comp space (or parent space when parented) |
| Separate X/Y | Yes | `SceneGraph.setSeparateDimensions` (`SceneGraph.ts:296`) | Yes | already separate tracks natively |
| Scale | Yes | `scaleX`, `scaleY`, `scaleZ` (+ legacy uniform `scale`) | Yes | multiplier |
| Uniform link | Yes | UI-only `linkedScale` state (`TransformSection.tsx:45`) | — | **not persisted** |
| Rotation | Yes | `rotation`, `rotationX/Y`, `orientationX/Y/Z` | Yes | degrees, **unbounded** — `AngleDial` shows `1x+45°` (`AngleDial.tsx:7`) ✔ Invariant 5 |
| Opacity | Yes | `opacity` (0–100) | Yes | |
| **Skew / skew axis** | **No** | — | — | exists only inside text animators (`textAnimators.ts:128`) and as a dead field in `worldTransform.ts:35` |

Anchor is draggable in the viewport via the Pan-Behind tool (`Y`),
`builtin.ts:1115-1160`, with correct position compensation
(`anchor.ts:57-75`). It may sit outside the layer bounds. **Invariant 2 is
satisfied.**

## A4. Render pipeline

**The compositor is GPU** — `@motion/renderer` over a WebGL2 backend by
default, WebGPU when available, Null for headless
(`src/core/rendering/MotionRendererBackend.ts:1-13`). The Canvas2D backend was
**deleted**; Canvas2D survives only as a *rasterizer* that bakes shapes/text/
un-shaderable effects into textures the GPU then draws
(`src/core/effects/effectBake.ts:1-18`).

Graph-level pass order (`packages/renderer/src/rendergraph/passes/index.ts:32-41`):

```js
graph
  .addPass(new ClearPass())
  .addPass(new BackgroundPass())
  .addPass(new CompositionPass())   // shapes / images / text
  .addPass(new SelectionPass())
  .addPass(new OverlayPass())
  .addPass(new MaskPass())
  .addPass(new EffectPass());
// "Pass order is *derived* from each pass's after/reads/writes by the graph,
//  not from this insertion order."
```

Per-layer order of operations is **not documented anywhere in code** and has to
be reconstructed from `buildSnapshot` → `snapshotToFrameScene`. As built it is
approximately:

```
sample animation at layer time → resolve props → CPU-bake (content + mask +
un-shaderable effects) → GPU: mask → colour matrix / LUT / spatial effects →
transform → blend (incl. advanced blend via backdrop) → matte
```

**Invariant 3 is not met.** There is no single place that states the order, no
`Layer Styles` stage at all (see A5), and the mask is applied both on the CPU
bake path *and* as a GPU pass depending on `needsShapeRaster`
(`snapshotToFrameScene.ts:279-307`).

## A5. Existing styling — and one dead feature

Styling that exists and renders:

* Multi-fill stack, solid/linear/radial, multi-stop, per-stop alpha via 8-digit
  hex (`fill.ts`). Angle, centre and radius are animatable
  (`fillAngle`, `fillCenterX/Y`, `fillRadius` tracks, `App.tsx:263-271`).
* Multi-stroke stack: width, opacity, align (inside/center/outside), dash
  array, cap, join, optional gradient paint (`stroke.ts:25-40`).
* 17 blend modes (`blendMode.ts`) — more than the brief's twelve; the extras
  are `add`, `hard-light`, `soft-light`.
* Corner radius, opacity, **backdrop blur** (real, blurs what's behind).
* 16 composed style presets (`stylePresets.ts:84`).

**Layer styles are rendered nowhere.** This is the most serious functional
finding in the audit.

`layerStylesToFilter` (`src/core/effects/layerStyles.ts:57`) compiles drop
shadow and outer glow into a CSS `filter` string. That string is joined into
`RenderLayer.filter` at `buildSnapshot.ts:765-768`. And then:

```ts
// src/core/rendering/snapshotToFrameScene.ts:15
//   • RenderLayer.filter (a CSS string) is NOT read here — it only ever fed the
//     deleted Canvas2D backend. Everything spatial (user effects, DOF blur,
//     light-cast shadows) arrives as structured `layer.effects` entries, which
//     extractSpatialEffects routes through the GPU effect passes.
```

Layer styles are **not** in `layer.effects` — that list is built solely from
`readNodeRenderEffects(node)` (the effect stack) at `buildSnapshot.ts:761,1083`.
`applyEffectChain` also takes structured effects, not the filter string
(`effectBake.ts:46-52`). Grepping `packages/renderer/src` for `dropShadow` or
`outerGlow` returns nothing.

Consequence: the Drop Shadow and Outer Glow controls in the Effects panel do
nothing, and **9 of the 16 style presets are partly inert** — Glass, Soft UI,
Input Field, Gradient Card, Neon, Sticker, Chrome, Glow Text and Long Shadow
all specify `styles: () => ({ dropShadow … outerGlow … })`. Their fills and
strokes land; their depth does not. This has to be confirmed with a
golden-frame render test before it is fixed (`packages/render-tests` exists and
is the right instrument), because the fix necessarily changes existing render
output.

Missing versus the appendix: inner shadow, inner glow, bevel & emboss, satin,
colour overlay, gradient overlay, stroke-as-style, **global light**,
**fill opacity vs opacity**, and per-style blend modes.

## A6. Selection UI

**Where it is computed:**

* Per-node local box → `readGeometry` (`src/core/workspace/geometry.ts:106`).
* World box → `worldBounds` = `Rect.transform(localBounds, worldMatrix)`
  (`geometry.ts:245-247`) — this is an **axis-aligned** transform of the corners,
  i.e. the rotated box's AABB.
* Selection box → union of those AABBs
  (`SelectionController.selectionBounds`, `packages/workspace/src/selection/SelectionController.ts:120-126`).
* Screen conversion + handle list → `Workspace.buildOverlay`
  (`packages/workspace/src/Workspace.ts:568-606`).

**Where it is drawn:** `src/layout/Workspace/useWorkspace.ts:1561-1603`, on a
2D overlay canvas in screen space.

```js
// useWorkspace.ts:1561
if (!isActivelyDrawing && overlay.selectionBounds) {
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = sel3D ? 1 : 1.5;
  …
  strokeRect(ctx, overlay.selectionBounds);
}
// useWorkspace.ts:1571 — handles
} else {
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1.5;
  ctx.fillRect(h.position.x - 4, h.position.y - 4, 8, 8);
  ctx.strokeRect(h.position.x - 4, h.position.y - 4, 8, 8);
}
```

**Text measurement — verbatim.** `src/core/text/measureText.ts:147-191`:

```js
export function measureTextInkSize(s: MeasuredTextStyle): { w: number; h: number } | null {
  const g = measureCtx();
  if (!g) return null;
  …
  const style = s.fontStyle === 'italic' ? 'italic ' : '';
  g.font = `${style}${s.fontWeight} ${s.fontSize}px "${s.fontFamily}", Inter, system-ui, sans-serif`;
  const lines = s.content.split('\n');

  let widest = 0;
  let ascent = 0;
  let descent = 0;
  for (const line of lines) {
    const m = g.measureText(line);
    const chars = [...line].length;
    const spacing = chars > 0 ? (chars - 1) * s.letterSpacing : 0;
    const ink =
      typeof m.actualBoundingBoxLeft === 'number' && typeof m.actualBoundingBoxRight === 'number'
        ? m.actualBoundingBoxLeft + m.actualBoundingBoxRight
        : m.width;
    widest = Math.max(widest, ink + spacing);
    // textBaseline is 'middle' at draw time, so the metrics are already
    // measured from that same origin — no baseline conversion needed.
    if (typeof m.actualBoundingBoxAscent === 'number') ascent = Math.max(ascent, m.actualBoundingBoxAscent);
    if (typeof m.actualBoundingBoxDescent === 'number') descent = Math.max(descent, m.actualBoundingBoxDescent);
  }

  const lineHeightPx = s.fontSize * (s.lineHeight || DEFAULT_LINE_HEIGHT);
  const gap = lineHeightPx + s.paragraphSpacing;
  const glyphBand = ascent + descent > 0 ? ascent + descent : lineHeightPx;
  const height = (lines.length - 1) * gap + glyphBand;

  // Never report a box larger than the render box — the outline must stay
  // inside what the rasterizer actually produced.
  const render = measureTextSize(s);
  const out = {
    w: Math.max(8, Math.min(Math.ceil(widest), render?.w ?? Infinity)),
    h: Math.max(8, Math.min(Math.ceil(height), render?.h ?? Infinity)),
  };
  …
}
```

### The measurement bug — root cause found

The comment at line 170-171 is **wrong**, and it is the bug.

`measureText()` returns `actualBoundingBoxAscent/Descent` relative to **the
measuring context's own `textBaseline`**. The shared measure context
(`measureText.ts:26-33`) never sets `textBaseline`, so it is `'alphabetic'`.
The *drawing* context sets `textBaseline = 'middle'`
(`Canvas2DVectorRasterizer.ts:205`) and draws each line at `height/2`
(`Canvas2DVectorRasterizer.ts:200-224`).

The **height** is still right — `ascent + descent` is the ink band's total
extent regardless of which origin it was measured from. What is wrong is the
**vertical placement**: `measureTextInkSize` returns only `{w, h}`, and every
consumer treats the ink box as *concentric* with the layer origin
(`geometry.ts:179-198` sets `offsetX = offsetY = 0`; the docblock at
`measureText.ts:139-144` states the concentric assumption explicitly).

The ink band is **not** centred on the `'middle'` origin. For a typical face,
em-middle sits ≈0.3em above the baseline while caps reach ≈0.72em:

* `HELLO` → ascent ≈ 0.72em, descent ≈ 0 → box half-height 0.36em → top edge at
  0.66em above baseline. **Caps overshoot the top by ≈0.06em.** Exactly the
  reported symptom.
* `Hpqjy` → ascent ≈ 0.72em, descent ≈ 0.21em → half-height 0.465em → bottom
  edge at 0.165em below baseline while descenders reach 0.21em.
  **Descenders overshoot the bottom.**

The brief's diagnosis #1 (baseline/top confusion) is correct in substance; the
specific form here is *baseline-origin metrics interpreted as centre-origin*.

Four secondary defects in the same function:

1. **Box resizes on every keystroke** (`ink`, not `font`, metrics) — the brief
   explicitly calls this out as reading broken. AE uses font metrics so `HELLO`
   and `Hello` get identical heights.
2. **No `document.fonts.ready` await.** Results are cached permanently in a
   500-entry map keyed by style (`measureText.ts:35-36, 188-189`), so a
   measurement taken against the fallback font before the webfont loads is
   cached and never re-measured.
3. **Stroke is not accounted for.** A text stroke should extend the box by
   `strokeWidth / 2` on every side; nothing here reads stroke.
4. **`actualBoundingBoxLeft` is summed, not subtracted-then-spanned.** The code
   does `left + right` for width, which happens to be right for the span but
   there is no left offset returned, so an italic/script overhang shifts the ink
   band horizontally off-centre with no correction.

## A7. Effects

**30 effect types** (`src/core/effects/effects.ts`, `EffectType` union):

blur, glow, drop-shadow, brightness, contrast, saturate, grayscale, sepia,
hue-rotate, hue-saturation, invert, levels, curves, posterize, tint,
channel-mixer, gradient-ramp, fractal-noise, displacement-map, motion-tile,
fill, four-color-gradient, stroke, beam, sharpen, noise, keylight, wave-warp,
turbulent-displace, echo.

Against the brief's baseline, missing: **directional blur, linear wipe,
transform, posterize time**. (Gaussian blur = `blur`; drop shadow, glow, fill,
tint, levels, hue/saturation, brightness & contrast, gradient ramp, fractal
noise, echo all present.)

* **Where parameters are exposed:** a dedicated `EffectsPanel`
  (`src/layout/Effects/EffectsPanel.tsx`), docked as its own panel
  (`DemoPanels.tsx:2016`) — **not** crammed into the timeline. Each effect is a
  collapsible card with an enable checkbox, up/down, and remove
  (`EffectStack.tsx:270-335`).
* **Reorderable:** yes, but by **arrow buttons only** (`EffectStack.tsx:308-325`).
  No drag, no drop indicator.
* **Individually keyframeable:** yes, every numeric and colour param
  (`EffectStack.tsx:189-211`, `:69-100`).
* **Individually disableable:** yes (`EffectStack.tsx:282-287`), plus a
  layer-wide `fx` switch (`SceneGraph.ts:449`).
* **Searchable browser:** yes — text filter + categorised accordion
  (`EffectsPanel.tsx:58-59, 153-160`), and effects can be dragged from the
  browser onto a layer (`EffectsPanel.tsx:119`).
* **Copy between layers:** **no.** No `copyEffects`/`pasteEffects` anywhere.
* **Effect presets:** **no.** No save/reuse of a configured effect or stack.

---

# Part B — Quality benchmark

## Keyframes

| Question | Answer | Evidence |
|---|---|---|
| Temporal and spatial interpolation stored separately? | **Yes** for scalar tracks | `packages/animation/src/types.ts:28-53` — `easing`/`bezier` (temporal) vs `si`/`so` (spatial, value-space offsets), explicitly documented as independent at `:41-49` |
| Graph editor? | **Yes** | `src/layout/Timeline/GraphEditor.tsx:123` |
| Value graph **and** speed graph? | **Partial** | `GraphEditor.tsx:133` has both modes, but speed is read-only vertically (`:6-8`) — you cannot shape timing by dragging the speed curve, which is half of why AE's speed graph exists |
| Draggable bezier handles with adjustable influence? | **Yes** | `GraphEditor.tsx:9-11`, `AnimationEngine.setBezier` (`AnimationEngine.ts:278`); influence = handle x, freely draggable |
| Easy-ease / in / out presets on a shortcut? | **Yes** | `src/App.tsx:977-979` — F9 / Shift+F9 / Ctrl+Shift+F9 |
| Hold keyframes? | **Yes** | `types.ts:21`, rendered as a square (`Timeline.module.css:319-322`) |
| Keyframe icon encodes interpolation type? | **Partial → poor** | Only 3 states: diamond / circle (roving) / square (hold), `Timeline.module.css:293-325`. `TimelineKeyframeRef` carries only `roving` and `isHold` (`TimelineModel.ts:32-37`), so **linear, bezier, easeIn, easeOut and auto-bezier are all the same diamond**, and split in/out is not representable |
| Multi-select, box-select, drag together? | **Yes** | `src/layout/Timeline/marqueeSelection.ts:86-110`; group drag at `Timeline.tsx:786-790` |
| Copy/paste across properties and layers? | **Partial** | `src/core/animation/keyframeClipboard.ts:66-88` — pastes onto **every selected layer**, but always onto the *same prop name*. Cross-**property** paste (copy Position → paste onto Scale) is not possible |
| Keyframe navigator per property? | **Yes** in the timeline | `Timeline.tsx:1953-2000` — stopwatch + ◀ ◆ ▶, diamond filled when the playhead is on a key. **Absent in the inspector** (`TransformSection.tsx:145-161` has a bare checkbox) |
| Time-reverse keyframes? | **Yes** | `src/core/animation/keyframeAssistants.ts:99` |
| Snap to playhead / frames / other keyframes? | **Frames only** | `Timeline.tsx:783-790` snaps to `1/fps` (Alt frees it). No playhead snap, no keyframe-to-keyframe snap |

## Motion

| Question | Answer | Evidence |
|---|---|---|
| Motion path drawn with editable spatial tangents? | **Yes** | drawn `useWorkspace.ts:2016-2070`; tangent hit-test `:1786`; `setPathTangent` `src/core/motion/motionPath.ts:193` |
| Motion blur, per-layer, with comp shutter angle and phase? | **Yes** | `src/core/effects/motionBlur.ts:18-28` (angle, phase, samples, adaptive limit); per-layer switch `SceneGraph.ts:443` |
| Time remapping? | **Yes** | `timeRemap` track sampled at `buildSnapshot.ts:360-367`; UI `PrecompControl.tsx:25-41` |
| Time stretch? | **Yes** | `src/core/scene/layerTime.ts:18-30` (stretch, reverse, freeze, frame blend) |
| Roving keyframes? | **Yes** | `types.ts:38-40`, `AnimationEngine.setRoving` (`:332`), `applyRoving` in `interpolate.ts` |

## Effects

| Question | Answer | Evidence |
|---|---|---|
| Dedicated panel, not the timeline? | **Yes** | `EffectsPanel.tsx`, `DemoPanels.tsx:2016` |
| Reorderable by drag? | **No** — buttons only | `EffectStack.tsx:308-325` |
| Independent enable toggle per effect? | **Yes** | `EffectStack.tsx:282-287` |
| Every parameter individually keyframeable? | **Yes** (numeric + colour) | `EffectStack.tsx:69-100, 189-211` |
| Copy effects between layers? | **No** | no such function exists |
| Searchable browser? | **Yes** | `EffectsPanel.tsx:58, 153-160` |
| Effect presets? | **No** | — |

Additional: effect params **do** show up as timeline rows once animated, but
with raw prop paths as labels (`effect.fx_3.radius`) because the label map at
`App.tsx:255-272` only covers transform and fill props.

## Animation / general

| Question | Answer | Evidence |
|---|---|---|
| Animation presets? | **Yes** — builtins + save/apply/delete | `src/core/animation/animationPresets.ts:174, 519-544` |
| Parenting? Null objects? | **Yes**, with world-preserving relink | `SceneGraph.setParent` (`:224-272`), `src/core/scene/parenting.ts`, `null` kind |
| Expressions / property linking? | **Yes** — a full expression language | `packages/animation/src/exprLang.ts`, `expressions.ts`; cycle + depth guards `AnimationEngine.ts:442-482`; `wiggle`, `loopOut`, `valueAtTime`, `layer(name, prop)`, `ctrl(name)`, `audio` |
| Properties searchable in the timeline? | **Yes** | `Timeline.tsx:307-346` filters tracks and properties by query |

## Property control UX

| Question | Answer | Evidence |
|---|---|---|
| Drag horizontally on the number to change it? | **Yes, everywhere** | `src/components/ValueField/ValueField.tsx:141-177`; 34 files use it; only 8 raw `type="number"` inputs remain and all are in dialogs (`OutputModuleDialog`, `DashboardPage`), not property rows |
| Modifier keys change granularity? | **Yes** | Shift = 10×, Alt = 0.1× (`ValueField.tsx:8`, `scrubMath.stepScale`) |
| Click to type an exact number? | **Yes**, plus math expressions (`960/2`, `*1.5`) | `ValueField.tsx:157-169`, `applyValueExpression` |
| Stopwatch in a consistent position? | **No — two different controls** | Timeline uses a real stopwatch icon left of the name (`Timeline.tsx:1953-1971`); the inspector uses a plain `Checkbox` (`TransformSection.tsx:145-161`, `EffectStack.tsx:216-221`). Same meaning, different affordance, different glyph |
| Visible reset per property / group? | **Partial** | Per-row reset only where a `resetVal` is passed (`TransformSection.tsx:189-198`); no group reset, no effect reset, no style reset |
| Right-click context menu on properties? | **No** | `onContextMenu` appears only twice in the timeline (`Timeline.tsx:2075, 2188`), on the ruler/lane, not on property rows or keyframes |
| Collapsible groups with consistent indentation? | **Partial** | Timeline has track → property with categories; the inspector uses sub-headers without disclosure triangles or indentation levels |
| Name and value in aligned columns? | **Partial** | `TransformSection.module.css:311-317` sets `min-width: 76px` on the label — a *minimum*, not a column, so rows with long names push their values out of alignment. The timeline's `propValues` is flex-packed, not columned |
| Scrub past the window edge? | **Partial** | `window` pointer listeners (`ValueField.tsx:175-177`) — works to the window edge, but no `setPointerCapture` and no pointer lock, so an infinite scrub is impossible and a drag that leaves the window can drop |

## Invariants

| Invariant | Status | Evidence |
|---|---|---|
| 1 — property is a track, not a value | **Partial.** True for scalars. False for gradient stops, path points and layer styles; no `Property<T>` object, no per-property type metadata | `dataTracks.ts:38-49` (no easing), `layerStyles.ts:19-38` (no track at all) |
| 2 — anchor exists, animatable, viewport-draggable, may leave bounds | **Met** | `anchor.ts:57`, `builtin.ts:1115-1160` |
| 3 — render order explicit and documented | **Not met** | order is emergent from `buildSnapshot` + `snapshotToFrameScene`; no layer-style stage exists |
| 4 — alignment is an operation | **Met** | `alignNodes.ts` writes `x`/`y` and forgets |
| 5 — rotation unwrapped | **Met** | `AngleDial.tsx:20` "unbounded — revolutions welcome" |

---

# Part C — Gap and quality table

> **HISTORICAL — this table records the state on 2026-07-27, before any work.**
> Almost every row has since changed. See **"Outcome"** at the end of this
> document for what actually happened to each item; the table below is kept
> as-written so the original reasoning stays auditable.

Ordered by what I'd fix first. `Status` is deliberately harsh.

| # | Item | Status | Evidence | Recommended action |
|---|---|---|---|---|
| 1 | **Layer styles render nothing** — drop shadow + outer glow compile to a CSS filter that no backend reads | **present-poor** (functionally missing) | `snapshotToFrameScene.ts:15-18`; `buildSnapshot.ts:765-768`; `layerStyles.ts:57` | Add a golden-frame render test first to confirm, then route layer styles into `layer.effects` as structured entries so they hit the GPU effect passes. **Changes existing render output — needs your sign-off + a migration note.** |
| 2 | **Text selection box mis-measures** — baseline-origin metrics treated as centre-origin | **present-poor** | `measureText.ts:170-173, 183-187`; `geometry.ts:179-198`; `Canvas2DVectorRasterizer.ts:205` | Return a full box (`top/bottom/left/right` + offset), switch the selection outline to **font** metrics (stable per font, not per string), keep ink metrics for auto-plates. Phase 1A. |
| 3 | **Selection box is a screen-aligned AABB** — a rotated layer gets a padded upright box | **present-poor** | `geometry.ts:245-247`; `SelectionController.ts:120-126` | Oriented box: carry the 4 transformed corners, draw as a polygon. Phase 1B. |
| 4 | **Multi-select draws one merged box** | **present-poor** | `SelectionController.ts:120-126` unions all rects | One box per selected layer. |
| 5 | **Scale/rotate pivot is the AABB centre, not the anchor** | **present-poor** | `builtin.ts:116-118` `transformPivot = R.center(startBounds)` | Pivot on the anchor (`RotateTool` at `:1095` already does — `SelectTool` doesn't). Keyframed rotation revolves around the anchor, so the gizmo must too. |
| 6 | **Rotation handle exists** — brief says it shouldn't | **present-adequate, wrong design** | `handles.ts:11, 39` | Remove; rotation becomes a tool mode (`RotateTool` already exists, `builtin.ts:1062`). Removes the dead zone. |
| 7 | **Anchor widget draws as a plain square** — indistinguishable from a resize handle | **present-poor** | handle `kind: 'anchor'` is pushed (`builtin.ts:75`) but the painter's switch has no case for it, so it falls to the default square (`useWorkspace.ts:1596-1602`) | Draw a crosshair/target glyph. |
| 8 | **1.5px outline, no small-size degradation, non-rotated cursors, no hover corner-marks** | **present-poor** | `useWorkspace.ts:1561-1603`; `handles.ts:44-61`; `Workspace.ts:594` draws the full hover box | Hairline 1px; hide mid-edge handles under ~40px and all under ~20px; rotate cursors by layer rotation; hover = corner marks only. |
| 9 | **Data tracks have no easing** — animated gradient stops, mask paths and shape paths are linear-only | **present-poor** | `dataTracks.ts:38-49, 212-227` | Give `DataKeyframe` the same `easing`/`bezier`/`hold` fields and remap `u` through the temporal curve. Small, high-leverage. |
| 10 | **Keyframe icon encodes only 3 of ~6 states** | **present-poor** | `Timeline.module.css:293-325`; `TimelineModel.ts:32-37` | Carry `easing` (and in/out separately) on `TimelineKeyframeRef`; add circle=auto-bezier, half-shapes for split in/out. |
| 11 | **Effect stack reorders by buttons, not drag** | **present-poor** | `EffectStack.tsx:308-325` | Drag-reorder with a drop indicator. Order is semantic — it must be obvious. |
| 12 | **Two different stopwatches** (icon in timeline, checkbox in inspector) | **present-poor** | `Timeline.tsx:1953-1971` vs `TransformSection.tsx:145-161`, `EffectStack.tsx:216-221` | One shared `PropertyRow` component. This is the single biggest consistency win. |
| 13 | **No keyframe navigator in the inspector** | **present-poor** | `TransformSection.tsx:145-198` | Same shared row. |
| 14 | **Name/value columns not aligned** | **present-poor** | `TransformSection.module.css:302-317` (`min-width`, not a grid) | CSS grid with a fixed name column. |
| 15 | **No right-click menus on properties or keyframes** | **missing** | `onContextMenu` only at `Timeline.tsx:2075, 2188` | Keyframe menu (interpolation, easy ease, toggle hold, copy, delete); property menu (reset, remove animation, add expression). |
| 16 | **Keyframes snap only to frames** | **partial** | `Timeline.tsx:783-790` | Add playhead and neighbour-keyframe snap with a visible snap line. |
| 17 | **Speed graph is read-only vertically** | **partial** | `GraphEditor.tsx:6-8` | Make speed draggable (it maps back to handle influence). |
| 18 | **Effects can't be copied between layers; no effect presets** | **missing** | — | Both are small given the effect model is plain JSON. |
| 19 | **Skew / skew axis absent from layer transform** | **missing** | only in `textAnimators.ts:128`; dead field `worldTransform.ts:35` | Add as animatable transform props, or decide explicitly not to (the brief warns against AE's half-implementation). |
| 20 | **Layer styles: 7 of 9 missing, plus global light and fill opacity** | **missing** | `layerStyles.ts:35-38` has 2 | After #1. |
| 21 | **Mask modes: 3 of 6** | **partial** | `mask.ts` `MaskMode = 'add' \| 'subtract' \| 'intersect'` | Add lighten / darken / difference. Track mattes are already complete (4 types, `matte.ts:19`). |
| 22 | **Gradient has no independent opacity-stop list** | **partial** | `fill.ts:22-30` — alpha rides in the hex | AE/Photoshop keep colour and opacity stops as separate lists; the editor UI should too. |
| 23 | **Point vs paragraph text not distinguished** | **missing** | text size is always measured from content (`geometry.ts:179-198`) | Needed for Phase 1C; paragraph text reflows instead of scaling. |
| 24 | **No `document.fonts.ready` await; measurements cached forever** | **present-poor** | `measureText.ts:26-36, 188-189` | Await font load, or key the cache on `document.fonts.status`. Classic confusing failure. |
| 25 | **Text stroke not in the selection box** | **missing** | `measureTextInkSize` never reads stroke | Add `strokeWidth / 2` on every side. |
| 26 | **Expression controls: slider only** | **partial** | `expressionControls.ts:22` `ctrl_<name>` numeric only | Add angle, colour, point, checkbox, dropdown, layer controls. |
| 27 | **4 effects missing vs baseline** — directional blur, linear wipe, transform, posterize time | **missing** | `effects.ts` `EffectType` union | Cheap; the effect framework is good. |
| 28 | **No real property groups / no `Property<T>` metadata** | **present-poor** | flat `Map<prop, Track>` (`AnimationEngine.ts:74`); labels via a 17-deep ternary (`App.tsx:255-272`) | A property **registry** (name → type, unit, min, max, precision, group, label) that every surface reads. This is the restructuring called out below. |
| 29 | `SceneGraph.computeWorldTransforms` is dead code and returns `scale: {1,1}` unconditionally | **present-poor** | `SceneGraph.ts:126-138, 555-579` — the only live `computeWorldTransforms` is the rig one | Delete it. It is a trap for the next person. |
| 30 | Effect params show raw prop paths in the timeline (`effect.fx_3.radius`) | **present-poor** | `App.tsx:255-272` label map covers transform/fill only | Falls out of #28 for free. |

---

## Recommended order — and where it differs from the brief

The brief's Phases 3→4→5 assume the styling layer is the big gap. It isn't.
Here is what I'd actually do, and why.

**Step 0 (before anything): the property registry — #28.**
The brief puts control UX in Phase 3 and treats it as a per-surface polish job.
That is the expensive way to do it. Right now the *same* property is described
independently in at least four places: the inspector row, the timeline row, the
effect row, and the label/unit lookup tables in `App.tsx`. Every item in
#10, #12, #13, #14, #15 and #30 is a symptom of that, and each would have to be
fixed 4× without a registry and 1× with one. It is roughly a day, and it is the
difference between Phase 3 being a week and being three.

I would **not** convert existing values to `Property<T>` objects wholesale —
the scalar `AnimationEngine` is genuinely good and rewriting it would risk
everything that already works. The registry is *metadata beside* the engine,
not a replacement for it.

**Step 1 — #1, the dead layer styles.** It is the only finding where a shipped,
documented, UI-complete feature produces no pixels. It also invalidates 9 of
16 style presets, so users are seeing broken output today. Needs a render test
and your sign-off first because it changes existing render output.

**Step 2 — Phase 1 (selection UI): #2 → #8.** As the brief says: isolated,
testable, all acceptance criteria mechanically checkable. I'd land it as three
reviewable changes — measurement (#2, #24, #25), oriented/per-layer box (#3,
#4), gizmo behaviour and chrome (#5, #6, #7, #8).

**Step 3 — Phase 3 control UX, now cheap:** #12, #13, #14, #15, #11, #30 — all
downstream of the registry.

**Step 4 — the remaining `present-poor` keyframe work:** #9 (data-track
easing), #10 (icon encoding), #16 (snapping), #17 (speed graph).

**Step 5 — genuine new capability, in this order:** #18 (effect copy/presets —
smallest win/effort ratio in the list), #21, #22, #27, then #20 (the seven
missing layer styles + global light + fill opacity, which is the largest single
block of work here), then #19 and #23 and #26.

**What I would deliberately *not* build:** trim paths, repeater, parenting,
nulls, precomp, adjustment layers, motion blur, time remap/stretch, mattes,
text animators, animation presets, expressions. All present and working.

---

## Things that need restructuring — flagging rather than starting

1. **The `fx` component is a 25-key grab bag** (`SceneGraph.ts:398-548`). Every
   new feature adds another `setX` method and another untyped key. Layer
   styles, masks, mattes, trim, repeater, fills and strokes all live there as
   opaque blobs, which is precisely why none of them can be keyframed
   generically. Turning it into typed, addressable property groups is the
   correct fix and it is a large change touching serialization, history,
   autosave and export. **I have not started it.** The property registry
   (Step 0) is the cheap 80% and does not require it.

2. **Per-layer render order is not expressed anywhere** (Invariant 3). Fixing
   #1 forces a decision about where layer styles sit in that order, which means
   writing the order down for the first time. That is a design decision, not a
   mechanical one.

## Open questions I need answered before Phase 5

The brief flags three; here they are with my recommendation.

1. **Should shadows scale with the layer?** My recommendation: implement layer
   styles *after* transform (so a shadow does **not** scale/rotate with the
   layer), matching Photoshop/AE, and keep the existing `drop-shadow` **effect**
   as the before-transform variant. That gives both behaviours without the
   confusing duplicate the appendix warns about — the distinction becomes
   "effect vs style", which users already understand.

2. **Does removing stored alignment break saved projects?** Not applicable —
   alignment is already an operation, never stored (`alignNodes.ts`). No action.

3. **What happens to non-animatable property values during conversion to
   tracks?** My recommendation: nothing. Keep base values where they are and
   let a track *shadow* the base when it exists — this is already exactly how
   `AnimationEngine.sample` behaves (`AnimationEngine.ts:478`, falls back to
   `baseValueProvider`). No migration, no risk to existing documents.

One more I need from you:

4. **The layer-styles fix (#1) changes how existing projects render** — any
   project using Glass, Neon, Sticker, Long Shadow etc. will suddenly gain the
   shadows and glows those presets always specified. Is that "fixing a bug" or
   "breaking existing work"? I'd call it the former, but it's your call, and it
   determines whether we need a per-document opt-in flag.

---

**Stop condition reached. No code written. Awaiting review.**

---

# Outcome — what happened to each item

Current as of the end of the engagement. The gap table in Part C is the
*before* picture; this is the *after*. Item numbers match that table.

## Fixed

| # | Item | What was done |
|---|---|---|
| 1 | Layer styles rendered nothing | Compiled to structured effects (`layerStylesToEffects`) and appended after the layer's own stack, so they reach the GPU effect chain. Nine of sixteen style presets got their depth back. |
| 2 | Text selection box mis-measured | Root cause was baseline-origin metrics read as centre-origin — the measuring context defaulted to `'alphabetic'` while the rasterizer draws `'middle'`. Measurement now returns a full box with an explicit origin, uses **font** metrics for the outline (stable while typing), awaits `document.fonts.ready`, and floors the render box so glyphs are never clipped. |
| 3 | Selection box was a screen-aligned AABB | Oriented box via `math/OrientedBox.ts`; corners projected individually. |
| 4 | Multi-select drew one merged box | One box per selected layer. |
| 5 | Scale/rotate pivoted on the AABB centre | Pivots on the **anchor**, so a handle drag and a keyframed change of the same magnitude agree. Verified against the renderer's own placement formula. |
| 6 | Rotation handle existed | Removed; rotation is a tool mode (`RotateTool`), which also removes the dead zone. |
| 7 | Anchor drew as a plain square | Crosshair widget with a dark halo. |
| 8 | Chrome: 1.5px outline, no degradation, static cursors, full hover box | Hairline 1px; mid-edge handles hidden under ~40px and all under ~20px (filtered in `getHandles` **and** `pickHandle`, so hidden grips are not invisible hit targets); cursors rotate with the layer; hover shows corner marks only. |
| 9 | Data tracks had no easing | `DataKeyframe` carries the same `easing`/`bezier` as scalar keyframes; gradients, mask outlines and baked paths can be eased. Easing survives snapshot/restore — four copy sites were dropping it. |
| 10 | Keyframe icon encoded 3 of ~6 states | Two-half SVG glyph: diamond/hourglass/circle/square per side, so "eased in, hold out" is visible at a glance. |
| 11 | Effect stack reordered by buttons | Drag-reorder with a gap drop-indicator; header is the drag handle so it does not fight the scrubby sliders in the body. |
| 12 | Two different stopwatches | One shared `PropertyRow` / `StopwatchButton` / `KeyframeNavigator`, used by the inspector, the effect stack and the timeline. |
| 13 | No keyframe navigator in the inspector | Present on every animatable row; its column is reserved even when hidden so enabling animation does not shift the row. |
| 14 | Name/value columns not aligned | Real CSS grid. Measured before: values at x=107 on nine rows, x=131 on Rotation. After: single column, uniform 58px fields, consistent 26px rows. |
| 15 | No property context menus | `buildPropertyMenu`, state-aware. (Keyframe menus already existed in `App.tsx` — the audit missed them; my duplicate was deleted rather than shipped.) |
| 16 | Keyframes snapped only to frames | Playhead → other keyframes → frame grid, threshold in **pixels** so it is zoom-independent; a multi-keyframe drag snaps as one body and keeps its internal spacing. Snap indicator line. |
| 17 | Speed graph read-only vertically | Vertical drag solves the segment bezier for the requested speed, holding influence. Verified against the engine's own sampled derivative. |
| 18 | No effect copy/paste or presets | Both, with fresh ids on paste (ids key keyframe paths and per-effect caching) and keyframed params carried across. |
| 19 | No skew | `skew` + `skewAxis`, folded into the model matrix as `T·R·Skew·Scale`. |
| 20 | 7 of 9 layer styles missing | All nine render. Colour/gradient overlay and stroke mapped to existing effects; inner shadow, inner glow and satin via a new **interior** compositing primitive; bevel via an alpha height field lit by the global light. |
| 21 | Mask modes: 3 of 6 | Added lighten, darken, difference. `maskModeStartsFull` replaces a `mode !== 'add'` check that would have been wrong for lighten. |
| 22 | Gradients had no opacity stops | Independent opacity-stop list, merged with colour stops at render. |
| 23 | Point vs paragraph text | `boxWidth` makes a text layer paragraph text: content wraps inside the authored box and a handle drag reflows at the same font size. |
| 24 | No `fonts.ready`; permanent cache | Awaited, plus a `loadingdone` listener that clears the caches. |
| 25 | Text stroke not in the selection box | `measureTextBoxes(style, strokeWidth)` inflates every side by half the stroke, so a heavily-stroked word is no longer selected inside its own outline. |
| 26 | Expression controls: slider only | Seven kinds. Every kind still resolves as a number through `ctrl()`; colour is three numeric controls, matching how colours keyframe elsewhere. |
| 27 | 4 effects missing vs baseline | Directional blur, linear wipe, transform, posterize time. |
| 28 | No property registry | `core/inspector/propertyMeta.ts`, read by every surface. The 17-deep label ternary, `UNIT_FOR_PROP`, `UNIT_OF`, `DATA_LABELS` and `groupOf` are gone. |
| 29 | Dead `computeWorldTransforms` | Deleted, with a comment where it was explaining the trap. |
| 30 | Effect params showed raw paths | Resolved through the effect definition — "Glow Radius", not `effect.fx_3.radius`. |
| — | Fill opacity vs opacity | "Render twice" (design option 1): styles generated at full alpha, contents subtracted back in proportion. Fill 0 + drop shadow leaves a floating shadow, verified. |
| — | Global light | Comp-wide angle + altitude that styles opt into. This is what makes a layer *style* different from the equivalent *effect*, and the reason both drop-shadow variants were kept. |
| — | Invariant 3 (render order) | Written down in `CompositionPass`, including the finding that effects run **after** transform — which the original audit got wrong. |

## Not fixed — deliberate, with reasons

| Item | Why |
|---|---|
| **Bevel costs 101 ms/frame at 1080p** | The pass is correct but expensive; buffer traffic, not arithmetic. A reduced-resolution buffer was tried and reverted (flat shading). Options in the Performance addendum; a shader is the right answer. |
| **Interior styles fade under fill opacity** | Photoshop keeps them at full strength. Correct behaviour needs design option 2 (separate contents-alpha and style-alpha through the chain), which was considered and not chosen. |
| **Pre/post-transform inconsistency** | Nine CPU-baked effects scale with the layer; the rest do not. Documented rather than changed — fixing it alters existing renders. |
| **The `fx` grab-bag** | One component, ~25 untyped keys. The real reason layer styles could not be keyframed generically. Flagged as a restructure and deliberately not started; the property registry was the cheap 80%. |
| **Skew does not affect the selection box** | The oriented box is built from position/rotation/scale in `core/workspace/ports.ts`. |
| **Cross-property keyframe paste** | Keyframes paste across layers, not across properties (Position → Scale). |
| **Gradient opacity stops are not keyframeable** | Colour stops animate via the `fill.stops` data track; the opacity list has no track. |
| **No per-group reset** | Reset exists per property only. |
| **SVG import spec unreviewed** | The `svg` layer kind already exists, so that spec likely needs the same reality-check this brief got. |

## Unverified

* **Keyframe glyphs in the live timeline DOM.** Classification, geometry and
  model wiring are tested; the rendered diamonds were never seen on screen,
  because the timeline could not be driven into a state showing keyframe rows.
* **The four requested screenshots** (inspector, effect controls, timeline with
  a keyframed property, selected text layer). The app is now reachable — the
  auth store can be set from the console with no code change — but the Browser
  pane was intermittently unavailable. Column alignment was verified by
  measurement instead, which is stronger for that question and useless for
  judging visual weight.

## Testing note

Some pixel-level tests **skip under jsdom**, which has no canvas: the interior
styles, fill opacity, and the paragraph-text reflow assertions. They were
executed in real Chromium and their results are recorded in the session, but a
green CI run does not cover them. Anything that touches
`canvas2dEffects.ts`, `effectBake.ts` or text measurement should be re-checked
in a browser, not just against the suite.

---

# Addendum — Performance (2026-07-27)

Requested in the Phase 0 review: order-of-magnitude costs and a list of cache
invalidation triggers, enough to know whether anything below is about to make
things worse. Measured in Chromium against the running app, not estimated.

## Snapshot construction

`buildSnapshot` + `snapshotToFrameScene` are the per-frame CPU cost before the
GPU sees anything. Median of 30 calls:

| Scene | ms/frame |
|---|---|
| ~2 layers (seeded scene) | 0.05 |
| 40 layers | 1.46 |
| 40 layers + 20 effects | 1.10 |
| 40 animated layers, scrubbing | 1.58 |
| `snapshotToFrameScene` (40 layers) | 0.60 |

**Verdict: not a bottleneck.** ~2 ms total for the review's stated target of 40
layers and 10 effects leaves the whole 16.7 ms frame budget to the GPU. The
per-frame work is linear in layer count with no visible super-linear term, and
scrubbing costs the same as static rendering — the animation engine's sampling
is not a hot spot.

## Per-layer effect passes

The CPU-baked effects are the expensive ones, because they are JavaScript pixel
passes rather than shaders. Cost per pass, per layer, at the layer's own size:

| Effect | 512×512 | 1920×1080 |
|---|---|---|
| linear wipe | — | 0.01 |
| satin | 0.29 | 0.18 |
| directional blur | — | 0.21 |
| inner glow | — | 0.66 |
| inner shadow | 0.14 | 0.93 |
| stroke | — | 1.31 |
| **bevel & emboss** | **21.6** | **101** |

Everything except bevel is sub-millisecond and irrelevant. **Bevel is a real
problem**: 101 ms at 1920×1080 and 386 ms at 4K, i.e. a full-frame bevel alone
blows the frame budget by 6× at 1080p.

Why: it is the only per-pixel pass with a lighting model, and the cost is
dominated not by the arithmetic but by buffer traffic — two `getImageData`, two
`createImageData` and two `putImageData` over 8 MB buffers, ~48 MB per frame.
Tightening the inner loop (typed-array height field, no per-pixel closure, no
bounds-check helper) moved 121 ms → 101 ms, confirming the loop was not the
bottleneck.

**A reduced-resolution working buffer was tried and reverted.** Computing the
shading on a 640-px-capped buffer took 1080p to 10 ms and made the cost
resolution-independent (4K also 10 ms) — but the shading came out FLAT. The
gradient is measured in working pixels, so downscaling steepens it, and
compensating is not simply a factor of the scale factor. A controlled
comparison (640×360 undownscaled vs 1280×720 downscaled, identical relative
geometry) showed the undownscaled profile varying 126→117 while the downscaled
one stayed at a flat 128. It is reverted rather than shipped half-verified.

Options, cheapest first:
1. **Cap the working buffer AND re-derive the depth compensation empirically** —
   the approach is right, the scale relationship needs deriving rather than
   guessing. Probably an afternoon with the profile comparison above as the gate.
2. **Move it to a shader.** It is a gradient-and-dot-product — the single most
   shader-shaped thing in the effect list — which would also remove it from the
   CPU-bake path entirely.
3. **Leave it and document.** Bevel is usually applied to text and logos, not
   full-frame solids; at 512×512 it is 21 ms, which is survivable for a
   non-realtime preview.

I would do (2) when the effect chain next gets shader work, and (3) until then.

## Backdrop blur

Asked for by name. It is not a per-layer pass — `backdropBlur` is a prop the
GPU pipeline consumes, so it costs a blur of the backdrop region rather than a
JavaScript pixel pass, and it did not register against the snapshot timings
above. No action.

## Cache invalidation

`viewportFrameCache` (`core/rendering/frameCache.ts`) keys rendered frames. It
is invalidated by:

* **`bumpScene()`** — every scene-graph write. The coarsest and most frequent
  trigger; a single prop write drops the whole cache.
* **`AnimationChanged`** — every keyframe mutation, via the engine's change
  listener. `AnimationEngine.batch()` exists specifically to collapse bulk
  writes into one notification (added when an animated-SVG import fired it
  per-track and froze the app).
* **`compKeyFor(...)`** — composition size, fps, duration, background, start
  frame, background paint, and now the **global light**. A field missing from
  this key is a field whose edits do not repaint; that is why global light was
  added to it in the same change that introduced it.
* **Selection / focus changes**, which alter overlay and ghosting.

The thing to watch: `bumpScene()` is all-or-nothing. Nothing in this session made
that worse, but any future per-frame writer into the scene graph would defeat
the cache entirely.

## Things this session did NOT measure

* GPU-side frame time (the render graph's own passes).
* Memory under long scrub sessions.
* The 3D/extrusion path, which has its own per-face costs.
