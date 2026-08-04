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

### M5b — One source of truth for "is this layer baked" (F6) · **S–M**

Scheduled **before M6**, because `hasActiveMaskPaths` is about to become a fourth
gate in the same family. Not folded into another milestone.

**The class, stated properly:** bake ownership is expressed by more than one
predicate, and they can disagree. This is not a typo — it is two predicates never
reconciled:

| Site | Gates on |
|---|---|
| `Canvas2DVectorRasterizer` | `layerNeedsCpuBake` |
| `snapshotToFrameScene` (was) | `effectsNeedCpuBake` |
| `effectBake.imageNeedsCpuBake` | its own kind check |
| M6 will add | `hasActiveMaskPaths` |

`layerNeedsCpuBake` and `effectsNeedCpuBake` differ: **fill opacity alone sends a
layer down the bake path with no effect requiring it.** So the rasterizer baked
the grade, LUT, mask and spatial effects into the texture, the GPU side did not
know, and applied them again. Everything twice.

**Why it is a class and not an incident:** `fill-opacity-zero-stroke` was correct
at HEAD, wrong mid-branch, and correct again only because of which commits landed
together. Nothing in the golden set would have caught it had the branch ended one
commit earlier. Three sites kept in sync by attention is the defect; a fourth
makes it worse.

- **Fix:** one predicate — `layerIsBaked(layer)` — that every site calls. Not
  three call sites kept aligned by review.
- **Files:** `src/core/effects/effectBake.ts` (the single source),
  `src/core/rendering/snapshotToFrameScene.ts`,
  `src/core/rendering/raster/Canvas2DVectorRasterizer.ts`
- **Tests:** a property test that the rasterizer and the frame-scene builder
  return the same answer for every combination of (kind, effects, fill opacity,
  mask) — the disagreement itself is what to assert on, not one repro
- **Risk:** Medium — touches the routing every layer goes through
- **Rollback:** revert; the predicates diverge again

### M6 — Effect-scoped masking · **M–L**

- **Prerequisite:** M2, M5b (or M6 adds the fourth gate to an unfixed family)
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

## 2·0 A HABIT OF THIS CODEBASE: two consumers, one truth, nothing enforcing agreement

**This is not a finding. It is the shape most of the findings turned out to
share, and it is worth carrying as a review lens rather than rediscovering.**

Each of these was found independently. They are the same bug:

| Where | The two consumers | What disagreed | Symptom |
|---|---|---|---|
| **F6 / M5b** | `snapshotToFrameScene` and `Canvas2DVectorRasterizer` | Two of three bake predicates, chosen by hand per call site | Effect chain applied **twice** |
| **F10** (suspected) | `RenderGraph.compile()` and pass `execute()` | `EffectPass.activeColorTarget` — a mutable static read through getters, behind a **memoized** compile | Compile-time and execution-time see different values |
| Style presets | The `StylePresetCategory` union and a hand-written category array | `'material'` simply absent from the array | **Six presets unreachable** |
| Effect folders | The `EffectType` union and an if-chain with a catch-all | Everything unlisted fell into one bucket | **24 of 38** effects in the junk drawer |
| Viewport attach | `useEffect` deps (ref objects) and the refs' actual contents | Deps never change identity, so null-on-first-tick never retried | Spinner up **forever** |

**The pattern:** a value has two independent readers and nothing forces them to
agree. Nothing throws, nothing logs, and the result looks finished.

**Why it recurs here:** this codebase is full of *legitimate* dual consumers — a
CPU raster path and a GPU path, a compile step and an execute step, a type union
and its presentation. That is good architecture. The failure is not having two
readers; it is letting the AGREEMENT live in someone's attention instead of in
the code.

**What fixes it, strongest first — all three were used on this branch:**

1. **Remove the choice.** `layerIsBaked(layer)` dispatches on kind internally, so
   no call site can pick wrong (M5b). The disagreement becomes unrepresentable.
2. **Make omission a compile error.** A `Record` keyed by the union rather than
   an array or an if-chain: adding a member without filing it stops the build
   (style presets, effect folders).
3. **Assert agreement across the input space.** `bakeOwnership.test.ts` sweeps
   4 kinds × 6 stacks × 4 fill opacities — and asserts that no *single* old
   predicate was correct everywhere, which proves the refactor was necessary
   rather than merely working.

### The sharpest example: a comment where an enforcement should be

