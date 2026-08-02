# Compositing Audit — blend modes, masks, mattes, templates

**Written:** 2026-08-03 · **Method:** read against the working tree, not the docs.
**Verified against:** `Desktop/motion-editor` @ branch `latest`. Typecheck clean.

---

## 0. Headline — the brief's premise is half wrong

The brief assumes "we have basic versions, they work but they are too simple."
That is true for **blend modes** and **templates**. It is **not** true for
**masks** and **track mattes**, which are already close to AE parity — including
the one thing the brief calls "the single highest-value structural fix."

Three things you should know before reading the table:

1. **Priority #1 on your list is already implemented.** Track mattes are
   decoupled from stack position: explicit `sourceId`, a "Matte Source" picker
   in the inspector, one source driving many layers, alpha/luma × invert.
   `buildSnapshot.ts:2714` resolves an explicit source and only *falls back* to
   AE's positional convention. Re-prioritise.

2. **The stated reason blend modes stop at 17 no longer exists.** Three modules
   claim in their header comments that the app composites on Canvas 2D and that
   the mode list is capped at what `globalCompositeOperation` supports natively.
   That was true once. It is not true now — see §2. The remaining 21 AE modes
   are, for the most part, **branches in a shader switch that already exists**,
   not an architecture change. This moves most of section A from L to S/M.

3. **There is no schema migration mechanism at all.** A document version is
   written and preserved but never read to upgrade anything (§6). Your "never
   break saved projects" rule currently has nothing to hang off. This is a
   prerequisite for every milestone that touches the schema.

---

## 1. Corrections to the project context you supplied

| You said | Actually |
|---|---|
| Renderer: *unknown* | **One GPU engine.** WebGPU → WebGL2 → Null, chosen in `createRenderBackend.ts:27`. Canvas2D is **not** a backend; it survives only as `raster/Canvas2DVectorRasterizer.ts`, which produces *textures* for the GPU compositor. |
| Framework | React + TypeScript, Electron shell, Zustand stores. |
| Document format | Own format: a `.motion` **directory bundle** (`src/core/project/bundle/`), chunked + content-hashed, `manifest.json` written last. Inner doc version `'1.1.0'`. |
| Export targets | mp4, mov, webm, GIF, PNG/JPG sequence, Lottie/JSON. |
| Existing tests | Jest unit tests beside the code, **plus** `packages/render-tests/` — golden-image tests in real Chromium. There are already 17 blend-mode golden scenes (`harness/scenes/blendModes.ts`). |

---

## 2. How a frame is actually composited

```
SceneGraph (src/core/scene/SceneGraph.ts)
  │  blend / matte / mask live on each node's `fx` component props
  ▼
buildSnapshot()                       src/core/rendering/buildSnapshot.ts
  │  evaluates animation → flat RenderLayer[] (paint order: back → front)
  │  resolveMatteSources()            :2714   marks isMatteSource + matteSourceId
  ▼
snapshotToFrameScene()                src/core/rendering/snapshotToFrameScene.ts
  │  layerBlendToGpu()                :39     → fixed-function BlendMode
  │  advancedBlendId()                :69     → shader mode id 1..15
  │  matteOf()                        :740    → {mode, inverted, sourceId}
  ▼
FrameScene (Renderable[])             packages/renderer/src/scene/FrameScene.ts
  ▼
CompositionPass                       packages/renderer/src/rendergraph/passes/CompositionPass.ts
  │  :1014  matte SOURCE layers are skipped in the main pass (consumed on demand)
  │  :1040  matted layer + its source → full-comp targets → MATTE_COMBINE shader
  │         advanced-blend layers → BLEND_COMBINE against SCENE_COLOR_TARGET
  ▼
WebGPUBackend / WebGL2Backend         packages/renderer/src/gpu/backends/
```

**Preview and export run this exact path.** `offlineRenderer.ts:16-20` imports
the same `createRenderBackend` and `buildSnapshot` the viewport uses. No
divergence to report (§7).

### The blend shader

