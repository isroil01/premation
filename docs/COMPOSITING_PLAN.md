# Compositing Plan — milestones

**Written:** 2026-08-03 · **Revised:** 2026-08-03 (r2)
**Follows:** [`COMPOSITING_AUDIT.md`](./COMPOSITING_AUDIT.md)
**Status:** awaiting approval. No code written.

---

## 0. Answers, and what r2 changed

### 0.0 Correction — two harness pieces already exist, and one is blind

Before anything else, because it changes M5 and M1.

I planned to *build* two things that are already in the tree. I checked instead
of assuming, and both were there:

**1. The `resolvedKind` assertion exists** — `packages/render-tests/harness/renderEntry.ts:143`
throws when the backend that rendered isn't the one requested. Its comment
documents the exact failure I flagged: a WebGPU run on a box with no adapter
used to write WebGL2 pixels into `actual/webgpu/`, so "every parity figure
computed from that directory was comparing WebGL2 against WebGL2 while claiming
otherwise." Already fixed, already loud.

**2. A byte-identical determinism gate exists** — `renderEntry.ts:177-186`
re-renders and requires identical bytes, calling it "the AE-level promise."

**But it cannot catch the bug M5 exists to prevent.** It re-renders from the
**same snapshot object** (`snap`, built once at `:153`). So it tests *renderer*
determinism — GPU and driver — and is structurally blind to *pipeline*
determinism. A Dissolve seeded from wall-clock would be sampled once into that
snapshot and then re-rendered from the identical input, passing the gate every
time. It also covers only `scene.frames[0]`, and never compares the preview path
against `offlineRenderer`.

So the harness is real but half the depth we need. M5 is no longer "build a
harness" — it is **extend an existing gate from renderer-determinism to
pipeline-determinism**, which is a smaller, better-scoped job with a working
foundation. That is a strictly better starting position than the one r1 assumed.

### 0.1 Coupling check — §9 holds

Verified against code, not reasoned about:

| Milestone | Where it executes | Assumes a group boundary? |
|---|---|---|
| Effect-scoped masking | Per-layer effect chain, `CompositionPass.ts:320` — already the single shared path for matted, advanced-blended and 3D layers | No. Intra-layer. |
| Alpha Add / Luminescent Premul | `BLEND_COMBINE`, which already returns an output alpha `ao` (`builtin.ts:546`) | No. Layer-against-backdrop. |
| Responsive time | Time evaluation in `buildSnapshot`, upstream of the render tree entirely | No. Never reaches it. |

The front-load argument does not apply. §9 is correct on value-per-effort.

### 0.2 The "cheap 13" — verified, estimate holds

| Bucket | Count | Effort |
|---|---|---|
| Separable branches — Classic Color Burn/Dodge, Classic Difference, Linear Burn, Linear Dodge, Linear Light, Vivid Light, Pin Light, Hard Mix, Subtract, Divide | 11 | S |
| Whole-colour compare — Darker Color, Lighter Color | 2 | S |
| **→ the cheap 13** | **13** | **S** |
| Stochastic — Dissolve, Dancing Dissolve | 2 | M |
| Alpha-modifying — Alpha Add, Luminescent Premul | 2 | M |
| Alpha-propagating — Stencil/Silhouette ×4 | 4 | L |

All three modes you flagged sit **outside** the 13. M1 does not need re-scoping.

**Seeding:** no wall-clock anywhere in the render path (`Date.now()` /
`performance.now()` grepped in `buildSnapshot.ts` and `snapshotToFrameScene.ts`
— zero hits). Precedent is the existing keyframeable `evolution` uniform
(`effects.ts:608` → `snapshotToFrameScene.ts:378`): an authored number, not a
clock. Dissolve takes a static `seed`; Dancing Dissolve derives from frame index
`round(t · fps)`. The off-by-one assertion you asked for is now an explicit M5
deliverable.

### 0.3 The matte enum — model change, contained

`matteOf()` (`snapshotToFrameScene.ts:740-746`) already collapses the 4 enum
values into `{ mode: 'alpha'|'luma', inverted: boolean }` before anything
GPU-side sees it. **The renderer is already on the target model — zero renderer
work.**