`SceneGraph.ts:154` documents that `get components()` returns a copy **so that**
`node.components.find(...).props.x = …` writes are discarded — and adds "callers
all over the app do this".

Someone knew. They wrote it down. And writing it down is what made it permanent:
a comment describes a hazard, it does not prevent one. The behaviour then cost a
real bug (M7's `setResponsiveTime`, which compiled, passed every test, and did
nothing) and left ~118 unclassified call sites behind it.

The lint rule added for F11 is the enforcement that comment should have been.
**When you find yourself documenting a footgun, ask whether the same effort
spent on a rule would have removed it instead.**

**As a review lens:** ask of anything new — *who else reads this value, and what
makes them agree?* If the answer is "we keep them in sync", that is the bug, not
the mitigation. F10's suspected mechanism was found by asking exactly that.

### The variant that is hardest to see: a MOCK is a second implementation

`setResponsiveTime` mutated `component.props` in place. Unit tests passed, `tsc`
passed, and the control did nothing — because the test mocked the scene graph
with a plain object that RETAINS mutations, while the real graph rebuilds a fresh
copy on every read.

That is not a coverage gap. **The mock modelled a different system than the one
shipping**, so the tests were correct about a data structure we do not have. Same
pattern in a new costume: the mock and the real graph are two implementations of
one contract, kept in agreement by attention.

Two things to carry:

1. **A test double must model the real contract's SHAPE, not just its surface.**
   If the real thing returns copies, the double must return copies. The fixed
   mock does, and models `writeProp`, so this bug would now fail the suite.
2. **It was caught only by driving the real UI** — and this has now happened
   twice. M2 shipped a mask mode with no picker entry; M7 shipped a time model
   with no marking UI. Both times the model was assumed correct because tests
   were green, and both times building the UI is what exercised the real write
   path.

   **So: land the UI alongside a model change, not after it.** Not for tidiness —
   the UI is what proves the model is *reachable*, and reachability is precisely
   what unit tests are least able to check.

## 2a. Method: revert-and-verify is required for golden attribution

**A plausible cause and a verified cause read identically in a report. Only one
survives contact.**

Whenever a reference image changes, the cause must be established by REVERTING
the candidate and re-running the gate — never by reading the diff and reasoning
about it. Two cases from this branch:

- I attributed the three glow goldens to the `layerStyles` rework. Reverting
  proved it was `CompositionPass` optical bloom; `layerStyles` moves no golden
  at all.
- `builtin.ts` is a premultiplied-alpha fix in `FRACTAL_NOISE` — a completely
  convincing explanation for a noise golden moving, and **wrong**: those scenes
  bake noise on the CPU, so the GPU noise shader never runs. Reverting it left
  every scene passing.

The second is the sharper case. A correct-sounding falsehood would have gone
into the permanent record with nothing to contradict it.

The check is cheap (`run.mjs --scene <id>`) and the failure mode is invisible
without it. It also produces the right commit message for free: "reverting ONLY
these files fails exactly these scenes."

## 2c. F10 — diagnosis, and why it is M1 unfinished

**M1 shipped 13 blend modes. On a transparent comp — which is how most
compositions start — those modes render non-deterministically.** That is not a
prerequisite for a later milestone; it is the feature not being finished. It also
threatens the one hard rule set at the start, because nondeterministic output
means preview and export can disagree.

### What is established, by measurement

| | |
|---|---|
| **Trigger** | A **transparent comp** AND at least one **advanced-blend** layer. Both are required. |
| **Not the trigger** | Not mode-specific — first seen on `alpha-add`, reproduces identically on `multiply`. Not the transparent comp alone: the same scene with **normal** blend is fully deterministic. |
| **Not scene ordering** | Reproduces with `--scene blend-alpha-add-seam` in isolation, so it is not contamination from a previously-rendered scene. |
| **Shape** | **Accumulating, not alternating.** Renders 1v2, 2v3, 3v4 *and* 1v3 all differ. A two-state flip would have made 1v3 identical. |
| **Magnitude** | 33 600 pixels — **exactly the union of the two rectangles** (2 × 120×140). `maxDelta 64` = 255 − 191, precisely the gap between "Alpha Add applied" and "not applied". |
| **Per backend** | WebGPU: alpha channel only (`r/g/b/a = 0/0/0/33600`). WebGL2: all four channels equally — the expected consequence of premultiplied storage when alpha moves. |

