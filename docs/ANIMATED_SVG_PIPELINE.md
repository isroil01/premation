# Animated SVG: The Complete Pipeline

**From file upload to pixels on screen — every stage, every file, every design decision.**

Last updated: 2026-07-27. Covers the import architecture after the three fix rounds
(CSS animation support, keyframe-cost overhaul, and the O(N²) freeze fix).

---

## 0. The one-paragraph version

An uploaded SVG lives in the **asset library** as a raw file behind an object URL — the
grid thumbnail is a real `<img>`, so the browser plays any animation in it for free.
Clicking **Add** runs `insertMedia`, which parses the SVG into vector shapes, translates
its animation (SMIL **and** CSS `@keyframes`) into a small set of real keyframes by
*sampling the animated transform matrix* and diffing it against the static one, then
writes those shapes as scene layers with keyframe tracks on the animation engine — one
bulk write, one change notification. From then on the SVG is not special at all: it is
ordinary shape layers with ordinary tracks, sampled per frame by `buildSnapshot`,
compiled to a `FrameScene`, and drawn by the GPU backend (WebGPU primary, WebGL2
fallback). A spinning loader is two rotation keyframes plus a `loopOut('cycle')`
expression; a line that draws itself is a trim-path track — the same machinery After
Effects calls Trim Paths.

```
Upload                    Add to scene                        Every frame
──────                    ────────────                        ───────────
File ─→ assetStore ─→ <img> preview      insertMedia
        (object URL)                        │ readSvgText (fetch)
                                            │ parseSvgToShapes ──┐
                                            │   svgParser        │ shapes + per-shape
                                            │   svgAnimation     │ keyframe tracks
                                            │   svgCss           │
                                            │ route: vector? ────┘
                                            ▼
                                     insertSvgShapeGroup
                                        │ group + shape nodes → SceneGraph
                                        │ tracks → AnimationEngine (batched)
                                        │ loopOut / trim config
                                        ▼
                                     bumpScene ──→ UI revision, lazy hit-test
                                                          │
                        buildSnapshot(graph, anim, t) ◄───┘  (per frame)
                                │ evaluateNode per layer (keyframes + expressions)
                                ▼
                        RenderSnapshot ─→ snapshotToFrameScene ─→ GPU backend
```

---

## 1. Upload: the asset library (`src/stores/assetStore.ts`)

When files are dropped or picked in the **Assets** tab (`src/layout/EditorLayout/DemoPanels.tsx`):

- `addAsset` / `addAssetsBatch` create an `ImportedAsset` record per file:
  `{ id, name, type: 'image' | 'video' | 'audio', src, folderId, metadata }`.
- `src` is a **blob object URL** (`URL.createObjectURL(file)`) — the raw file bytes,
  untouched. Nothing is parsed at upload time.
- Folder structure, thumbnails and cloud sync are handled here too, but none of it
  matters to the SVG pipeline: the asset is just a named pointer to the original file.

**Why the thumbnail animates:** the Assets grid renders each image asset with a plain
`<img src={asset.src}>`. The browser's own SVG engine plays SMIL and CSS animation
inside an `<img>` natively. This is why "it animates in the assets tab" proves
*nothing* about whether the importer understands the file — the grid never parses it.

## 2. Add to scene: routing (`src/core/scene/sceneInsert.ts` → `insertMedia`)

Clicking **Add** (or dropping onto the canvas in `src/layout/Workspace/Workspace.tsx`)
calls `insertMedia(asset)`. For an SVG asset (detected by file extension — object URLs
carry no MIME type) the routing decision tree is:

```
readSvgText(asset.src)            ── fetch the blob URL, get the markup
  │
parseSvgToShapes(svg, { maxDurationSeconds: comp.durationSeconds })
  │                               ── ONE parse; result reused by the insert
  ├─ convertible = shapes.some(s => s.animation)
  ├─ simple      = isSimpleSvg(svg)        (no filters/masks/patterns/gradients…)
  │
  ├─ (simple OR convertible) AND ≤ 300 shapes  ──→  VECTOR: insertSvgShapeGroup
  │                                                (editable layers + keyframes)
  └─ otherwise                                 ──→  IMAGE: one faithful raster layer
                                                   (animation cannot survive; a toast
                                                    names exactly WHY it could not
                                                    convert — see §8)
```

Two rules worth understanding:

- **Animation outranks static fidelity.** `isSimpleSvg` exists so a gradient/mask/filter
  file is rasterized faithfully rather than degraded to flat fills. But rasterizing an
  *animated* file doesn't degrade it — it **kills** it: the image decodes once and is
  cached forever, a dead frame 0. A gradient flattened to its first stop is a colour the
  user can fix in the inspector; lost motion is unrecoverable. So if the animation
  converts, vector wins and a toast names the cost.
- **`MAX_VECTOR_SHAPES = 300`** caps how many layers one file may explode into. Every
  parsed shape becomes a scene layer with per-frame cost; a measured 1500-path
  illustration cost 132 ms *per frame* in `buildSnapshot`. Above the cap the file
  imports as one image, with a toast explaining why.

## 3. Parsing geometry (`src/utils/svgParser.ts` → `parseSvgToShapes`)

The markup goes through `DOMParser` and a recursive `traverse` of the element tree:

- Every drawable (`path`, `rect`, `circle`, `ellipse`, `line`, `polygon`, `polyline`,
  `text`) becomes a `ParsedShape`: cubic-bezier control points (`parseSvgPathEx`
  handles the full path grammar — arcs included), fill, stroke, closed flag, and text
  content where applicable.
- **`<use>` is instantiated** — the referenced element (or `<symbol>`, with its own
  viewport resolved from the `<use>`'s width/height) is traversed at the `<use>`'s
  offset, `href` and `xlink:href` both. Sprite-sheet and "one artboard, many copies"
  exports are built entirely out of these; they used to produce *nothing*, so whole
  parts of a file silently never appeared. Self- and ancestor-references terminate
  rather than expanding forever.
- **A nested `<svg>` establishes its own viewport** (x/y + viewBox → width/height,
  `xMidYMid meet`). Traversed as a plain `<g>`, its children landed at their raw
  inner-viewBox numbers in the OUTER coordinate system — the literal "the parts
  scattered across the canvas" report.
- **Root `width`/`height` must be an absolute length.** `width="100%"` parsed as
  `100`, inventing a 100×100 pixel box for a file that declares none and importing
  the whole artwork at a fraction of its viewBox scale. Percentages and other
  relative units resolve against a containing block the importer does not have, so
  they are treated as "no pixel box"; `px/pt/pc/mm/cm/in/Q` all resolve at 96 dpi.
- Transforms are **baked into the points**. Each element's `transform` attribute (and
  its ancestors') is composed into a 2×3 matrix and applied to the geometry, so the
  points arrive in flat SVG user space. The shape also keeps:
  - `matrix` — the exact static matrix that was baked in, and
  - `chain` — the element and its ancestors, root last.
  Both exist **only for the animation translator** (§4): they are what lets it express
  animation as a *delta* against the baked geometry.
- Points are re-centred on their own bounding-box centre, so a layer's origin lands on
  the shape's visual centre (selection boxes fit; no offset machinery downstream).
- `url(#gradient)` paints are approximated by the gradient's **first stop colour** so a
  vectorized shape gets a sensible solid fill rather than broken black.

## 4. Animation extraction — the heart of the importer

Two readers feed **one** sampling pipeline:

### 4a. SMIL reader (`src/utils/svgAnimation.ts` → `scanSvgAnimations`)

Walks the document for `<animate>`, `<animateTransform>`, `<set>`. Each becomes a
normalised `SmilAnim`: target element, attribute (`transform` / `opacity` /
`fill-opacity` / `stroke-dashoffset`), begin/duration/active window, value tuples,
keyTimes, calcMode (discrete/spline), repeat handling, `fill="freeze"`, `additive`.

### 4b. CSS reader (`src/utils/svgCss.ts` → `readCssAnimations`)

This is the reader that was missing for months — and CSS is the **more common** way an
SVG animates (icon spinners, loaders, anything exported from a web tool):

```css
@keyframes spin { to { transform: rotate(360deg) } }
.ring { animation: spin 1s linear infinite; transform-box: fill-box; }
```

It parses `<style>` blocks with a real brace-depth splitter (a regex can't survive
nested `@keyframes`/`@media`), resolves the `animation` shorthand and longhands
(duration, delay, iteration-count, direction, fill-mode, timing-function including
`cubic-bezier()` solved by bisection and `steps()`), resolves selectors **rule-first**
(one `querySelectorAll` per selector — never `el.matches()` per element×rule pair,
which was 40 000 scripted calls on a 200-rule icon), reads inline `style=""`
declarations, and converts each matched animation into the same shape `SmilAnim` uses
(`fromCss`), so everything downstream is source-agnostic.

**The `transform-origin` trap** (the one that makes spinners orbit instead of spin):
for SVG elements `transform-box` defaults to `view-box`, so a bare `rotate()` swings
the shape around the middle of the **artboard**. Only `transform-box: fill-box` makes
it rotate about its own box. Both are resolved correctly against the right reference
box (`resolveOrigin` + `localBox`), and both branches are pinned by tests.

### 4c. The sampling model: `D(t) = A(t) · S⁻¹`

`buildShapeAnimation` does **not** map each animation element onto a property
one-for-one. Instead, at a given time `t` it rebuilds the element chain's full matrix
`A(t)` with animated values substituted in, and compares it against the static matrix
`S` the parser baked into the points:

```
D(t) = A(t) · S⁻¹        // maps baked points to where they belong at time t
decompose(D)  →  x, y, rotation, scaleX, scaleY
```

This single idea is why hard cases fall out for free: `rotate(a, cx, cy)` (rotation
about a point that isn't the anchor), stacked `animateTransform`s, `additive="sum"`,
animation inherited from an ancestor `<g>` (moves every child in register), and CSS
transform lists — all are just matrices multiplied into `A(t)`.

Sampling details that took real debugging to get right:

| Problem | Mechanism |
|---|---|
| `atan2` readback wraps: a spin decodes as 0→180→−180→0 and interpolates *backwards* | **Angle unwrapping** — carry the turn count forward keyframe to keyframe |
| A 360° turn is invisible at its endpoints (≡ identity) | Rotation segments are **subdivided** (≤90° per sample; 15° when baking a single cycle, because an *orbit* is carried by x/y tracks that interpolate linearly — coarse samples turn a circle into a polygon) |
| Sampling exactly ON a repeat boundary reads the restart value, so a `repeatCount="2"` slide imported as "still, then one move" | Sample just **before** each boundary too (`RESTART_EPS`) |
| A `<set>` outside its window contributed nothing → 1-keyframe track → dropped | Opacity falls back to its **base value** outside the active window |
| CSS `alternate` runs odd iterations backwards | Direction flip inside `valueAt` before the timing function |
| CSS timing eases each keyframe **segment**, not the whole animation | `ease` applied to the segment fraction |

### 4d. Cost control — why importing can never freeze the app again (data side)

The naïve translation of a 200-part spinner produced **216 000 keyframes**. Four
mechanisms keep real files in the tens per track:

1. **Loops are baked ONCE, never unrolled.** If every animation on a chain shares one
   period and phase and is endless, only a single cycle is sampled and
   `SvgShapeAnimation.loop` is set. The importer attaches a **`loopOut('cycle')`**
   expression (`'pingpong'` for CSS `alternate`) — the engine's native AE-style loop —
   so cost is independent of composition length. `'cycle'`, deliberately **not**
   `'offset'`: offset accumulates the per-cycle delta, which flatters a spin but would
   ramp a repeating fade past 100 % opacity forever. Repeats in SMIL/CSS *restart*;
   `cycle` reproduces that exactly, and rotation is periodic so a replayed 0→360° still
   reads as continuous turning. A **finite** `repeatCount` is never looped — `loopOut`
   runs forever and claiming "2 iterations" would be a lie. (Precision gotcha: the
   cycle's end sample is read `1e-6 s` before the restart instant — reading 1 ms early
   cost a spin 0.7°/cycle, which compounds to visibly "running slow".)
2. **Douglas–Peucker simplification per track** (`simplifyTrack`, iterative — recursion
   would blow the stack on a 30 k-sample track). Dense sampling exists only because the
   sampler can't know in advance where the interesting times are; a constant-rate spin
   is *exactly linear* in unwrapped angle, so hundreds of samples collapse to two.
   Held/discrete tracks are exempt — a staircase's every step is a real edge.
3. **Unroll capped at the composition duration** (`maxDurationSeconds` threaded from
   `insertMedia`) — keyframes past the end of the comp can never play.
4. **`MAX_IMPORT_KEYFRAMES = 20 000`** as a whole-file backstop; past it, remaining
   shapes import static rather than hanging the app.

### 4e. Draw-on: `stroke-dashoffset` → trim path (AE Trim Paths)

The most common animated-SVG technique after spins — "the line draws itself":

```svg
<path d="…" stroke-dasharray="260" stroke-dashoffset="260">
  <animate attributeName="stroke-dashoffset" from="260" to="0" dur="2s"/>
</path>
```

One full-length dash hides the stroke; sliding the offset reveals it. That maps
**exactly** onto the engine's trim path: `visible fraction = 1 − offset / dashLength`,
where dashLength is the `pathLength` attribute if set (dashes are measured in that
unit), else the **sum** of the `stroke-dasharray` values. Both SMIL and CSS
`@keyframes stroke-dashoffset` convert, producing a `trimEnd` track in percent. The
dash animation must sit on the stroked element itself (chain[0]) — inherited from a
group it has no meaning — and a dashoffset with no measurable dash length is reported
by name instead of silently dropped. Translating this as opacity or position would be a
lie; trim is the same effect *by construction*.

## 5. Writing into the scene (`insertSvgShapeGroup`)

The shapes become real scene content:

- One **group node** at the drop point (or comp centre), scaled so the icon lands at a
  scene-proportional size (`k` = target / max dimension). Only the **group** is
  selected — the icon moves as one body.
  - The position goes on the **Transform component**, not just `node.transform`.
    Every reader — `readBase` in `buildSnapshot`, `toWorkspaceNode` in `ports.ts` —
    resolves `props.x ?? node.transform.position.x`, so writing only the node field
    left the group at `makeNode`'s placeholder (160, 120): on a 1920×1080 comp the
    icon appeared jammed into the top-left with its parts straddling the canvas
    edge, which reads as the parts having scattered. Width/height follow the
    content so the group's own bounds match what is inside it.
- Each shape becomes a child node with three components:
  `Transform` (position/size, `__sceneKind: 'shape'`), `Style` (fill, stroke, opacity),
  `Geometry` (the scaled bezier points, `open` flag for unclosed strokes). Text shapes
  get a `Text` component instead.
- **Keyframes** are written per track through `writeSvgAnimation`:
  - x/y offsets are scaled by `k` and re-based onto the part's rest position (otherwise
    the first keyframe would snap the part to the group origin);
  - `AnimationEngine.setKeyframes(nodeId, prop, kfs)` — the **bulk** API: de-dupe by
    time, sort **once**, notify **once**. (The interactive `setKeyframe` re-sorts and
    notifies per call — right for one drag, quadratic for a generated track.)
  - `calcMode="discrete"` / `<set>` keyframes carry `easing: 'hold'` so they step;
  - a looping shape gets `setExpression(nodeId, prop, "loopOut('cycle')")`;
  - a draw-on shape gets `defaultSceneGraph.setTrimPath(nodeId, defaultTrim())` **plus**
    keyframes on `trim.end` — the base config must exist or `resolveTrim` returns null
    and the animated values are silently ignored.
- The whole loop runs inside **`defaultAnimation.batch(...)`** (§6), and finishes with
  a single `bumpScene()`. History snapshots the animation engine alongside the scene at
  that bump, which is what makes the entire import one undo step.

## 6. How the scene reacts — the notification fabric (and the freeze that lived in it)

This is the layer where the "adding an SVG freezes the whole app" bug actually lived —
**not** in parsing. The fabric:

```
AnimationEngine mutation ─→ notifyChange(nodeId)
   └→ EventBus 'AnimationChanged'  (bound in Providers.tsx)
        ├→ bumpScene()                      ← Zustand revision bump
        ├→ history schedule('anim')
        ├→ viewport render()                ← rAF-coalesced
        ├→ autosave / thumbnail schedulers  ← debounced
        └→ inspector/timeline revision bumps
bumpScene ─→ useSceneRevision
   ├→ React components re-render (batched by React 18)
   └→ ports.ts onChanged  ← the ONE synchronous subscriber
        └→ Workspace: hitTester.markDirty() + pushOverlay() + renderer.markDirty()
```

The measured failure chain (158-shape import, live-profiled): each track write fired
`AnimationChanged`; each event ran `bumpScene()`; each bump synchronously rebuilt the
hit-tester; each rebuild enumerated the scene via `port.getNodes()`; and `getNodes` was
**O(N²)** because `worldMatrixOf(parent)` defaulted to a *fresh cache per call* — every
child re-derived its parent group's geometry, and group geometry walks all its
children. 16 events × ~2 s each = a 30-second freeze that grew with scene size.

Three layered fixes, all still in force:

1. **`AnimationEngine.batch(fn)`** — mutations inside hold their notifications; one
   `'*'` (all-nodes) notification flushes at the close, *even if `fn` throws* (listeners
   must not be left stale about mutations that landed before the error). Nested batches
   flush once, at the outermost close. The import fires **one** event instead of ~950.
2. **Shared `wmCache` per enumeration pass** (`src/core/workspace/ports.ts`):
   `getNodes()` creates one `Map` and threads it through `toWorkspaceNode` into
   `worldMatrixOf`, so each ancestor's matrix (and its group-geometry walk) is computed
   once per pass, not once per descendant. Measured: 2 282 ms → **18 ms** at ~700 nodes.
3. **Lazy hit-test rebuild** (`packages/workspace/src/hit/HitTester.ts`): scene changes
   vastly outnumber pointer interactions — every keyframe write *and every playhead
   tick* fires the listener, but the spatial index is only consumed on a click. The
   listener now calls `markDirty()`; the index rebuilds inside `ensureFresh()` on the
   next `hitTest` / `hitTestAll` / `hitTestRegion` / `indexSize` read. Any number of
   bumps are answered by one rebuild.

Net effect: the 158-shape animated insert went **3 816 ms → 19 ms**, and playback no
longer pays a full scene enumeration per frame.

## 7. The render engine — how it shows up on screen

After the import there is nothing SVG-specific left. The layers render exactly like
hand-made ones:

### 7a. Per-frame sampling (`src/core/rendering/buildSnapshot.ts`)

`buildSnapshot(graph, anim, t, …, comp)` runs every frame (rAF-coalesced) and produces
a `RenderSnapshot` — a flat list of `RenderLayer`s:

- Each node's playhead time goes through **`getRemappedTime`** (layer offset,
  time-stretch, remap) — the single time axis everything shares.