Load-bearing upstream in four places: serialization (→ migration, gated on M0),
the AI tool JSON-schema *and* its prompt text, Lottie's `tt` mapping, and
render-test scene ids. Plus the two-dropdown duplication, now folded in per your
point 4.

### 0.4 Renderer strategy

Already decided and shipped: one GPU engine, WebGPU → WebGL2. Canvas2D is a
texture rasterizer, not a backend. `globalCompositeOperation` coverage is
irrelevant to every milestone here. The only live renderer question is the
`PRECOMP_TARGETS` pool — M0.5.

### 0.5 What r2 changed

1. **M5 reframed** — determinism harness is the deliverable, Dissolve is the
   forcing function. Corrected per §0.0: the harness partly exists and is blind
   to snapshot-level nondeterminism, so the job is deepening it.
2. **Parallelism split** — M0 ∥ M2 overlap; M1 runs alone.
3. **M0.5 sharpened** — the fallback *severity asymmetry* is now the spike's
   central question, not the slot count.
4. **M3** — dropdown consolidation is an explicit deliverable, not a side effect.
5. **M1** — `resolvedKind` emission on success, since the assertion already exists.

---

## 1. Milestones

### M0 — Document version read + migration hook · **S** · *runs alongside M2*

- **Files:** `src/core/project/projectDocumentIO.ts`, `bundle/bundleCodec.ts`,
  new `src/core/project/migrations/`
- **Schema:** none — builds the mechanism, applies no migration
- **Adds:** version-compare on load, ordered migration registry, identity
  `1.1.0 → 1.1.0` migration to prove the path executes
- **Tests:** committed pre-change `.motion` fixture loads to an unchanged scene
  graph; an unknown *newer* version fails loudly rather than half-loading
- **Risk:** Low — nothing calls it yet
- **Rollback:** delete the directory

### M0.5 — Compositing-group boundary spike · **design only, ~1 afternoon**

No implementation, no schema change. Deliverable: `docs/COMPOSITING_GROUPS_SPIKE.md`.

**The central question, per your point 3 — the fallback severity asymmetry:**

`prepareIsolatedPrecomp` (`CompositionPass.ts:638`) already renders a subtree to
an offscreen target and returns it as one renderable through the ordinary
per-layer machinery. It is capped at **four slots** (`PRECOMP_TARGETS`,
`CompositionPass.ts:72`) with an `inlineFallback` beyond the cap.

You are right that the same fallback carries two different severity classes:

| | Beyond the cap | Severity |
|---|---|---|
| **Precomp** | Subtree collapses inline, children × container opacity | Slower / loses isolation. **Output still correct.** |
| **Stencil scope** | Collapse changes which layers fall inside the boundary | **Alpha is wrong.** Silently. |

So the spike must answer, in order:

1. **Is `inlineFallback` a legal state for a stencil scope at all?** If the
   answer is no — and I expect it is no — then the cap stops being a tuning
   parameter and becomes a correctness boundary.
2. **What happens at the fifth?** Hard error surfaced to the user, dynamic
   target allocation, or a different mechanism entirely that doesn't consume the
   precomp pool.
3. Only then: where the boundary lives in the render tree, how it generalises
   rather than duplicates `prepareIsolatedPrecomp`, what the layer model must
   carry, and whether that is a schema change (which would retro-gate M8 on M0).
4. Per-frame buffer cost, and confirmation that nothing allocates inside the
   render loop.

**Why this is the whole reason the spike moved up:** if the honest answer to (1)
is "no, and stencil needs its own target lifecycle," then M8 is a **rewrite, not
a generalisation**, and its L estimate is wrong. Learning that in an afternoon is
cheap; learning it at milestone 8 is the failure mode you were guarding against.

- **Risk:** none (no code)
- **Decision gate:** if the spike shows groups constrain M4–M7, reorder then.

### M1 — 13 blend modes + Canvas2D dead-code removal · **S–M** · *runs alone*

Runs alone per your point 2: it carries the dialect-parity trap, the one failure
mode here that produces a green run on wrong output.