`BLEND_COMBINE` (`packages/renderer/src/shaders/builtin.ts:478`) is a proper W3C
compositing implementation, in both WGSL and GLSL:

- unpremultiplies source and backdrop, blends, re-premultiplies
- correct Porter-Duff result: `co = as·(1−ad)·cs + as·ad·B + (1−as)·ad·cb` (`:545`)
- separable modes via `bChan()` (ids 1–11) and non-separable HSL via
  `bSetLum`/`bSetSat`/`bClip` (ids 12–15), which is the textbook construction

This is good code. Adding modes means adding `if (mode == N)` branches to
`bChan()` in two shader dialects plus one enum entry — not new plumbing.

### Colour space

Blending happens in **sRGB (gamma-encoded) space**. There is no linearisation
anywhere in the shaders — I grepped for it and found none. The compositing
intermediates are `rgba16float` where supported (`passes/index.ts:54-58`), so
you have float *precision* but gamma-encoded *values*.

This is worth stating plainly because it is easy to misread as a bug: it is
**AE-consistent**. AE blends in the project's working space and, by default,
does not use 1.0 gamma. Add/Screen/Multiply will match AE's default behaviour.
If you ever add a "Blend Colors Using 1.0 Gamma" switch, the float targets mean
the precision is already there — only the transfer functions are missing.

### Dead code found

`blendToComposite()` (`src/core/effects/blendMode.ts:88`) returns a
`GlobalCompositeOperation` and is called by **nothing except its own test**.
It is a leftover of the Canvas2D era. Likewise `layerBlendToGpu()`
(`snapshotToFrameScene.ts:39`) is effectively unreachable for every non-normal
mode, because `advancedBlendId() > 0` forces `blend: 'normal'` and routes to the
shader (`:562`). Its "nearest family member" fallbacks (dodge→screen,
HSL→normal) describe behaviour that no longer happens.

**Stale comments to fix regardless of what you build:** `blendMode.ts:7-11`,
`matte.ts:11-12`, `mask.ts:6-7`, `snapshotToFrameScene.ts:33-37`,
`offlineRenderer.ts:7`. All five assert a Canvas2D compositor. They are the
reason this audit was needed, and they will mislead the next reader too.

---

## 3. Feature inventory

### A. Blend modes — 17 of 38

Implemented: Normal, Add, Multiply, Screen, Overlay, Darken, Lighten, Color
Dodge, Color Burn, Hard Light, Soft Light, Difference, Exclusion, Hue,
Saturation, Color, Luminosity. (`blendMode.ts:42`, shader ids `builtin.ts:437`)

| AE category | Have | Missing |
|---|---|---|
| Normal (3) | Normal | Dissolve, Dancing Dissolve |
| Subtractive (6) | Darken, Multiply, Color Burn | Classic Color Burn, Linear Burn, Darker Color |
| Additive (7) | Add, Lighten, Screen, Color Dodge | Classic Color Dodge, Linear Dodge, Lighter Color |
| Complex (7) | Overlay, Soft Light, Hard Light | Linear Light, Vivid Light, Pin Light, Hard Mix |
| Difference (5) | Difference, Exclusion | Classic Difference, Subtract, Divide |
| HSL (4) | all 4 ✅ | — |
| Matte (4) | — | Stencil Alpha, Stencil Luma, Silhouette Alpha, Silhouette Luma |
| Utility (2) | — | Alpha Add, Luminescent Premul |

The 21 missing modes split by **actual** difficulty, not by category:

| Group | Modes | Effort | Why |
|---|---|---|---|
| Separable shader branches | Classic Color Burn/Dodge, Classic Difference, Linear Burn, Linear Dodge, Linear Light, Vivid Light, Pin Light, Hard Mix, Subtract, Divide (11) | **S** | Pure per-channel math into `bChan()`, both dialects. Linear Dodge is arithmetically Add. |
| Whole-colour compare | Darker Color, Lighter Color (2) | **S** | Non-separable but trivial — compare luminance of the whole vec3, pick one. Goes in the `mode >= 12` branch. |
| Stochastic | Dissolve, Dancing Dissolve (2) | **M** | Needs per-pixel noise. Dancing must reseed per frame → a time/seed uniform the shader doesn't currently receive, and it breaks frame determinism unless seeded from frame index. Coordinate with the deterministic-export guarantee. |
| Alpha-modifying utility | Alpha Add, Luminescent Premul (2) | **M** | These write **alpha**, which the current `co/ao` output does support, but the semantics differ per mode and need their own golden tests. Alpha Add is the anti-seam fix the brief mentions. |
| Alpha-propagating | Stencil Alpha/Luma, Silhouette Alpha/Luma (4) | **L** | See §4 — the one real structural blocker. |

**Keyframing blend modes:** not supported, and not cheap to add. `blendMode` is
a plain prop on the `fx` component (`blendMode.ts:69-73`), not an animatable
track, and the value is consumed at snapshot-build time to select a *pipeline*.
Animating it means either per-frame pipeline switching or crossfading two
composites. AE can't do it either. My recommendation: don't, unless a user asks.

### B. Track mattes — mostly done

| Capability | Status | Where |
|---|---|---|
| Any layer as matte source, regardless of position | ✅ | `buildSnapshot.ts:2721-2724` |
| Fallback to layer-above when no explicit source | ✅ | `:2725-2732` |
| One source → many matted layers | ✅ | loop sets `isMatteSource` per reference; no exclusivity |
| Alpha / Luma | ✅ | `matte.ts:19` |
| Inverted | ✅ | as enum variants `alpha-inv` / `luma-inv` |
| Source hidden but still rendered as matte | ✅ | `CompositionPass.ts:1014` skips it in the main pass |
| Effects on the matte layer affect the matte | ✅ | `CompositionPass.ts:320` — matte/advanced-blend branches route through the *same* effect pipeline as normal layers |
| Source picker UI | ✅ | `CompositingControls.tsx:101-111` |
| Two independent toggles (AE 23+ UI shape) | ⚠️ | Modelled as 4 enum values, not `alpha\|luma` × `invert`. Functionally identical, cosmetically different. **S** to reshape; only worth it for AE muscle memory. |

This is the legacy-model fix the brief flags as highest value, and it is
**already shipped**. The only remaining work is cosmetic.

### C. Masks — richer than the brief assumes

Per-mask stack with per-mask properties, not one boolean per layer
(`mask.ts:42-60`).

| Capability | Status | Where |
|---|---|---|
| Stack of masks per layer | ✅ | `LayerMask.paths[]` |
| Animatable bezier path | ✅ | `maskAnim` keyframes, `interpolateMask` `mask.ts:294` |
| Feather (uniform) | ✅ | `mask.ts:253`, AE-diameter → blur radius |
| Per-mask opacity | ✅ | `mask.ts:250` |
| Expansion (±) | ✅ | `expandMaskPoints` `mask.ts:110` — real miter-bisector offset |
| Inverted | ✅ | `mask.ts:184`, even-odd + layer rect |
| Modes: Add/Subtract/Intersect/Lighten/Darken/Difference | ✅ | `mask.ts:192` |
| Leading Subtract/Intersect starts from full frame | ✅ | `maskModeStartsFull` `mask.ts:217` — correct AE behaviour |
| One shared rasterisation for both consumers | ✅ | `paintMaskMatte` `mask.ts:235` |
| **Mode: None** | ❌ | 6 of AE's 7. `'none'` is what makes a path usable as data without touching alpha — the prerequisite for effect-scoped masking and path-following. **S** |
| **Variable-width feather** | ❌ | Single scalar per mask. Needs feather *points* along the path → a per-vertex width channel and a distance-field or swept-outline rasteriser. **L**, by far the biggest mask item. |
| **Effect-scoped masking** | ❌ | No `maskId` / scope on any effect (`effects.ts` — grepped, nothing). **M–L**, needs mode None first. |
| **Vertex-count morph** | ⚠️ | Mismatched point counts **snap** to the nearer keyframe (`mask.ts:307`) instead of interpolating. Honest and documented, but not AE. **M** |
| Mask tracking / AI roto | ❌ | Out of scope for now. |

