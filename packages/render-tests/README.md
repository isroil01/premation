# @motion/render-tests — Golden-Frame Regression Suite (Phase 0)

Machine-enforced definition of **"the picture didn't change."** Every later phase
of the single-engine unification is verified against this suite. Without it,
renderer changes cannot be trusted.

## What it does

For each **scene** (a small, single-feature document), it renders selected frames
through the **real production render path** on each backend, then perceptually
pixel-diffs the result against committed reference PNGs.

There is exactly one render definition: scenes are rendered by the same
`createRenderBackend → buildSnapshot → renderFrame` path that `offlineRenderer.ts`
uses for export. The suite only builds inputs and reads back pixels.

### Two comparison tiers (both reported; different gating)

| Tier | Compares | Gates the build? |
|------|----------|------------------|
| **Oracle regression** | `canvas2d` actual vs committed reference | **Yes.** References are blessed from Canvas2D — this asserts they reproduce deterministically (the "picture didn't change" gate). |
| **GPU parity** | `webgl2` actual vs the same reference | Only scenes flagged `gpuParity: 'expect-pass'`. Scenes flagged `known-divergent` are a live dashboard of gaps that Phases 1–2 will close. |

A `known-divergent` scene that starts **matching** is flagged `RESOLVED (re-flag!)`
so you promote it to `expect-pass`.

## Running

```bash
npm run render-tests            # render + compare (the gate; exit 1 on failure)
npm run render-tests:update     # re-bless ALL references from the Canvas2D oracle
node packages/render-tests/scripts/run.mjs --update solid-fill   # bless one/some
node packages/render-tests/scripts/run.mjs --scene flat-background  # one scene
```

**Re-blessing requires a human eyeball.** A re-bless makes *any* render change
"correct" by definition, so the runner shouts about it. Review the changed
`references/<scene>/*.png` before committing.

Failure artifacts (actual / expected / diff PNGs) are written to
`.artifacts/diff/<scene>__{oracle,gpu}/`.

## How it renders (determinism)

The pixel factory is **offscreen Electron** forced onto **SwiftShader** software GL
(`electron/main.cjs`). This gives the AE-level promise — *same machine + same
driver ⇒ same bytes* — with the driver pinned to SwiftShader rather than whatever
GPU the box has. Canvas2D and WebGL2 both render in one real runtime; pixels are
read back via `getImageData` (2D) or `gl.readPixels` + vertical flip (GL).

Pipeline: `run.mjs` → Vite-build the harness (`vite.harness.config.ts`, reuses the
app's `@core`/`@motion` aliases) → spawn Electron → Electron writes actual PNGs +
a manifest → `run.mjs` compares/blesses (`comparator.mjs`, pngjs + pixelmatch).

## Adding a scene

1. Create `harness/scenes/<name>.ts` exporting a `defineScene({...})` with an `id`,
   `size`, `comp`, `fps`, `frames`, optional `tolerance`, `gpuParity`, and a
   `build(graph, anim)` that populates a fresh `SceneGraph`/`AnimationEngine`
   using the real scene ops (`graph.addNode`, `graph.setFill`, `anim.setKeyframe`…).
2. Register it in `harness/scenes/registry.ts`.
3. `node scripts/run.mjs --update <id>`, **eyeball** the reference, commit it.

Keep each scene single-feature (per the Phase 0 coverage list). The comparator
gate is ≤ 0.5% of pixels differing beyond ~ΔE 2 (channel delta > 4/255); override
per scene with `tolerance`.

## Coverage (Phase 0)

**89 scenes**, all deterministic (oracle regression clean). Families: fills,
shapes (rect/ellipse/bezier/rounded/trim/repeater/path-op), strokes
(joins/caps/dashed/multi), all 17 blend modes, 29 effects, mattes (alpha/luma
+inverse), masks (add/subtract/intersect/feather/animated), adjustment layer,
layer styles, text (basic/multiline/rich-runs/glyph-animator/on-path), 3D
(rotated/camera/DOF/lights), motion blur, precomp + time-remap, paint strokes.

**Deferred** (need binary assets or Canvas2D sim support): particles,
image-sequence, video.

## Known findings (Phase 0)

- **GPU already matches Canvas2D on ~37/89 scenes** — inset vector content
  (most effects, mattes, masks, text) rasterises through Canvas2D-baked textures
  on the GPU path, so it already agrees. Divergence concentrates in comp-edge
  coverage, strokes, and features Canvas2D doesn't implement. Parity is reported,
  not gated, at Phase 0 (certification is Phase 1/2).
- **Comp-edge coverage differs Canvas2D vs GPU.** Every comp-*filling* scene —
  even an empty flat background — diverges on the ~1px composition boundary
  (Canvas2D insets/antialiases the comp edge; the GPU covers full pixels).
  Interiors match exactly (colour space / premultiply / readback verified via
  `flat-background`). Inset shapes have no such edge and match cleanly.
- **Canvas2D renders some features flat/unaffected** (they are GPU-side):
  3D perspective, camera, depth of field, and motion blur (disabled in Canvas2D
  by product requirement, `capabilities.ts`), plus gpuOnly effects
  (`displacement-map`, `motion-tile`). Their references are valid *Canvas2D*
  anchors; the GPU-parity diff is where the real signal is for those scenes.

## Notes / gotchas

- **CI:** local gate today. `.github/workflows/render-tests.yml` scaffolds a
  headless run (Electron + SwiftShader under `xvfb`). No remote CI is wired in
  this repo yet.
- **OneDrive:** this repo lives under OneDrive; `npx jest` silently under-collects
  suites (placeholders read as symlinks). This suite deliberately does **not** run
  under Jest — it's a standalone Node runner with a real exit code, so it can't be
  silently skipped.
- **ESLint** is not installed in this repo, so `npm run lint` is currently a no-op;
  the harness TS is plain strict-mode TypeScript.