- **Files:** `packages/renderer/src/shaders/builtin.ts` (branches in `bChan()`,
  **both** WGSL and GLSL; a `mode >= 12` sibling for Darker/Lighter Color),
  `src/core/effects/blendMode.ts`, `src/core/rendering/snapshotToFrameScene.ts`
  (`advancedBlendId` ids 16–28), `packages/render-tests/harness/scenes/blendModes.ts`
- **Deletes, same commit** (amendment 2): `blendToComposite()` + its test block;
  the dead `layerBlendToGpu()` fallbacks; and the Canvas2D header comments in
  `blendMode.ts:7-11`, `matte.ts:11-12`, `mask.ts:6-7`,
  `snapshotToFrameScene.ts:33-37`, `offlineRenderer.ts:7`
- **Backend reporting:** the `resolvedKind` *assertion* already exists
  (`renderEntry.ts:143`). What's missing is **positive emission** — a green run
  should state which backend each scene actually rendered on, so parity is
  self-documenting rather than inferred from the absence of a throw. Add that to
  the run report (`packages/render-tests/scripts/run.mjs`).
- **Schema:** none — additive enum values, absent from every existing document
- **Tests:** 13 golden scenes per backend; a WGSL-vs-GLSL agreement test per mode
- **Risk:** Medium. The math is not the risk; **dialect parity is**. A branch
  added to WGSL and missed in GLSL passes on a WebGPU dev box and breaks only on
  WebGL2. Mitigated by the existing assertion plus the new emission.
- **Rollback:** revert. Documents carrying a new mode degrade to `normal` via
  `isBlendMode()`'s existing validation — degraded, not corrupt.

### M2 — Mask mode `None` · **S** · *runs alongside M0*

Isolated to mask compositing; touches nothing M0 owns.

- **Files:** `src/core/effects/mask.ts` (`MaskMode` union,
  `maskModeToComposite`, `maskModeStartsFull`, skip in `paintMaskMatte`), mask
  inspector UI
- **Schema:** additive; absent value still defaults to `add` — no migration
- **Semantics:** contributes nothing to layer alpha, stays in the stack as
  addressable geometry. Prerequisite for M6.
- **Tests:** a `none` mask leaves layer alpha byte-identical to no mask at all;
  leading `none` does not trigger `maskModeStartsFull`
- **Risk:** Low
- **Rollback:** revert — `none` masks read back as `add`, which is visible, so
  ship M2 and M6 near each other

### M3 — Matte model → `{ mode, inverted }` + dropdown consolidation · **S–M** · *first schema change*

Per your point 4, consolidation is a deliverable of this milestone, not a
follow-up.

- **Files:** `src/core/effects/matte.ts`; **one shared matte control** replacing
  both `CompositingControls.tsx:86-96` and `Timeline.tsx:1608,1802` (two
  independent hardcoded label maps today);
  `packages/ai-tools/src/tools/write.ts:258`, `toolHandlers.ts:330`,
  `buildContext.ts:24` (prompt text), `lottieImport.ts:697`
- **Not touched:** `snapshotToFrameScene.ts:740` and everything GPU-side
- **Schema:** `'alpha-inv'` → `{ mode: 'alpha', inverted: true }`, ×4.
  **Migration required** — first real consumer of M0
- **Tests:** fixture with all 4 legacy values loads to the new shape; the 4
  existing `composited.ts` matte goldens must be **pixel-identical** (visually a
  no-op — any diff is a bug); one control renders in both hosts
- **Risk:** Medium — highest-touch surface. AI tool schema and prompt must land
  together or the assistant emits rejected values.
- **Rollback:** revert code; **the migration is one-way**. Mitigate by having the
  loader accept both shapes for one release so a revert still opens migrated
  documents. Do not skip this.

### M4 — Alpha Add + Luminescent Premul · **M**

- **Files:** `builtin.ts` (both dialects), `blendMode.ts`, `snapshotToFrameScene.ts`
- **Note:** these write **alpha**, unlike M1's colour-only modes. The shader
  already returns `ao`, so the plumbing exists — the work is per-mode semantics.
  Luminescent Premul needs genuine premultiplied handling; per the settled
  premultiplied-at-decode invariant, it composes with the pipeline rather than
  fighting it.
- **Tests:** Alpha Add's reason for existing is the seam case — two touching
  anti-aliased 50% edges must composite to **opaque**, not 75%. A generic overlap
  scene would not catch a wrong implementation.