- **`AnimationEngine.evaluateNode(nodeId, localTime)`** returns a `Map<prop, number>`:
  keyframe tracks sampled with easing/bezier interpolation, then **expressions** run on
  top — this is where `loopOut('cycle')` extends a baked cycle to infinity. Animated
  values override base props (`av.get('x') ?? g.x`).
  - Per-axis scale is read **before** the uniform `scale` shorthand
    (`av.get('scaleX') ?? av.get('scale') ?? base.scaleX`), matching every other
    reader of these tracks. `localOf` used to check `scale` alone, so a keyframed
    `scaleX`/`scaleY` — which is what a CSS `scale()` animation imports as, what the
    scale gizmo autokeys, and what the seeded showcases use — moved the selection
    box (ports.ts had it right) and left the drawn pixels at 1. A pulse/breathe
    animation simply did not play.
- Geometry, styles, effects, masks, blend modes, 3D transforms and **trim**
  (`resolveTrim(node, av)` → `trimSegments(start, end, offset)` → `layer.trim`) are
  resolved into the layer.
- Perf note: a node's `components` is a getter that reconstructs the array per read, so
  `buildSnapshot` materialises each node **once** per frame (`materializeForFrame`) —
  measured 3× on a 1 200-node scene.

### 7b. Scene compilation and GPU (`snapshotToFrameScene` → `MotionRendererBackend`)