### D. Templates — real MOGRT model, two structural gaps

`src/core/template/` is a genuine Essential-Graphics-style system, not a preset folder.

| Capability | Status | Where |
|---|---|---|
| Author a comp, expose chosen props as fields | ✅ | `templateAuthoring.ts`, manifest in `__templateFields` on the comp root |
| Field kinds: text, colour, number, image, media | ✅ | `templateTypes.ts:22` |
| Media replacement with author-set fit policy | ✅ | `SlotFit` contain/cover/native, `mediaSlots.ts` |
| Writes through the normal scene graph — no second render path | ✅ | `templateFields.ts` |
| Self-contained packaging | ✅ | `.motion` bundle carries `assets/` by SHA-256; `exportBundle.ts` |
| Nested reusability | ✅ | precomps / comp instances |
| Animation presets (lighter primitive) | ✅ | `animPresets.ts` — insert a self-contained animated element |
| **Responsive time / protected regions** | ❌ | Nothing. Grepped `protected`/`intro`/`outro`/`responsiveTime` — no hits. This is what makes a lower-third reusable at any length. **M–L** |
| **Data binding (CSV/JSON)** | ❌ | Nothing. **M** |
| Dropdown field kind | ❌ | Brief asks for it; `TemplateFieldKind` has no enum kind. **S** |

---

## 4. Structural blockers

**Only one item in the whole brief is genuinely blocked by the architecture.**

### Stencil / Silhouette (4 modes) — the real L

These modify the alpha of **every layer below them**, not just the next one. The
current pipeline composites layer-by-layer into a running target; a renderable
can read the backdrop colour (that is how `BLEND_COMBINE` works) but it cannot
*retroactively* rewrite the accumulated alpha of everything beneath it, and it
has no notion of "the group I belong to."

Doing this properly needs a **compositing-group boundary**: layers accumulate
into a group target, the stencil layer applies to that target's alpha, then the
group composites into its parent. In AE this is exactly why stencil is contained
by precomposing. We already have precomp isolation
(`precompIsolation.test.ts`, `CompositionPass.ts:631-680`), so the concept
exists — the work is generalising it into an explicit group scope rather than
inventing it.

Prerequisite for: Stencil Alpha, Stencil Luma, Silhouette Alpha, Silhouette
Luma. Nothing else in the brief depends on it.

### Non-blockers worth naming

- **Variable-width feather** is *hard* but not blocked — it is a rasteriser
  change inside `paintMaskMatte`, contained to one function.
- **Effect-scoped masking** needs mask mode `None` first, then a scope field on
  the effect descriptor. Contained.
- **Responsive time** needs a time-remap layer between the timeline and
  `buildSnapshot`'s time evaluation. Contained, but touches keyframe sampling —
  and per `gotcha_keyframe_time_axis`, `getRemappedTime` is the only axis
  keyframes are sampled on, so that is the single place to change.
- **No schema migration** — see §6. Blocks nothing technically, but your own
  hard rule blocks *you* until it exists.

---

## 5. Preview / export divergence

**None found.** `offlineRenderer.ts` uses `createRenderBackend` + `buildSnapshot`
— identical to the viewport. Motion blur is explicitly threaded through so
export matches (`OfflineRenderParams.motionBlur`). `exportView` exists
specifically to fix a framing mismatch, which suggests this has been audited
before.

Two caveats, neither a divergence today:

- `HDR_INTERMEDIATES && backend.capabilities.float16Textures`
  (`RenderGraph.ts:159`) means precision differs between a machine with float16
  and one without. Same code, different rounding. Only visible in extreme
  multi-pass blend stacks.
- Lottie export cannot represent most of this (§8) — that is a *format* limit,
  not a code divergence.

---

## 6. Schema and versioning — the gap that blocks your own rule