- **Risk:** Medium · **Rollback:** revert; unknown modes degrade to `normal`

### M5 — Pipeline-determinism gate (+ Dissolve, Dancing Dissolve) · **M**

Reframed per your point 1. **The harness is the deliverable; Dissolve is what
forces it into existence.** If Dissolve is later cut on value grounds, the gate
stays — and M8 is the milestone that will need it most, since stencil scopes
stress buffer reuse and offscreen target lifecycle far harder than a dissolve.

**Primary deliverable — deepen the existing gate** (`renderEntry.ts:177-186`),
which today re-renders from the *same snapshot* and so tests only renderer
determinism (§0.0):

1. **Rebuild the snapshot** for the second render instead of reusing `snap`.
   This is the change that makes the gate able to see snapshot-level
   nondeterminism at all — i.e. the wall-clock-seed class of bug.
2. **Cover every frame**, not just `scene.frames[0]`.
3. **Cross-path comparison:** render frame N through the harness and through
   `offlineRenderer`, assert identical bytes. This is the direct mechanical
   check of "preview and export must match" — currently asserted by shared code
   paths but never tested end to end.
4. **Frame-index recovery assertion** (your off-by-one point): for a spread of
   frame indices and fps values including awkward ones (23.976, 29.97, 59.94),
   assert `round((index / fps) · fps) === index` exactly. Float division then
   rounding *is* exact for these ranges — the test costs nothing and documents
   the invariant rather than leaving it as folklore.

**Secondary — the feature:** Dissolve (static `seed`) and Dancing Dissolve
(`seed` from frame index). Files: `builtin.ts` (hash + threshold, both dialects),
`blendMode.ts`, `snapshotToFrameScene.ts` (seed uniform).

- **Risk:** Medium. Deliverables 1–2 may **surface pre-existing
  nondeterminism elsewhere** in the pipeline — that is a feature of the
  milestone, but it could expand scope. If it does, I stop and report rather
  than fixing unrelated findings inside this milestone.
- **Rollback:** the gate and the feature are separate commits. Revert Dissolve
  without losing the harness.

### M6 — Effect-scoped masking · **M–L**

- **Prerequisite:** M2
- **Files:** effect descriptor in `src/core/effects/effects.ts` (optional
  `maskId` scope), per-layer effect chain `CompositionPass.ts:320`, effect
  inspector UI
- **Schema:** additive optional field; absent = today's behaviour
- **Semantics:** mask feather drives effect edge falloff, mask opacity drives
  intensity. **An effect mask must not modify layer alpha** — the invariant to test.
- **Tests:** a blur scoped to a mask leaves pixels outside the mask *and the
  layer's alpha* untouched
- **Risk:** Medium–High — first change to the shared effect chain that matted,
  advanced-blended and 3D layers all route through. **Feature-flag this one.**
- **Rollback:** flag off, then revert

### M7 — Responsive time / protected regions · **M–L**

- **Files:** time evaluation in `buildSnapshot.ts`, timeline UI, template
  manifest in `templateTypes.ts`
- **Schema:** additive
- **Critical:** `getRemappedTime` is the **only** axis keyframes are sampled on.
  Protected-region stretching must compose into that one function, not add a
  parallel time path — a second axis would silently desync keyframes from the
  clip bar.
- **Tests:** stretch a template 2×; intro/outro keyframe times unchanged, only
  the unprotected middle scales
- **Risk:** Medium–High — touches time evaluation, which everything reads
- **Rollback:** revert; documents without regions unaffected

### M8 — Stencil / Silhouette · **L** *(estimate confirmed by M0.5)*

> ### DECISION POINT D1 — generalisation or rewrite? — **RESOLVED 2026-08-03**
> **Owner:** engineering · **Input:** [`COMPOSITING_GROUPS_SPIKE.md`](./COMPOSITING_GROUPS_SPIKE.md)
> **Resolution: generalisation. L stands, not revised.** The boundary
> (`prepareIsolatedPrecomp`), the target pool, the "a group is just a layer"
> downstream contract and out-of-render-loop allocation all already exist.
> **Two things changed as a result:**
> - The `PRECOMP_TARGETS` cap is **nesting depth, not group count** — 100 sibling
>   stencils cost one slot. The cap is not the blocker it was assumed to be.
> - M8's dependency on M0 **downgrades from a gate to a maybe** (spike §6).