- `snapshotToFrameScene` converts the snapshot into the renderer package's `FrameScene`
  (packages/renderer): draw items, spatial effects routed to the right passes, camera
  from the snapshot's view.
- `MotionRendererBackend` drives the tiered GPU stack: **WebGPU primary**, WebGL2
  fallback, software last resort. A probe-before-commit ladder tests
  adapter→device→configure on a throwaway canvas (a canvas is permanently bound to its
  first context type), with a `boundKind` guard so one WebGPU hiccup can't poison the
  WebGL2 rungs. Shapes are drawn as real vector paths (`shapePath` from the Geometry
  points — closed shapes filled, open ones stroked); trim segments clip the stroke;
  the `CompositionPass` applies GPU effect chains; Canvas2D-only effects divert through
  a padded CPU bake (`bakedEffectSpread`).
- The viewport re-renders on `AnimationChanged` and during playback via the rAF
  coalescer — several notifications in one frame produce one render.

### 7c. The other consumer: selection/interaction (`src/core/workspace/ports.ts`)

The workspace engine (hit-testing, drag, marquee, gizmos) sees the scene through
`toWorkspaceNode`: same `evaluateNode` sampling, same projection chain as the renderer
(`currentViewProjector` — shared so the selection box can't drift off the drawn layer),
world matrix via the shared-cache `worldMatrixOf`, precise `hitTestLocal` from the
shape's own geometry. So an animated shape is selectable exactly where it is *drawn at
the current playhead time*.

### 7d. The image fallback path (`src/core/rendering/AppTextureProvider.ts`)

When routing chose IMAGE (complex static file, or animation that could not convert),
`rasterizeSvg` decodes the markup at high resolution and hands the GPU one faithful
texture. This is the "decoded once, cached forever" path — which is precisely why the
router refuses to send anything down it if the animation is convertible.

## 8. What cannot convert — and how the user finds out

Named honestly per file (toast via `reportSvgAnimation` / `svgAnimationBlockers`)
instead of silently dropped:

- `animateMotion` (motion along a path)
- colour/paint animation (`fill`, `stroke` values)
- geometry morphs (`r`, `d`, points)
- event/syncbase timing (`begin="click"`, `begin="other.end"`)
- CSS `:hover`/`:active` animation (interaction, not a timeline)
- `stroke-dashoffset` with no `stroke-dasharray`/`pathLength` to measure against

A file that animates but cannot convert imports as a static image with a toast naming
the exact blockers and suggesting a Lottie export.

## 9. File map

| Stage | File |
|---|---|
| Asset upload / library | `src/stores/assetStore.ts`, `src/layout/EditorLayout/DemoPanels.tsx` |
| Routing + insert | `src/core/scene/sceneInsert.ts` (`insertMedia`, `insertSvgShapeGroup`, `writeSvgAnimation`) |
| Geometry parse | `src/utils/svgParser.ts` |
| SMIL → tracks | `src/utils/svgAnimation.ts` (`scanSvgAnimations`, `buildShapeAnimation`, `simplifyTrack`) |
| CSS → tracks | `src/utils/svgCss.ts` (`readCssAnimations`) |
| Keyframe/expression engine | `packages/animation/src/AnimationEngine.ts` (`setKeyframes`, `batch`, `evaluateNode`, `loopOut` in `expressions.ts`) |
| Trim paths | `src/core/scene/trimPath.ts` |
| Scene→workspace bridge | `src/core/workspace/ports.ts` (`toWorkspaceNode`, shared `wmCache`) |
| Hit testing | `packages/workspace/src/hit/HitTester.ts` (lazy rebuild), `Workspace.ts` |
| Frame sampling | `src/core/rendering/buildSnapshot.ts` |
| GPU | `src/core/rendering/snapshotToFrameScene.ts`, `MotionRendererBackend.ts`, `packages/renderer/*` |
| Raster fallback | `src/core/rendering/AppTextureProvider.ts` |

**Tests:** `svgParser.test.ts`, `svgAnimation.test.ts`, `svgCss.test.ts` (translation
correctness incl. transform-origin and loop semantics), `svgImportAnimation.test.ts`
(keyframes actually land on the engine), `svgImportCost.test.ts` (**cost** regression —
keyframe counts, comp-length independence, bulk-write speed; exists because every
correctness test passed while the app was frozen), `AnimationEngine.test.ts` (`batch`),
`hit.test.ts` (lazy rebuild).

## 10. Measured results (the numbers that define "fixed")

| Metric | Before | After |
|---|---|---|
| 200-path CSS spinner, keyframes | 108 000 | **400** |
| 200-path SMIL orbit, keyframes | 216 000 | **10 208** |
| 158-shape animated insert (live app) | 3 816 ms + multi-second follow-up tasks | **19 ms** |
| `getNodes()` @ ~700 nodes | 2 282 ms | **18 ms** |
| Full Add-button path (`insertMedia`) | freeze | **243 ms** |
| Keyframe cost vs comp length | linear (unrolled) | **constant** (one cycle + `loopOut`) |

Verified live end-to-end: spin rotation continues past its baked cycle (−72° ≡ 288° at
3.6 s via `loopOut('cycle')`), alternate pulse ping-pongs 30→65→100 % opacity, and a
draw-on path's `layer.trim` goes `[]` → `[[0, 0.5]]` → full through `buildSnapshot`.