### Blast radius — the golden set has NOT been lying

Instrumenting the gate to *report* instead of throw, then running the full suite,
found **exactly one affected scene: the unregistered `blend-alpha-add-seam`.**
No committed golden uses transparent-comp + advanced-blend, so nothing in the
reference set has been passing by luck. This is a genuinely new input
combination, not a long-standing hole.

> **Re-measured after F12 widened the trigger.** The conclusion above was scoped
> to "transparent comp + advanced blend" and did not automatically survive that
> widening, so the sweep was re-run: report-instead-of-throw, **four** renders
> per scene, full suite, with the parked scenes registered. Affected set: the
> four Matte scenes plus `blend-alpha-add-seam`. **Still no committed golden.**
>
> The four renders were what named the cause. Differing pixels were exactly
> those with FRACTIONAL resulting alpha — ~1 250 for the Alpha modes (the
> ellipse's anti-aliased rim alone), ~25 700 for the Luma modes (the whole
> interior, scaled by the matte's brightness). Consecutive diffs shrank
> (1247 → 1133 → 1008) while 1v3 and 1v4 stayed pinned at the 1v2 value:
> converging, never returning. Feedback, not noise — which pointed straight at
> a destination that is read as well as written.

### Hypothesis tested and KILLED

The predicted signature of an uninitialised/unsynchronised `SCENE_COLOR_TARGET`
read was: results vary with prior target contents, and stabilise if the target is
explicitly cleared before the first blend. Both halves fail.

- `ClearPass` **already clears** `EffectPass.activeColorTarget` every frame.
- Adding an explicit `Color.transparent()` clear at the top of
  `CompositionPass.execute` **did not stabilise** the scene — and broke
  `effect-blur` / `effect-glow`, which legitimately read that target.

So it is not a missing clear.

### Where the evidence points, unconfirmed

The advanced-blend path (`CompositionPass.ts:1275-1299`) already avoids the
obvious self-sample: it copies the backdrop to `MATTE_TARGET` before combining
("can't sample a target while writing it"). The remaining suspect is the
interaction between `EffectPass.activeColorTarget` — a **mutable static shared by
every Renderer instance** — and `RenderGraph.compile()`, which is **memoized**
while `ClearPass.writes` / `BackgroundPass.writes` are *getters* reading that
static. Pass ORDER can therefore be compiled against one target name while
execution routes to another, and `graph.invalidate()` fires only when
`effectPass.enabled` flips, not when the target changes.

Stated as a suspect, not a conclusion. It has not been confirmed.

### Why it is parked rather than fixed

Confirming and fixing this means changing pass ordering or target routing on the
advanced-blend path — the path 30+ committed goldens depend on. That is an L, and
the timebox says park it with the diagnosis written down rather than open it
mid-run.

### M-F10 — Fix advanced-blend determinism · ~~**L** · scheduled~~ · **DONE** (S)

**Fixed.** `EffectPass` blitted the offscreen scene target onto the SURFACE with
source-over, while `ClearPass.writes` is `[EffectPass.activeColorTarget]` — so
when that pass is enabled the per-frame clear goes to `SCENE_COLOR_TARGET` and
**nothing clears the surface**, which that blit is the only writer of. Any
partial alpha in the finished frame therefore mixed in the previous frame and
converged toward opacity. Opaque frames were unaffected, since source-over at
a = 1 is a replace — which is why it survived this long. The blit now replaces.

Sized L on the assumption that it meant changing pass ordering or target
routing on the path 30+ goldens depend on. It did not: the routing was always
correct, the destination simply was never cleared. One line, plus the
explanation.

**The trigger row above is wrong** and is corrected by F12: it is not "a
transparent comp AND an advanced blend". Stencil and Silhouette reproduce it on
a fully OPAQUE comp, because scaling the backdrop's coverage is what they do.
The condition is *any partial alpha surviving to the surface* on a path where
the surface is never cleared. A transparent comp was simply the most common way
to get there.

The suspect recorded in "Where the evidence points" — `activeColorTarget` as a
mutable static behind a memoized `compile()` — **is not implicated**. Killed the
same way the missing-clear hypothesis was.

- **Acceptance — met.** All five parked scenes registered (four Matte +
  `blend-alpha-add-seam`), byte-identical across four consecutive renders on
  both backends, gate green. Alpha Add's seam closure demonstrated at **255**.
- **Blast radius, re-measured** at the wider characterisation: still exactly the
  parked scenes. **No committed golden was affected**, and none was re-blessed —
  only the five new ones, each verified on its defining properties first
  (`scripts/verify-matte-modes.mjs`).
- **Found in passing:** the seam scene did not demonstrate its own claim. Its
  rectangles abutted exactly, so no pixel had both layers contributing and there
  was nothing for Alpha Add to sum — it measured 128 with a coverage dip to 108.
  They now overlap by 10 px. Invisible until the determinism fix let the scene
  run at all.
- **F13, logged not fixed:** the two backends read back under different
  conventions. WebGL2 reads the drawing buffer (premultiplied); the WebGPU path
  goes through `drawImage` + `getImageData` (unpremultiplied). Same engine
  output, different encoding — worth confirming how much of the standing
  webgpu-vs-webgl2 parity gap on partial-alpha scenes this accounts for.

## 2b. Findings logged, not fixed

Catalogued rather than absorbed.

| # | Finding | Severity | Proposed |
|---|---|---|---|
| **F14** | **FIXED (multi-subpath geometry).** ~~Trim Paths does not trim — it only trims the stroke.~~ `buildSnapshot.ts:1986` writes `layer.trim = segs`, and that field has exactly two non-test readers: the content-hash cache key (`contentHash.ts:52`) and `strokeTrimmed`, called only inside the stroke branch (`Canvas2DVectorRasterizer.ts:458`). The fill runs `shapePath → ctx.fill()` **unconditionally**, above it and independent of it (`Canvas2DVectorRasterizer.ts:445-452`). AE's Trim Paths cuts **the path itself**, so the fill follows the trim. Ours is wrong against AE for **any filled shape**, today, in shipped builds — and a new shape layer defaults to a solid fill (`#2B7EFF`), so this is the common case, not an edge one. Found while deciding whether `trim` folds into `fx.pathOps`. **This is a correctness defect, not a missing feature** — "trim doesn't fold into the stack" and "trim doesn't trim fills" get prioritised very differently, and the second is the true one. | **Correctness, live** | Fix = the multi-subpath prerequisite: lift `Pt[][]` — already produced by `trimPolyline` (`trimPath.ts:191`), the only such producer, currently consumed entirely inside `strokeTrimmed` and never escaping into the render contract — into `RenderLayer`, and teach the **rasterizer, content hash, hit-testing and bbox** about subpath lists. **The fix and the `trim`/`rep` fold-in prerequisite are the same work**; one change unblocks both. **Deliberately breaks byte-identity** for filled+trimmed shapes, so it ships as an announced **behaviour change with a release note**, not a silent migration — same treatment as the curves interpolation change and F1's error surfacing (M8b). Design context: `PREMATION_COMPLETE_REFERENCE.md` §17.5. |
| **F1** | A precomp used as a **matte source** beyond the depth cap renders the matted layer **UNMATTED, silently** (`CompositionPass.ts:1057` → `:1068`). Pre-existing, unrelated to stencil, same severity class as the risk D2 exists to prevent. | Correctness, latent | **SCHEDULED as M8b (S)**, immediately after the M8a mechanism it shares. Not folded into stencil work, where it would be invisible in review. |
| **F4** | **The local test suite silently ran 13 fewer test files than a clean checkout** — 392 vs 405 discovered, ~533 tests, including `editorBoot.smoke.test.tsx`. Files present on disk and tracked at HEAD; jest returned nothing even when pointed directly at them. Not a cache issue. Same directories `git stash` failed on with "Permission denied". | **Process, high** | **RESOLVED 2026-08-03** — repo moved `OneDrive/Desktop/motion-editor` → `C:\Users\isroi\dev\motion-editor`. Discovery now 405/405; full suite 488 suites / 5739 passing / 0 failures. |
| **F6** | **Bake ownership is expressed by more than one predicate and they can disagree.** `snapshotToFrameScene` gated on `effectsNeedCpuBake`, the rasterizer on `layerNeedsCpuBake`; fill opacity alone triggers a bake without any effect requiring it, so both sides claimed the chain and effects applied twice. Third instance of the family (after ea47497 "which side may bake" and b814e3a "what the bake can draw"). `fill-opacity-zero-stroke` was correct at HEAD, wrong mid-branch, correct again by luck of commit order — no golden would have caught it one commit earlier. | Correctness, class | **SCHEDULED as M5b**, before M6 — `hasActiveMaskPaths` is about to become a fourth gate. Fix is one `layerIsBaked()` source of truth, not three sites kept in sync by attention. |
| **F7** | **Bisect hazard in this branch's range:** `vectorDraw.ts` alone makes `fill-opacity-zero-stroke` *worse* (9.572%) than not applying it at all; only the coupled set (`layerStyles` + `vectorDraw` + `paint/fill`) passes. Anyone bisecting b814e3a would land on a commit that looks like the culprit and is not. | Process | Recorded in b814e3a's message. No fix — the coupling is real, the note is the mitigation. |
| **F11** | **In-place mutation of `node.components[...].props` is silently discarded, and production does it in at least four files.** `SceneGraph`'s `get components()` rebuilds fresh objects every read — deliberately, per its own comment at `SceneGraph.ts:154`: *"it is a copy so that `node.components.find(...).props.x = ...` writes land in a throwaway and are discarded (callers all over the app do this)."* Proven empirically by the `setResponsiveTime` bug. The `getNode` → in-place-write shape appears in `ai/toolHandlers.ts`, `ai/recipes.ts`, `scene/sceneInsert.ts` and `commands/clipboard.ts`. **NOT verified which individual sites are live defects** — many are probably harmless (building a node before `addNode`), and layer insertion demonstrably works, so something compensates on that path. Determining which are broken is the audit; this is the finding that one is needed. | **Correctness, unknown scope** | Its own audit. Fix is `writeProp`, as in `responsiveTimeStore.ts`. A lint rule banning assignment into a `getNode()` result would close the class permanently. |
| **F10** | **Advanced blend + transparent comp = accumulating non-determinism, both backends.** See the full diagnosis in §2c. | **Correctness, high** | **PARKED as real work — see M-F10 below.** Diagnosed, not fixed: the fix touches the advanced-blend path that 30+ goldens depend on. |
| **F9** | The three Classic blend modes (`classic-color-burn`, `classic-color-dodge`, `classic-difference`) ship as **compatibility aliases**, not distinct maths. The Classic branches were written as the unclamped forms; the output clamp collapses them onto the modern ones. Verified by rendering both and comparing, which is how the intent was found to be wrong. | Fidelity gap | Documented in `blendMode.ts` and the shader. Closing it needs AE's actual pre-7.0 formulas, which we do not have. |
| **F8** | `add` and `linear-dodge` are the same operation in AE but take different code paths here — `add` uses fixed-function additive blending on premultiplied values, `linear-dodge` goes through BLEND_COMBINE. Measured divergence: 218/2367 sampled pixels, **peak 1 level**. Rounding, not semantics. | Cosmetic | Routing `add` through the combine would unify them and re-bless one golden. Not done; the difference is below perceptual threshold. |
| **F5** | `bevelWorkingBuffer.test.ts:119` asserts `expect(capped.ms).toBeLessThan(full.ms)` — **a wall-clock performance assertion inside a correctness suite**. Failed once under full-suite load, then green 3/3. It will flake on any loaded machine, and CI is a loaded machine. Compounded by F4: it only ever ran in environments not used locally, so F4 was hiding *failures*, not just tests. | Test integrity | Assert the invariant it proxies for (bounded work / buffer size), or move it to a benchmark that does not gate a merge. **Filed, not fixed.** |
| **F2** | Render gates test `mask.paths.length > 0`; an all-`none` stack therefore still runs one redundant full-frame matte fill. Correct output, wasted pass. | Perf, minor | Move gates to `hasActiveMaskPaths` when that path is next touched (M6). |
| **F3** | Precomp targets are the heaviest in the graph (viewport × `rgba16float` × depth × MSAA 4, ×4). No test asserts a memory ceiling. | Perf, unmeasured | Consider a cheaper 2D-only pool for stencil scopes; measure first. |

## 2b-bis. Release note — Trim Paths cuts the path (F14, FIXED)

**Behaviour change. Filled + trimmed shapes look different after this build.**

Trim Paths used to trim only the **stroke**: `layer.trim` was read inside the
rasterizer's stroke loop and the fill traced the whole shape above it,
unconditionally. AE cuts the path itself and the fill follows, so any filled
shape with a trim was wrong — and a new shape layer defaults to a solid fill
(`#2B7EFF`), so it was wrong for the common case, not an edge one.

What changes on screen:

  * A **filled** trimmed shape now shows the trimmed region, closed implicitly
    from the trim's end back to its start — the wedge AE draws. It used to show
    the whole fill with a partial outline drawn over it.
  * A trim whose window is **empty** (`start >= end`) now draws nothing. It used
    to draw the entire fill: the stroke rendered no arcs and the fill ignored
    the trim, so "trim it all away" showed a solid shape.
  * **Stroke-only** shapes (no fill, or a fully transparent one) are unaffected.

Nothing in the document changes — `fx.trim` is untouched, there is no schema
bump and no migration. This is entirely a render-time fix, so re-opening an old
project simply renders it correctly. Announced rather than silent, on the same
grounds as the curves-interpolation change and F1's error surfacing (M8b).

**Known gap, unchanged by this work:** a rect's **rounded corners are not
sampled** into the trim outline — the cut follows the four hard corners. That
was already true when only the stroke was trimmed; the fill now inherits it.
See `outlinePolyline` in `raster/vectorDraw.ts`.

**Phase 3 gate — measured, not assumed.** Folding `trim` into `fx.pathOps` was
blocked on whether reorder arrows would be inert. They are not: at a 37% trim,
moving a trim card past **every one of the six operators** changes the geometry
(zigzag, roundCorners, pucker, twist, offset, roughen). The one equal case —
zigzag at exactly 50% of a rect — is a coincidence of trimming precisely at a
vertex, not a property. Measured in the running app against the real modules.
The **repeater** is a different answer: see F16.

## 2b-ter. Found while fixing F14 — logged, not fixed

| # | Finding | Severity | Proposed |
|---|---|---|---|
| **F15** | **FIXED.** **The `shape-path-op-zigzag` golden had not exercised a path operator since schema 1.3.0.** The harness scene calls `graph.setPathOp('z', …)` (`render-tests/harness/scenes/shapes.ts:89`), but `SceneGraph` renamed that method to `setPathOps` in `85aa8ac` and nothing updated the scene. Every run since then logs `TypeError: n.setPathOp is not a function` and renders a **plain stroked rect**. The scene is marked `known-divergent`, so its failure is not gated and the error scrolls past. The `pathEscapePadding` proof it cites as evidence is therefore **inert at the pixel level** — the unit test still pins the arithmetic, but no golden confirms it. Not fixed here: repairing it re-blesses a golden for a reason unrelated to trim, which is exactly the attribution mistake this work was told to avoid. | **Test integrity, high** | Rename to `setPathOps` with an array, re-bless `shape-path-op-zigzag`, and confirm the new pixels show a zigzag. Consider failing the run on `[render-fails]` even for `known-divergent` scenes — a scene that did not BUILD is not a scene with an accepted visual gap. |
| **F16** | **STILL BLOCKING, and Phase 3a shipped without it.** **The repeater cannot fold into `fx.pathOps` without losing `offsetOpacity`.** Copies are emitted as N `RenderLayer`s sharing one geometry and differing by transform deltas. Making a repeater card's POSITION in the chain meaningful requires baking the copies into geometry — now expressible as N subpaths — but a `Subpath` carries no paint, so per-copy **opacity** (and any future per-copy fill) has nowhere to live. Folding it in as-is would ship a reorder control that works while silently dropping a parameter users already animate (`rep.offsetOpacity` is keyframeable). | **Design, blocking Phase 3b** | Either add per-run paint to the render contract first — a strictly larger change than the subpath lift — or fold in `trim` alone and leave the repeater on its fixed final position, documented as such. Do **not** ship a repeater card whose arrows move a control that cannot carry its own parameters. |
| **F17** | **FIXED.** **`rasterPadding` read bezier handles as RELATIVE; every other consumer reads them as ABSOLUTE.** `BezierPoint.inX/outX` are documented absolute ("Equal to (x,y) for a corner", `packages/workspace/src/math/BezierPoint.ts:7`) and `shapePath` passes them straight to `ctx.bezierCurveTo`. `rasterPadding` computes `p.x + (p.inX ?? 0)` (`raster/vectorDraw.ts:225`), which for a corner doubles the coordinate and over-pads by the point's own distance from the origin. Harmless today — over-padding is transparent margin — but it is two readers of one field disagreeing on its units (§2·0), and the `pathEscapePadding` suite was authored to the wrong convention (`inX: 0`), so it pins the bug rather than catching it. Carried through the subpath lift **verbatim**, deliberately: correcting it shrinks the raster and would perturb `shape-path-op-zigzag`, whose reference was blessed with the over-pad — and see F15 for why that scene cannot currently confirm anything. | **Correctness, latent** | Fix after F15, so the golden that measures path escape is actually measuring a path operator when the padding changes. |

## 2b-quater. Closed 2026-08-04 — F15, F17 and Phase 3a

**F15 — the dead golden.** Corrected from how it was first written up: the
scene did not render "a plain rect", it rendered **nothing**, and its committed
reference was a correct zigzag all along. `build` threw, no frame was written,
and `!actual` was routed by `gpuParity: 'known-divergent'` into the
ACCEPTED-GAP bucket — the `divergence` prose that exists to stop silent
suppression was the thing suppressing it. Two guards landed, and the guards
matter more than the golden: a pre-flight pass builds every scene before
anything renders and aborts the run on any throw, and the comparator no longer
lets a missing frame count as an accepted gap whatever its `gpuParity` says.
Verified in that order — with the guard in and the scene still broken, the run
fails loudly. No re-bless was needed; the repaired scene reproduces its
existing reference exactly, which also retired its stale `known-divergent`
marking. Swept the other 21 `graph.*` setup calls: `setPathOp` was the only
one that did not exist.

**F17 — the handle convention.** Fixed, and pixel-identical afterwards, which
is the proof it was correct rather than merely different: nothing was ever
being clipped, the raster was simply 3.74× larger than needed (522² where 270²
suffices, on every shape carrying a path operator). Not a §2·0 with a split
population — `mask.ts`, `mergePaths.ts`, `rig/mesh.ts`, `lottieImport.ts`,
`lottiePreview.ts` and `shapePath` all already read them as absolute, and
`rasterPadding` was the lone outlier. Its test was the other half of the bug:
it built points with `inX: 0`, a handle pinned at the origin rather than a
corner, so it pinned the defect instead of catching it. That evidence only
exists because F15 landed first — run against the broken scene, "green" would
have meant "rendered nothing, twice".

**Phase 3a — trim folds in (document 1.4.0).** Shipped complete: model, chain
currency rewritten to run lists, migration with its own version bump, the
`pathop.<id>.<param>` property-meta resolver, and the inspector card with
working reorder — `TrimPathControls.tsx` deleted in the same commit. The two
new goldens `shape-trim-then-zigzag` / `shape-zigzag-then-trim` differ by
**2.012%** of the frame, so the arrows are live in pixels. The three existing
trim goldens still match exactly, which is the evidence the fold preserved
output.

**The repeater deliberately did NOT fold in.** F16 is unchanged and still
blocking: copies are separate layers sharing one geometry, and a `Subpath`
carries no paint, so baking them into geometry to make position meaningful
drops per-copy `offsetOpacity` — which is keyframeable today. Inert controls
waste time; a dropped parameter destroys work without telling the user. It
waits behind per-run paint.

## 2d. DECISION D3 — templates are deliberately de-scoped

**Recorded as a decision rather than allowed to happen by omission.**

Templates were roughly a quarter of the original brief: exposed field kinds,
media replacement, nested reuse, packaging, **responsive/protected time**, and
data binding. What remains scheduled is **M7 (protected time regions)** — the one
that makes a lower-third reusable at any length, and the only template item the
audit found genuinely missing rather than already built.

Everything else from that section either **already existed** (exposed fields,
media slots with author-set fit policy, self-contained `.motion` packaging,
nested precomp reuse, animation presets — see audit §3 D) or is now in §3 below
(dropdown field kind, CSV/JSON data binding).

**The reasoning:** the audit set out to find gaps across four areas and found the
template system was the healthiest of them, while compositing correctness turned
out to hold the real defects — three faces of one bake-ownership bug (ea47497,
b814e3a, 8e56bd0), a live silent-wrong-matte (F1/M8b), and now F10. Effort
followed the defects.

**The cost, stated plainly:** templates are the part of the brief about what
users *see* and reach for, rather than what is true underneath. Data binding in
particular is a feature nobody has, not a bug anybody has. Deferring it is a
judgement that correctness outranks reach for this round — defensible, but it
should be revisited deliberately after M7, not left to erode further.

**This decision needs re-affirming, not re-deriving, if the plan is picked up
later.**

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