> ### DECISION POINT D2 — cap behaviour — **RESOLVED 2026-08-03, with a split**
> `inlineFallback` is **not legal** for a stencil scope: collapse changes which
> layers are inside the boundary, so the alpha is wrong rather than slow.
> **Resolution — the behaviour differs by surface, and the asymmetry is the point:**
>
> | Surface | Behaviour | Why |
> |---|---|---|
> | **Preview** | Degrade and warn — render the group without the stencil, surface via the existing `EngineError` / tier-badge channel | The warning reaches the person who can act on it. Wrong pixels on screen are recoverable. |
> | **Export** (`offlineRenderer`) | **Fail the render** | The same warning during an export is a log line next to a file someone is about to ship. Wrong pixels encoded into a delivered MP4 are not recoverable. |
>
> This split becomes **M8a**, built once and applied at both the stencil boundary
> and `CompositionPass.ts:1057` (finding F1).

Milestone 8 is now three, because the cap-fallback mechanism is shared with a
live bug and should not wait behind an L.

### M8a — Cap-fallback mechanism (D2) · **M**

- **Builds:** the degrade-and-surface path — preview warns via `EngineError`,
  export fails hard. One implementation, two call sites.
- **Files:** `CompositionPass.ts` (fallback branch), the `EngineError` emit path
  in `MotionRendererBackend`, `offlineRenderer.ts` (fail-on-degrade)
- **Tests:** preview degrade emits exactly one surfaced error and still renders;
  an export that would degrade **throws** rather than writing frames
- **Risk:** Medium — introduces a new failure mode into the export path, which
  must fail cleanly rather than half-writing a file
- **Rollback:** revert; behaviour returns to today's silent fallthrough

### M8b — F1: matte-source cap fallback · **S**

The live bug, fixed with M8a's mechanism. Sequenced **immediately after M8a** —
a known silent correctness bug that is filed but unscheduled is filed forever.

- **Files:** `CompositionPass.ts:1057` (`inlineFallback: false` → surface, don't
  fall through) and the `:1068` fallthrough comment
- **Today:** past the depth cap, `matteTex` is null, the combine is skipped, and
  a layer that should be cut to a shape **renders whole, silently**
- **Tests:** a precomp matte source beyond `MAX_PRECOMP_DEPTH` surfaces an error
  in preview and **fails** an export, rather than rendering unmatted
- **Risk:** Low–Medium. Some project that currently renders "fine" (wrongly) will
  start reporting an error. That is the fix working, and worth a release note.
- **Rollback:** revert

### M8c — Stencil / Silhouette · **L**

- **Prerequisite:** M8a
- **Benefits from:** M5's cross-path gate — this is where buffer reuse and
  offscreen target lifecycle get stressed hardest
- **Work is in:** the scope model (which layers are in which group) and cap
  behaviour — *not* the render plumbing (spike §8)
- **Risk:** High — the only genuinely architectural item
- **Rollback:** feature-flag; without groups the 4 modes are absent from the menu
  rather than half-working

### M9 — Variable-width feather · **L**

- **Files:** `mask.ts` (per-vertex width channel), `paintMaskMatte` rasteriser
- **Schema:** additive — optional feather points; absent = today's scalar
- **Risk:** Medium, contained to one function
- **Rollback:** revert; scalar feather is the fallback

---

## 2. Prerequisite graph and concurrency

```
┌─ M0 (migration hook) ─┬──────────────────► M3 (matte model + dropdown) ─┐
│                       ├─► M6 ◄── M2       ├──────────────────► M7       │
│                       └───────────────────┴──────────────────► M9       │
└─ M2 (mask None) ──────────────────────────► M6 (effect masking)         │
   ▲ concurrent with M0                                                   │
                                                                          │
   M0.5 (group spike) ──────────────────────► M8 (stencil)                │
              │                                                           │
              └── decision gate: may reorder M4–M7, may re-estimate M8 ◄───┘

   M1 (13 modes + cleanup) ──┬──► M4 (Alpha Add / Lum Premul)
   ▲ runs ALONE              └──► M5 (determinism gate + Dissolve) ──► helps M8
```