- `projectDocumentIO.ts:27` writes `version: '1.1.0'`.
- `bundleCodec.ts:95` preserves it as `documentVersion`, commented "preserved for
  migration."
- **Nothing reads it to migrate.** I grepped for `doc.version` / `migrateDoc` /
  version comparisons across `src/` — the only hits are the plugin manifest and
  the plugin UI, unrelated.

So today, an older `.motion` bundle loads by being structurally compatible, not
by being upgraded. Every field added so far has been optional, which is why this
has not bitten yet — `readNodeMask`, `readNodeMatte`, `readNodeBlend` all
tolerate absent props and default cleanly.

That works right up until a milestone needs to *change* a field's shape — for
example reshaping matte from 4 enum values to `{mode, inverted}`. Before any
such milestone: build the migration hook, and add a fixture-load test.
**Effort: S**, and it should be milestone 0.

---

## 7. Effort summary and shared prerequisites

| # | Gap | Effort | Prerequisite |
|---|---|---|---|
| 0 | Schema version read + migration hook + fixture test | S | — |
| 1 | 13 separable/compare blend modes | S | — |
| 2 | Mask mode `None` | S | 0 |
| 3 | Template dropdown field kind | S | 0 |
| 4 | Matte UI → two toggles | S | 0 (schema reshape) |
| 5 | Alpha Add + Luminescent Premul | M | 1 |
| 6 | Dissolve + Dancing Dissolve | M | 1, deterministic seed |
| 7 | Mask vertex-count morph | M | 0 |
| 8 | Effect-scoped masking | M–L | 2 |
| 9 | Template data binding | M | 0, 3 |
| 10 | Responsive time / protected regions | M–L | 0 |
| 11 | Variable-width feather | L | 0 |
| 12 | Stencil / Silhouette | L | compositing-group boundary |

Shared prerequisites: **0 gates everything that touches the schema** (2,3,4,7,9,10,11).
**1 gates 5 and 6** (same shader, one edit pass). **12 stands alone.**

---

## 8. Lottie export — what we can't represent

Flagging now, per the brief. Lottie supports only basic mask modes, a limited
blend subset, and restricted track mattes. Anything below needs our own format
extension or must be baked to raster on Lottie export:

- Every blend mode outside Lottie's subset — including most of the 13 in item 1
- Stencil / Silhouette (no concept)
- Alpha Add / Luminescent Premul
- Variable-width feather
- Effect-scoped masking
- Mask modes Lighten / Darken / Difference
- Template fields, media slots, responsive time (authoring-time only — these
  resolve before export, so they are fine)

The template features are safe. The compositing features are not.

---

## 9. Recommended re-prioritisation

Your ordering, with what the audit changes:

| Your # | Item | Verdict |
|---|---|---|
| 1 | Track matte decoupled | **Drop — already done.** Only the 2-toggle UI remains (S). |
| 2 | Per-mask stack + modes | **Mostly done.** Only mode `None` missing (S). |
| 3 | Full blend mode set | **Promote to first.** Cheaper than assumed; 13 of 21 are S. |
| 4 | Feather + expansion + opacity | **Done**, except variable-width feather (L, and I'd defer it). |
| 5 | Effect-scoped masking | Keep — genuinely missing, needs mask None first. |
| 6 | Templates: fields + protected time | Fields **done**; protected time genuinely missing. |

**Proposed order:** 0 (migration) → blend modes S-tier → mask None → matte
2-toggle UI → Alpha Add → effect-scoped masking → responsive time →
Stencil/Silhouette → variable-width feather.

Rationale: it front-loads the work whose cost the stale comments were
overstating, and it defers the two genuine L items until the cheap parity wins
are banked. If you disagree with deferring Stencil/Silhouette — it is the most
*visible* AE gap for a compositing-heavy user — say so and I'll pull it forward,
but it should still come after item 0.

---

## Stopping here

Per the brief: no feature code written, no plan yet. Tell me whether you accept
the re-prioritisation in §9 and I'll write `docs/COMPOSITING_PLAN.md`.