**Concurrency, per your point 2:**

- **M0 ∥ M2** — overlap. M2 is small, isolated to mask compositing, touches
  nothing M0 owns, and needs no migration.
- **M1 alone** — not for migration coupling, but because the dialect-parity trap
  is the one failure mode that yields a green run on wrong output. Concurrency
  would spend review attention on the milestone least able to afford it.
- **M0.5** can run in parallel with anything — it produces a document.
- Everything after M3 is serial.

**Gates:** M0 gates every schema-touching milestone (M3, M6, M7, M9 — and M8 if
the spike finds a layer-model field is needed). M1 gates M4 and M5. M0.5 gates
M8's *shape and estimate*, not just its start.

---

## 2b. Findings logged, not fixed

Surfaced while executing M0/M0.5/M2. Catalogued rather than absorbed.

| # | Finding | Severity | Proposed |
|---|---|---|---|
| **F1** | A precomp used as a **matte source** beyond the depth cap renders the matted layer **UNMATTED, silently** (`CompositionPass.ts:1057` → `:1068`). Pre-existing, unrelated to stencil, same severity class as the risk D2 exists to prevent. | Correctness, latent | **SCHEDULED as M8b (S)**, immediately after the M8a mechanism it shares. Not folded into stencil work, where it would be invisible in review. |
| **F4** | **The local test suite silently ran 13 fewer test files than a clean checkout** — 392 vs 405 discovered, ~533 tests, including `editorBoot.smoke.test.tsx`. Files present on disk and tracked at HEAD; jest returned nothing even when pointed directly at them. Not a cache issue. Same directories `git stash` failed on with "Permission denied". | **Process, high** | **RESOLVED 2026-08-03** — repo moved `OneDrive/Desktop/motion-editor` → `C:\Users\isroi\dev\motion-editor`. Discovery now 405/405; full suite 488 suites / 5739 passing / 0 failures. |
| **F5** | `bevelWorkingBuffer.test.ts:119` asserts `expect(capped.ms).toBeLessThan(full.ms)` — **a wall-clock performance assertion inside a correctness suite**. Failed once under full-suite load, then green 3/3. It will flake on any loaded machine, and CI is a loaded machine. Compounded by F4: it only ever ran in environments not used locally, so F4 was hiding *failures*, not just tests. | Test integrity | Assert the invariant it proxies for (bounded work / buffer size), or move it to a benchmark that does not gate a merge. **Filed, not fixed.** |
| **F2** | Render gates test `mask.paths.length > 0`; an all-`none` stack therefore still runs one redundant full-frame matte fill. Correct output, wasted pass. | Perf, minor | Move gates to `hasActiveMaskPaths` when that path is next touched (M6). |
| **F3** | Precomp targets are the heaviest in the graph (viewport × `rgba16float` × depth × MSAA 4, ×4). No test asserts a memory ceiling. | Perf, unmeasured | Consider a cheaper 2D-only pool for stencil scopes; measure first. |

## 3. Not scheduled

| Item | Effort | Why deferred |
|---|---|---|
| Template dropdown field kind | S | Cheap; fold into M7 if wanted |
| Template data binding (CSV/JSON) | M | Independent |
| Mask vertex-count morph | M | Current snap behaviour is honest and documented |
| 1.0-gamma blending toggle | M | After §9, as you said — float16 precision is already there |
| Mask tracking / AI roto | L | Out of scope |

---

## 4. Lottie

Every mode in M1, M4, M5 and M8 is unrepresentable in Lottie export, as are M6
and M9. M3 and M7 are safe. No Lottie work is scheduled — flagging that the gap
widens with each blend milestone, and that Lottie export should **degrade loudly
rather than silently writing a wrong mode**. Worth its own milestone; say if you
want it scoped.

---

## Stopping here

No code written. On approval I start with **M0 and M2 in parallel**, then M1
alone, waiting for sign-off between milestones.

**M0.5 is worth starting immediately** — it is a document, it blocks nothing, and
its answer to "is `inlineFallback` legal for a stencil scope" may re-estimate M8
from generalisation to rewrite. That is the finding most worth having early.
