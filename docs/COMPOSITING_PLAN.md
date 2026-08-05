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

### When the RULE cannot be unified, guarantee ONE READER

Added 2026-08-05, from F22. This is a fourth move and it is distinct from the
three above, which all assume you are allowed to change the behaviour.

Sometimes you are not. F22 is two incompatible definitions of "does editing this
property create a keyframe?" — transform props honour the Auto-Keyframe
preference, effect params ignored it — and unifying them alters what every
existing project does. That is a decision with a release note, not a refactor
you slip into a feature branch.

The move is to stop the divergence WIDENING while the decision is pending:
route every consumer through one function, so the two callers cannot drift from
each other even though the rule itself is still wrong. Building the canvas
handle forced the question ("which rule does a drag follow?"), and the answer
was to extract `writeEffectParams` and point both the numeric field and the
handle at it. The inconsistency survives; a THIRD variant of it cannot appear.

Distinguish it from fix (1), *remove the choice*: that makes the disagreement
unrepresentable. This makes the disagreement singular — one wrong answer instead
of two, changeable in one edit when the decision lands. Weaker, and the right
move when the stronger one is not yours to make.

The tell that you need this rather than (1): the duplication is not a mistake
anyone made, it is two deliberate behaviours that grew apart, and picking either
one breaks somebody's file.

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

### The variant INSIDE the guard: a test that enumerates its own subjects

Added 2026-08-06, from F25, and it is the most uncomfortable instance because
the list was hiding in the thing that existed to prevent this.

> **A test that enumerates its own subjects can only ever check the subjects
> someone remembered.**

`expressionApi.test.ts` asserts that *every* function in the expression scope is
discoverable — bound in `run`'s scope AND present in the `EXPRESSION_API`
autocomplete table, because a function that works but cannot be found is a model
with no UI. It made that assertion by iterating a hardcoded sixteen-name array.
So it enforced the property for sixteen names and for nothing else. Adding
`marker` to the scope and omitting its table row broke **no test**. The file's
own header said it "closes the third edge" — true for sixteen names, and the
rationale had rotted exactly as 3b describes.

Replacing the array with `boundScopeNames()`, a reflection of the real scope Map,
immediately surfaced **three functions undocumented since the day they were
written**: `audio`, `ctrl`, `framesToTime`. `audio` is the audio-reactive
expression — the feature the other half of that same run was building on.

This is the same shape as `applyCanvas2dEffect` and `LUT_EFFECTS`: a list and a
behaviour, with nothing forcing agreement. The difference is where the list sat.
In those cases the guard could still catch the drift; here the list *was* the
guard, so the drift and the thing meant to detect it were the same object. A
guard with a hardcoded subject set does not fail when it stops being true — it
just quietly stops covering everything added after it was written, and keeps
reporting success at full confidence.

**So: derive the subject set from the thing under test.** Enumerate the real
registry, the real Map, the real union — never a parallel list of names. If the
set genuinely cannot be derived, that inability is itself the finding, because it
means the thing under test has no enumerable identity and the next person will
make the same list again.

The same rule caught a second instance at a smaller scale, and the pairing is
worth keeping because it shows the shape is not about expressions or
autocomplete: the eslint config hand-listed eight Node globals *"rather than
pulling in the `globals` package for six names"*, then covered nothing written
afterwards, and reported six `no-undef` errors on globals that plainly exist.

The cost is identical in both, and it is not the false reports. It is that the
guard becomes **inert**: `no-undef` in those files, like the discoverability
assertion for any name outside its sixteen, cannot fail for the case it exists
to catch. A guard emitting constant false positives is not a weak guard — it is
a disabled one that still looks enabled, and the noise trains everyone to
discount exactly the signal it was installed to raise. Written up in full beside
the lint gate (§2b-quaterdecies), which is where the same argument decided that
41 harmless errors were what hid the one real one.

### The variant with no compile-time surface at all: a PROP PATH

Added 2026-08-05 from the repeater fold, which is the cleanest instance yet.

A keyframe path is a **string**, so the writer and the sampler are two consumers
with nothing whatsoever forcing them to agree. `tsc` cannot see it. The fold
renamed `rep.<param>` to `pathop.<opId>.<param>` and the build stayed green while
two live call sites went dead:

* `seedComplexShowcase` wrote `kf('ring_dot', repeaterPropPath('offsetRotation'), …)`
  — a track nothing would ever sample. The showcase's ring would simply have
  **stopped spinning**, with no error anywhere.
* The AI's `set_repeater` returned `"Animate 'repeater.copies'"` — advice naming
  a path this app has **never** understood, at any version. Following it wrote a
  dead track. That one predates the fold entirely; renaming the real path is what
  surfaced it.

Both are the §2·0 signature exactly: *a reader of a key nothing writes compiles
fine.* The type checker's silence is not evidence, because there is no type.

**Standing rule — for any prop-path change, sweep every consumer BY HAND.**
`tsc` clean means nothing here. Grep the old path, the new path, and the helper
that built the old one, across `src/` *and* `packages/`, and check each hit is a
live write or a live read. Deleting the helper that produced the old path
(`repeaterPropPath`) is what turns the remaining consumers into compile errors —
which is fix (1) from the list above, *remove the choice*, applied to the one
case where the choice is a string literal. Prefer that to grepping where you can.

### Judging a guard SET: which ones stay green is the stronger signal

Added 2026-08-05, alongside the above.

The standard already requires each guard be verified to fail by breaking what it
covers. That is necessary and not sufficient: eight guards that all fail on every
break are **one guard written eight times**, and it will miss the ninth thing.

So when breaking a guard, read the whole result, not the one red line. On the
repeater fold:

* Dropping the run-paint spread in `applyPathOpChain` failed the
  deformer-paint test while the **trim**-paint test stayed green — and dropping
  the paint inside `applyTrim` failed the trim one while the deformer one stayed
  green. Two genuinely independent guards over two genuinely independent code
  paths, demonstrated rather than assumed.
* Removing the repeater's `propertyMeta` bounds failed the BOUNDS test while the
  LABEL test passed. That is the blind spot a label-only check would have had,
  made visible.
* Dropping one param from the migration's reroute list failed the all-nine test
  while the two the fixture happens to animate stayed green — which is the entire
  reason the broader test exists.

**The question to ask of a guard set: what would have to break for exactly this
one to fail?** If no answer distinguishes it from its neighbour, it is not a
second guard. This is the same idea as rule 4 of §2b-quinquies (verify by
breaking the direction and watch which tests fail), generalised from one guard to
a set.

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

## 2b-vicies. Release note — rigging closed out: quadruped, palette, per-vertex weights

**Three features and one consolidation.** With these, the named DUIK/Rive gaps are
closed and rigging is complete for this version.

### Quadruped auto-rig

Side view facing screen-right — 14 bones, 4 IK chains, 7 controllers. A quadruped
drawn front-on has no usable 2D rig (legs occlude, nothing bends in the picture
plane), so the preset generates a side view rather than pretending the choice is
open.

**`side` reads oddly and is right.** The four legs are FORE and HIND, not left and
right. `ControllerSide` "drives colour only — it carries no solver meaning", and
this file's existing convention is that `side` is SCREEN side with `left` =
negative x. Fore legs sit at positive x, hind at negative, so fore colours as
`right` and hind as `left`, and the two sets are distinguishable. A fore/hind enum
would have meant a schema change, a migration and a new case in every controller
reader, to recolour four handles.

### Rule 2b — the anchor is now TOTAL, which is the substantive change

The biped's side test **exempted `centre`**, so a third of its controllers made a
directional claim nothing checked. Both presets now root their body control at
x = 0, which makes `centre` mean "on the midline" — a measurable claim rather than
a label — and every controller is anchored to the sign of the point it actually
ends up on, computed from the skeleton solver.

That anchor had been wrong twice before, both times by reaching for a bone whose
local x is positive on both sides. Verified it is not wrong a third time by
breaking it: flipping ONE leg's side in the generator turns the suite red. A
synthetic mirror-swap positive control sits in the file so the anchor cannot go
insensitive later.

### Rule 3a — a transform-invariance test that was really a determinism test

The suite asserted `preset({...BOUNDS})` deep-equals `preset(BOUNDS)` under a
comment about ignoring layer rotation and scale. That is a **determinism** check
wearing an invariance label: a generator that read the layer transform passes it,
because neither argument ever carried one.

Replaced with a real layer rotated 37° and scaled 2.4 × 0.6, driven through the
scene graph, asserted to store the same rig as one at rest. **Its positive control
caught its own fixture:** reading `node.transform.scale` reported `nonUniform:
false` on a layer that is non-uniformly scaled, because the Transform COMPONENT is
the authority and `node.transform` is not what anything downstream reads.
Re-anchored on `readGeometry` — the function `BoneControls` actually calls — plus
an explicit check that it reports the UNSCALED box, which is the property that
keeps a scaled layer from getting a differently-proportioned rig.

### Command palette

`buildRigPresetCommands()` maps the preset registry, so a third preset gets an
entry with no edit — matching the inspector `<select>`, which was already derived,
rather than adding a second source. Guarded where the claim becomes false rather
than by grepping source text (rule 4c): the id is in the REGISTERED list, running
it writes a rig `validateRig` accepts, it is one undo entry, and it sizes from the
layer rather than the 200×200 fallback. Unwiring it turns 15 of 17 red; the two
that stay green are the positive control and the orphan check, both correctly
indifferent.

### Per-vertex numeric weights

**Existence sweep first.** Three of four pieces already existed and were reused:
the storage (`WeightPaintMap` already holds absolute per-(bone, vertex) overrides),
the read (`getSkeletonBinding(...).weights[i]` is already the full influence list),
and the write command (`setWeightPaint`, with undo). Genuinely missing: vertex
SELECTION and a numeric surface.

**Normalisation — redistribute, and write the WHOLE vertex.** Rejecting an edit
that breaks the sum would defend an invariant the renderer does not depend on:
`skinVertex` divides by the total, so an un-normalised vertex silently rescales
rather than erroring. And `applyWeightPaint` already redistributes, so enforcing a
sum instead would be a second disagreeing rule for one piece of data (§2·0).

Writing every influence rather than only the edited one is the part that needed
deriving on paper. With a partial write the next edit finds the first bone already
painted, `paintedTotal` exceeds 1, and `normalizeWeights` rescales the typed
number — 0.8 reads back as 0.61. Writing a vertex summing to exactly 1 makes
`remaining` zero and `normalizeWeights` a no-op, so **what you type is what
deforms**. Verified in the running app: typed 55 → 55.000, then typed 40 on a
second bone → 40.000, total 100% both times, others keeping their ratios.

**The single-influence boundary is made unrepresentable, not corrected.** One bone
on a vertex is weight 1 by definition; the model declines the edit and the panel
renders an explanation instead of a field.

**Rule 3a again:** the fixture is 0.6 / 0.3 / 0.1, not three thirds. Equal weights
hide writing to the wrong bone, redistributing to the wrong bone, and transposing
two entries — all three produce identical output. Ratios are distinct too (6:3:1).
Verified to fail twice: a partial write reddens exactly the two multi-edit tests
(correct blast radius — a single edit is right either way), and an even split
instead of proportional reddens exactly `untouched bones keep their ratio`.

### §2·0 — `nodeRestMesh`

The ~30-line rest-mesh assembly was inline in `BoneOverlay`, and the panel needs
the SAME mesh. Copying it would have recreated the drift `rigMeshInputs` exists to
stop, and worse than usual: weights are addressed by vertex INDEX, so two
derivations at different densities do not disagree slightly — they address
different vertices, and the editor would write weights onto artwork the user never
touched.

### Runtime verification, through the real UI

Local edition, real app. Quadruped from the Rigging dropdown → 14 bones, panel
listing Spine/Hips/Chest/Neck/Head/Tail and four named leg pairs; **one** Undo
click → 0 bones. `Auto-Rig: Biped` and `Auto-Rig: Quadruped` both render in the
palette; running the quadruped entry → 14 bones, one Undo → 0. Pick Vertex →
vertex #135 highlighted, panel showing four bones at 29.3 / 28.4 / 24.2 / 18.1 %,
total 100%. Typed values landed exactly and one Undo reverted exactly one edit.

## 2b-duodevicies-bis. Release note — animated stroke width (F34, FIXED)

**A behaviour change for any project that already carries a `strokeWidth`
track**, which is why it gets a note rather than a line in a finding table.

**What changed.** A keyframed stroke width now animates. It did not before:
`strokeWidth` was registered in `propertyMeta`, so the inspector and the timeline
both offered a stopwatch, and `buildSnapshot` folded the sampled value into the
resolved stroke *nowhere*. The original measurement: a 6 → 40 ramp rendered 5296
stroke pixels at BOTH ends.

**Who is affected.** Anyone who set stroke-width keyframes and concluded the
feature was broken. Their file already contains the track; opening it after this
change makes the stroke move for the first time. Nobody's stored data changes —
only what is drawn from it.

**Re-bless: NONE required, and that was checked rather than assumed.** No
render-test scene references `strokeWidth` at all — `grep` over
`packages/render-tests/harness/` returns nothing — so no existing golden could
shift. The predicted diff was therefore *zero goldens*, and the actual diff is
zero goldens. Scenes that use `cornerRadius` statically are likewise untouched,
because a static value arrives through the component scan (`num(p.cornerRadius)`)
and never through the animated fold.

The consequence, stated rather than glossed: **the fix is not covered by the
pixel gate.** A scene that ramps a stroke width would be a NEW golden, which is a
new blessing and belongs in its own change — bundling it here would make this
commit and that blessing unbisectable.

### The guard that should have caught it, and why it could not

The brief expected `contentHashReaders.test.ts` (G1) to be extended. It could not
have caught this:

- G1's subject set is the fields folded into the rasterizer's CONTENT HASH. The
  hash folds `st: layer.stroke` — one object — so `stroke.width` was never in the
  subject set, and the guard does not recurse into nested style objects.
- More fundamentally the two are different classes. G1 catches
  **hashed-but-unread** (per-layer `quality`: the texture re-rasterizes and looks
  identical). F34 is **keyframeable-but-unsampled**: the *stopwatch* writes
  keyframes nothing reads. Extending G1 would not have found it and will not find
  the next one.

So there is a second guard, `animatablePropertyReaders.test.ts` (G2), whose
subject set is the registry's own inventory (`staticPropertyPaths()`, which
already existed "for tests"). Structural rows are excluded on a PROPERTY of the
entry — `type: 'group'` — rather than by name, so the synthesized Position row is
skipped without a hardcoded exemption.

### G2 found a second instance the same day

**F35, logged not fixed: `cornerRadius`.** Registered and keyframeable; the
static value is read, the animated track is folded nowhere. So a rounded rect
draws, and a keyframed corner radius does not move. Out of scope here — F34 is
what this change is, and F35 is its own behaviour change (§2a). No golden
animates it either, so the fix is cheap when someone takes it.

It is recorded in G2's `KNOWN_UNSAMPLED` map, which is deliberately not an
exception list: one test fails if anything NEW joins it, and another fails if an
entry stops being true — so fixing F35 *forces* its removal and the list cannot
outlive the bugs it describes.

### Guards, and what stays green

`strokeWidthSnapshot.test.ts` samples the crossing itself —
`buildSnapshot(...).layers[].stroke.width` — mirroring `dashOffsetSnapshot.test.ts`
next door, whose docstring cited F34 as the cautionary example and has been
corrected now that it is fixed.

Values derived on paper: 6 at t=0, **23** at t=1 (6 + (40−6)/2), 40 at t=2. Plus
the one the original symptom demands — the two ends must DIFFER, since "both ends
equal" is exactly what F34 looked like. Plus composition with animated dash offset
and animated stroke colour on one layer, because the fold chains off `finalStroke`
and rebuilding from `baseStroke` would silently drop whichever applied first.

Negative widths clamp to 0: an overshooting ease undershoots between keys, and a
negative `lineWidth` is a Canvas2D exception rather than a thinner stroke.

Verified to fail: disabling the fold turns 8 of 19 red. Honest limitation — G2 is
a TEXT guard, so it catches a property referenced nowhere in the pixel path; it
does not catch a reference that has been disabled in place. That is what the
instance guard is for.

Suite 600 → 602 files, 7495 → 7514 passing. Lint 0 errors.

## 2b-undevicies. Release note — one Ctrl+Z per edit (history, FIXED)

**User-visible, app-wide, and not a rigging bug** despite being found while
driving the rig panels.

**What changed.** Undo now takes one press per edit. It used to take two for any
edit backed by a command, and the History panel listed a generic `Edit 7` row
next to the real one — a row corresponding to nothing the user did. Jumping to
one of those rows worked, which is why it read as clutter rather than as a bug.

**Also fixed, same cause:** after an undo or redo, the *next* snapshot's "before"
state was the pre-undo state. Undo → edit → undo could therefore land somewhere
the user had never been.

**Root cause — neither of the two candidates carried into this run.** Not Vite
duplicate module instances, and not two closures over one variable. The
`lastState` binding was fine: one module instance, `hasLast=true` at record time.
The listener that refreshes it **never fired once**.

`historyStore` subscribed to `UndoStackChanged` at MODULE SCOPE.
`Application.boot()` calls `setEventBus(new EventBus())` (`Application.ts:80`), so
a subscription made before boot resolves is attached to a bus that is then
discarded. The listener existed, was correct, and was wired to nothing. With the
baseline never refreshed, `statesEqual` compared every capture against a stale
state, always saw a change, and recorded a snapshot on top of the command's own
entry.

`Providers.tsx` already carried a written note about this exact hazard, for the
cross-window sync: anything subscribing before boot resolves lands on a bus that
is thrown away. **Second victim, same trap.** The asymmetry that proves it: the
`schedule` subscriptions beside it DO fire, and they are registered inside boot.

**Where the fix went, and why not the other two places.** At the subscription.
The suppression logic was already correct — it never received its input. Fixing
the emitter or the suppression rule would have compensated for a dead listener
while leaving it dead, and the stale-baseline-after-undo bug would have survived
untouched, because that one is not about counting entries at all.

**§2·0 — the wiring is now one call.** The four subscriptions that make up
recording were four separate `track(...)` lines in boot, and three worked while
the fourth was missing. Nothing owned "recording is wired", so nothing could be
missing it. They are now `attachHistoryRecording()` in `historyStore`, called
once from boot: `schedule` decides WHEN to capture and the baseline decides
WHETHER the capture is redundant, and half of that pair is not a degraded version
of it — it is this bug.

**Accreted consumers, checked rather than assumed.** A behaviour eight months old
grows dependents, and re-activating a dead listener is a behaviour change:

- **The "Open" baseline survives because it is `named`.** `baselineHistory()`
  calls `reset()` (whose `clear()` emits `UndoStackChanged`) and then
  `record('Open', true)`. With the listener live, that emit now sets `lastState`
  to the current state — so an unnamed baseline would compare equal and push
  nothing, and the document's opening state would have no row to return to. The
  `named` bypass already in `record` is exactly what absorbs this, and its
  comment describes the failure as historical. It was in fact **pre-emptive**:
  the condition it guards against only became reachable with this fix.
- **The coalescing rule is untouched.** `schedule`'s key comparison governs the
  timer, not the baseline; a burst on one target still collapses to one step and
  a move to a different target still commits the previous one first.
- **`Edit N` labels have no consumers.** `seq` is module-local and the History
  panel prints whatever label it is given. The numbering is now sparser (commanded
  edits no longer consume a number) and nothing reads it.
- **The History panel and TopNav both subscribe inside `useEffect`**, so they were
  never victims of the same trap, and both simply see fewer entries.

**What this could have broken, and what proves it did not.** The snapshot is the
catch-all for edits with NO command; suppressing it wrongly would silently delete
undo for everything uncommanded. Both sides verified:

| | before | after |
|---|---|---|
| commanded edits (rig panels, 18 controls) | 2 entries | **1**, with real labels |
| uncommanded edits (raw `setSkeleton` + `bumpScene`) | 1 entry | **1**, unchanged |

**The guard, and why the old ones were green throughout.**
`rigGestureUndo.test.tsx` already asserted "one gesture, one step" and passed the
whole time — it never wires the snapshot path, so it measured the command layer
alone, where the count is trivially right. Rule 5·0: the observable is the number
of History rows one edit adds; the layer is `HistoryService`'s entry list, fed
from two independent places; **the medium has to sample both.**

`inspectorHistoryGranularity.test.tsx` runs `attachHistoryRecording()` exactly as
boot does, then drives every drivable control in every inspector section — 70
probes across 12 sections, of which 63 provably changed captured state — and
asserts each added exactly one entry. Subjects come from the directory, not a
list (F25, fourth instance). Probes that changed nothing are excluded rather than
counted as passes, because 0 is the correct answer there and counting it would
let the suite go green on a harness where nothing landed.

Verified to fail: reverting the baseline sync turns 18 probes red at `added 2`,
across `BoneControls` and `PuppetControls` — the command-backed sections. The
other 45 landed probes are snapshot-only edits, which were always 1; a positive
control asserts the probe set reaches the two sections that CAN exhibit the bug,
so a broad-but-blind probe set fails instead of reassuring.

**F30 / rule 4c — the seam.** The three unit tests on the baseline sync were
green for as long as it was broken, because they guarded the unit and not the
CROSSING. `historyBaselineSync.test.ts` now also asserts that boot reaches the
wiring, and that no module-scope `getEventBus().on(` has crept back into the
store.

## 2b-quaterdecies. 2026-08-06 — the pre-launch ten, verified before building

Existence verdicts for the pre-launch feature round, recorded so the next run
argues with evidence rather than with the list. Motion tracking was out of scope
by instruction. Numbering follows the brief.

| # | Feature | Verdict | Evidence |
|---|---------|---------|----------|
| 1 | **Advanced pins — on-canvas manipulator** | **COMPLETE** | `PuppetOverlay.tsx` draws the rotation ring (`GIZMO_R`, drag → rotate) and the square scale handle on the selected pin, Shift-constrained to 15°/5%. Model (`rotation`/`stiffness`/`scale`/`overlap`/`overlapExtent`) and inspector predate it; all four scalars keyframe as `puppet.<id>.<prop>`. Nothing to build. |
| 2 | **Bend pins** | **ABSENT → SHIPPED** | No pin `kind`/type discriminant existed anywhere; every pin was an advanced pin. See the feature commit and `bendPins.ts`. |
| 3 | **Stroke design** | **PARTIAL, unevenly** | *Dashes:* present — `Stroke.dash: number[]`, rendered via `setLineDash` (`vectorDraw.ts:313`), reachable in `AppearanceSection`. **No offset, and not keyframeable** — the animating half, which is the half that draws lines on. *Gradient fills:* **complete**, incl. independent opacity stops and keyframeable `fillAngle`/`fillCenterX/Y`/`fillRadius` plus a `fill.stops` track. *Gradient strokes:* present (`Stroke.paint`) and reachable, but only the two end stops are editable and the stroke gradient has no keyframeable start/end of its own. *Taper:* **absent** — no per-vertex width anywhere. *Wave:* **absent** as a stroke property; `pathOps.zigzag` is a path operator with amplitude+segments, no wavelength and no phase. Arc-length machinery to reuse for dashes already exists: `trimSegments`/`trimPolyline` in `trimPath.ts`. |
| 4 | **Continuous rasterization** | **COMPLETE** | `scene/continuousRaster.ts` + tier/cache-key quantisation in `AppTextureProvider`, UI toggle in `PrecompControl.tsx` (`aria-label` present), `continuousRaster.render.test.ts`. The ⚠️ in the reference doc is stale. |
| 5 | **Numbers and Timecode** | **COMPLETE for what was asked; two formats absent** | Both registered in `effects.ts` (`'numbers'`, `'timecode'`) with kernels in `generateText.ts`. Counters keyframe on `value`; timers work via `followCompTime` + drop-frame. **Currency and date formatting are absent** — the brief names them, and they are the remaining work here, not the effects themselves. |
| 6 | **Comp markers on number keys** | **PARTIAL — model done, binding absent** | Comp markers, `listMarkers`, and next/previous navigation all exist on `TimelineController`; `useTimelineKeys` binds Shift+PageUp/Down. **No 1–9 binding.** Genuinely small, as the brief guessed. |
| 7 | **Preserve Underlying Transparency** | **ABSENT** | No flag on the layer model, `RenderLayer`, or either backend; no doc mention. Searched under four spellings. |
| 8 | **Sequence Layers — overlap and crossfade** | **PARTIAL, further along than assumed** | `TimelineController.sequenceLayerBars(nodeIds, overlapSeconds)` already lays bars end-to-end **with overlap**, and `sequenceLayerBars.test.ts` covers the overlap case. The only UI caller (`TopNav.tsx:131`) hardcodes `0`, so overlap ships unreachable. **Crossfade is absent.** Note the near-miss: the similarly named `keyframeAssistants.sequenceLayers` staggers keyframe *tracks* and is a different feature. |
| 9 | **Layer-edge and centre snapping** | **COMPLETE** | `SnapEngine.objectTargets` emits left/right/centre-X and top/bottom/centre-Y with extents; assembled in `Workspace.buildSnapTargets` (grid not gated on grid visibility, matching AE); consumed by `SelectTool` on both move and resize; magnet button bridged in `useWorkspace`. Six tests incl. source toggles. Nothing to build. |
| 10 | **Convert Expression to Keyframes** | **COMPLETE — already on the branch this stacked on** | `cc677bd feat(animation): Convert Expression to Keyframes`, on `feat/expression-enabled`, together with the enabled-bit model change, its version bump and migration. The blocked-on-a-model-change framing was already resolved. |

## 2b-quindecies. 2026-08-06 — rule 2b: a suite of symmetric assertions cannot see a sign

Sibling to **rule 2a** (*a uniform error is invisible to every relative
assertion*). Same family, different symmetry, and it is the rule F33 was hiding
behind.

> **Rule 2b.** An assertion that is invariant under a mirror cannot detect a sign
> error, however large the error is. Determinism, NaN-freedom, difference
> (`a !== b`), magnitude (`|d| > k`), ratio and area/rigidity comparisons are all
> mirror-invariant. A suite built only from those has **no directional coverage**,
> and its passing says nothing about direction.
>
> **The diagnostic:** name one assertion in the suite that a mirrored
> implementation would fail. If you cannot, there is no directional coverage —
> not "thin" coverage, none.
>
> **Rule 2b-i — a directional claim must be anchored OUTSIDE the implementation.**
> *"Negating the input negates the output" is true of the mirrored implementation
> too*, because a mirrored implementation is self-consistent. Any assertion phrased
> as a relationship between the implementation's own outputs — output(+θ) is the
> reflection of output(−θ), forward undoes backward, A differs from B — survives
> the mirror intact. The expected value has to come from somewhere the bug cannot
> reach: arithmetic done on paper, a rotation matrix written independently, a
> coordinate a reader can check with a calculator.
>
> This is not hypothetical caution. **Three of the four first-draft "directional"
> guards for F33 passed on the broken build**, each for a reason of this kind —
> one was dominated by the position constraints rather than by the fitted
> rotation, one asserted only "not a pure translation" (true under either sign,
> because the base deformation differs regardless), and one was the
> negate-the-input symmetry above. All three read as directional and measured
> nothing. They were replaced with claims anchored to R(±θ) computed
> independently.

`src/core/rig` had 188 tests and could not name one for the ARAP local step. The
§2b-quinquies rule ("a wrong distortion looks exactly like a right one") was
written for spatial *effects*; this is the same failure one layer down, in a
solver, where it is easier to miss because the visible symptom is *softness*
rather than something obviously backwards.

### The sweep, and what it corrected

Asserting the blindness was itself an untested claim, so it was measured:
`scripts/symmetrySweep.mjs` applies seven mirror-class mutations — each a
*semantic* mirror that still compiles and still produces a plausible
deformation — and reports which tests notice. Results **before** the F33 fix:

| Mutation | Caught by |
|---|---|
| ARAP local step: mirror the fitted rotation (**F33**) | **0** |
| silhouette mesh: transpose UVs | **0** |
| `earClip`: reverse triangle winding | **0** |
| ARAP global step: apply Rᵀ instead of R | 2 |
| `deformLbs`: mirror every pin rotation | 3 |
| `deformLbs`: swap the displacement axis pair | 6 |
| `sortTrianglesByDepth`: invert draw order | 2 |

**This corrects the previous run's report,** which said every assertion in the
directory was symmetric. Four of seven mirrors *were* caught — LBS pin rotation
has a directional test (`rotation on a single pin rotates the mesh rigidly around
it`), and draw order has two. The gap was specific, not general: the rotation
ARAP fits **internally** had no assertion a mirror would fail, because its ARAP
tests compare ARAP against LBS on **area preservation** and **rigidity**, and
both survive a mirror. Stating it as a property of the whole directory was
broader than the evidence.

After the fix and the new guards, 5 of 7 are caught. The two survivors —
**UV transpose** and **reversed winding** — are pixel properties no vertex-level
assertion can reach; the rig render-test family names winding explicitly as a
reason it exists, so the guard for those lives at the golden layer, not here.
Logged as a coverage note, not a defect: nothing suggests either is currently
wrong, only that the unit suite would not say so.

## 2b-quindecies-bis. Rule 2c — an instrument built to detect ABSENCE needs a positive control

A new category, and worse than a lying test.

The symmetry sweep reported **NOT CAUGHT for all seven mutations, twice** — and
it was wrong both times, for two reasons with nothing to do with coverage:
`execFileSync` cannot launch a `.cmd` shim on Windows without a shell (status
`null`, empty stdout, empty stderr), and on a *passing* run it returns **stdout
only** while jest writes its run summary to **stderr**. Both parsed to zero
failures.

> **Rule 2c.** Any tool built to detect ABSENCE needs a positive control — a case
> it is known to catch, checked in the same run. Without one, *"caught nothing"*
> and *"measured nothing"* are the same output, and nothing distinguishes them.
> An instrument must be able to say **"I did not measure anything"**, distinctly
> from "I measured, and there was nothing there".

**Why this is worse than a test that lies.** A failing test interrupts you. A
measuring instrument that fails *in the direction you already expect* does the
opposite: the result confirms the hypothesis, and the confirmation suppresses the
very check that would have caught it. Here the hypothesis was "this suite is
blind to mirrors" and the instrument said "blind to all seven" — a satisfying
answer, and the reason to look harder was removed by the answer itself. It was
caught only because the *count* fields read `null` rather than `0`, which is an
accident of formatting, not a designed safeguard.

The fix is that the sweep now **aborts** when its baseline does not parse, rather
than reporting. Its positive controls are the four mutations it *does* catch,
present in the same run — the table above is its own proof that it can detect
something, which is what makes the two zeroes in it meaningful. Had every
mutation been genuinely uncaught, the run would have shown seven zeroes and no
evidence of a working instrument, and would have needed a deliberately-broken
control added.

Generalises past this script: the same shape covers a lint rule that matches
nothing, a grep-based audit whose pattern is subtly wrong, a migration checker
over an empty input set, and a "no console.log in src" gate pointed at the wrong
directory. All report clean. All are indistinguishable from working.

## 2b-sexdecies. Release note — the ARAP rotation sign (F33, FIXED)

**Behaviour change. Every ARAP-rigged layer moves.** Same treatment as the
repeater rotation and the trim/fill correction: announced, not migrated silently.

ARAP's local step fitted the *inverse* of the rotation its global step applied
(`atan2(s10 − s01, …)` where the maximiser for `R(θ) = [[c,−s],[s,c]]` applied to
the rest edge is `atan2(s01 − s10, …)`). Corrected.

Three independent confirmations, since the derivation alone should not be enough
to re-bless a golden:

1. **Algebra.** `(R·e)·e' = c·(s00+s11) + s·(s01−s10)`, maximal at
   `atan2(s01−s10, s00+s11)`. On one edge: rest `(1,0)` rotated +90° gives
   `(0,1)`, so `s01 = 1` and the rest are 0 — the corrected form returns +90°,
   the old one −90°.
2. **An internal disagreement.** `resolvePinnedVertices` writes
   `sin = +sin(rot)` into the *same* `cosV`/`sinV` arrays the local step fills.
   Handles therefore turned one way and every fitted interior vertex the other —
   two writers, one array, opposite conventions (§2·0).
3. **Anti-convergence.** On a rigidly rotated handle set, whose exact energy
   minimum *is* that rigid rotation, worst-vertex error GREW with the outer
   iteration count: 21.4px at 2, 30.2 at 4, 43.9 at 8, 53.7 at 16, 56.9 at 32.
   A correct local/global scheme cannot diverge from its own minimum. Corrected,
   the same fixture converges.

**Golden diffs.** Attribution by revert-and-verify: all eight rig scenes measured
**0px** against their committed references at HEAD *before* the fix, so every
pixel below is the fix and nothing else.

| Scene | Predicted | HEAD | After fix |
|---|---|---|---|
| `rig-puppet-overlap` | changes, largest | 0px | **3127px · 3.6192%** |
| `rig-puppet-bend` | changes | 0px | **1131px · 1.3090%** |
| `rig-compose-puppet-skeleton` | changes | 0px | **417px · 0.4826%** (PASSED — under the 0.5% bar) |
| `rig-puppet-scale` | little or none | 0px | 13px · 0.0150% |
| `rig-puppet-rotation-refinement` | changes | 0px | **2px · 0.0023%** — MISPREDICTED |
| `rig-puppet-lbs-vs-arap` | none (LBS) | 0px | **0px** |
| `rig-skeleton-pose` | none | 0px | **0px** |
| `rig-skeleton-bone-scale` | none | 0px | **0px** |

Six of eight predicted correctly, including all four "no change" calls exactly.
The instructive miss is `rig-puppet-rotation-refinement` — **the scene named for
rotation is the one blindest to the rotation sign.** It applies a pin *rotation*
with no pin *displacement*, and a pin's rotation sets its own vertex's frame
through `resolvePinnedVertices`, the forward-signed path this change does not
touch. With the handles not moving, the free-vertex field stays near identity, so
the fitted angles are ≈0 — and at θ≈0 the sign cannot show. The pattern holds
across the family: every scene that moved is **displacement**-driven, every
scene that did not is rotation-only or LBS/skeleton.

So the goldens *did* exercise the defect — but only incidentally, and one real
change (417px) sits under the gate's 0.5% tolerance and would have been absorbed
silently. Re-blessed anyway, so the committed reference is the current behaviour
rather than a nearly-current one.

**The percentage gate has a blind band, and it is not uniform.** 0.5% of a
360×240 frame is 432 px — more than a small layer's whole silhouette can move, so
the smaller the subject relative to the frame, the more of its behaviour fits
underneath. A green gate means *"nothing changed by more than the band"*, never
*"nothing changed"*. Recorded at the definition too, in
`packages/render-tests/scripts/comparator.mjs`, since that is where someone reads
the tolerance and forms the wrong impression of it.

## 2b-septendecies. Release note — animated dash offset (stroke design, 1 of 4)

Dashes rendered but could not move: `Stroke.dash` had no offset and no track, so
the half of the feature that draws lines on, marches borders and fills progress
rings did not exist. `Stroke.dashOffset` carries it now, keyframeable through the
`strokeDashOffset` track.

**Arc length, with no new mechanism for it.** The offset is a distance along the
path in the same layer-local px `dash` is measured in — exactly what Canvas2D's
`lineDashOffset` already means — so `applyStrokeStyle`, the single place stroke
state reaches the canvas, sets it and the rasterizer does the rest.

`trimSegments` / `trimPolyline` were considered and deliberately NOT used. They
do provide arc length, but over a POLYLINE SAMPLING of the curve: dashes on a
circle or a bezier would land at subtly wrong distances, every dash would get
butt ends regardless of `cap`, and joins inside a dash would be lost. It would
also be a second dashing implementation beside the one the canvas already applies
for the static pattern (§2·0). Trim's walk is the right mechanism for CUTTING a
path and the wrong one for phase-shifting a pattern already being laid down.

**Cache invalidation came free, and was checked rather than assumed.** An
animated offset only renders if the raster cache key moves with it.
`AppTextureProvider`'s `strokeSig` covers width/colour/align only — but
`contentHashOf` serialises the whole stroke object, so the field entered the key
by existing. Confirmed at runtime: consecutive frames of a marching border differ
by ~6,000 px, which cannot happen off one cached raster.

`normalizeStroke` OMITS the key when absent rather than defaulting it to 0, for
the same reason. Writing `dashOffset: 0` into every normalised stroke would
change the content hash of every layer in every existing project and discard
every cached raster on first open — for a value meaning "unchanged".

### Rule 3a, measured rather than argued

Dash patterns are periodic: offset 0 and offset `sum(dash)` draw the same
picture. All three rendered through the real pipeline, dashed ellipse, `[24, 12]`
pattern, period 36:

| Comparison | Differing pixels |
|---|---|
| offset 0 vs 9 (quarter period) | **3,508 px (3.48%)** in the harness; 6,393 px in-app |
| offset 0 vs **36 (one whole period)** | **0 px — byte-identical** |
| animated frame 0 vs frame 30 (one period apart) | **0 px** |

A golden blessed at 0 *or* at a whole period would therefore have been satisfied
by a build that ignored the offset entirely. `stroke-dash-offset-curve` is
blessed at **9**, and on an **ellipse** rather than the rect the rest of the
stroke family uses: offset is an arc-length parameter, and on straight edges any
monotonic parameterisation looks plausible — curvature is what separates arc
length from the things that resemble it.

The frame-0-vs-frame-30 zero is a correctness result in itself: a marching border
returning exactly to its starting phase after one period means the interpolation
and the arc-length units agree.

## 2b-duodevicies. 2026-08-06 — rig controllers: existence sweep and the design calls, BEFORE any code

The posing surface (DUIK's controller layer) verified against the tree first.
**Nothing was built this run** — see "Why this stopped here" at the end.

### Existence table

Searched for the CAPABILITY, not the word: a null carrying drawn geometry, a
link from a null to an IK target, a shape-carrying transform-only layer.

| Capability | Verdict | Evidence |
|---|---|---|
| Bone hierarchy, FK | **COMPLETE** | `Bone` with `parentId`/`length`/`x`/`y`/`rotation`/`scaleX/Y`; `bone.<id>.rotation` keyframeable |
| IK targets | **COMPLETE, and keyframeable** | `IKTarget { boneId, x, y, enabled, chainLength, pole }` (`skeletonCommands.ts:21`); live values sampled from `ikTarget.<boneId>.x/.y`, poles from `ikPole.<boneId>.x/.y` |
| Pole vectors | **COMPLETE** | `pole?: {x,y}`, keyframeable, already drawn and draggable |
| Two-bone analytic + FABRIK | **COMPLETE** | pre-existing |
| Weight painting | **COMPLETE** | `weightPaint?: WeightPaintMap` |
| Puppet + skeleton on one layer | **COMPLETE** | composition order documented in `rigDeform.ts` |
| **On-canvas posing of bones / IK / poles** | **COMPLETE** | `BoneOverlay.tsx` (778 lines) — drag modes `'fk' | 'ik' | 'pole'`, writes keyframes at `layerT`, wrapped in `beginAnimEdit`/`recordAnimEdit` |
| **Controller as a distinct concept** | **ABSENT** | No `kind: 'controller'`, no controller record on `SkeletonRig`, no link field anywhere |
| Null objects | **PRESENT, but not controllers** | `insertNull()` (`parenting.ts:143`) — comment already calls them "invisible controller layers". Transform-only, **draws no geometry**, no link to a bone or IK target. This is the AE workaround, present but unwired |
| `rigLogo` | **PRESENT, unrelated** | Decides which layer is *riggable* (`RIGGABLE_KINDS = shape | image`); not a controller |
| `create_skeleton_rig` / `pose_skeleton` | **PRESENT, AI-side** | `toolHandlers.ts:1616-1617`. They author and pose a skeleton; neither creates a controller |
| Viewport-only exclusion | **COMPLETE and reusable** | `readIsGuideLayer` + ONE exclusion site, `buildSnapshot.ts:1791`, gated on `comp.forExport` |

So the hard half really is done, and the missing piece is exactly the grab
surface — plus one thing the brief did not anticipate, below.

### Reuse verdict: the effect-handle overlay does NOT fit; `BoneOverlay` does

The brief expected a sixth entry in the shared handle registry. It does not fit,
and the reason is structural rather than stylistic:

* `EFFECT_HANDLES` is `Partial<Record<EffectType, HandleSpec[]>>` — **keyed by
  effect type** (`effectHandles.ts:137`). A controller is not an effect; it has
  no entry in an effect param bag and no `effectId`.
* `EffectHandleOverlay` is driven by `useEffectHandleStore` (`nodeId` +
  `effectId`) and commits through `writeEffectParams`. A controller drag must
  write `ikTarget.<boneId>.x/.y` or `bone.<boneId>.rotation` through
  `SkeletonEditCommand`. Nothing on that path is shared.

**`BoneOverlay` is the right host, and reusing it is a bigger win than the
registry would have been.** It already carries every mechanism the brief asks
for: the shared `layerScreenMapping` projection (explicitly the
no-third-copy one), screen-constant sizing, the `'fk' | 'ik' | 'pole'` drag
modes a controller would delegate to verbatim, keyframe writes on the layer's
own axis, and one-gesture-one-undo via `beginAnimEdit`. A controller grab is the
EXISTING ik/fk drag entered from a different target — so the work is a grab
target and a link, not a drag implementation.

### Design call: controllers are RIG DATA, not layers

The brief says "controller layers", which is DUIK's shape because **AE has no rig
model** — a null layer plus an expression is the only place to put one. The same
argument the brief makes for links ("you have real IK and do not need AE's
workaround") applies one level up: this project has a real `SkeletonRig`, so a
controller belongs on it as `controllers?: Controller[]`, beside `ikTargets`,
which it resembles exactly (positioned, keyframeable, drawn on canvas, owned by
the rig).

Consequences, all of them favourable:

* undo, persistence and autosave come from `SceneGraph.setFx` with no new code,
  the same way the guide flag did;
* **no new `SceneKind`**, so no migration, no timeline/layer-list/renderer surface;
* an optional field absent from every existing document, absence meaning "no
  controllers" — additive, so no version bump (same reasoning as `PinKind`);
* **viewport-only by construction.** Rig data is never a render layer, so there
  is nothing to exclude.

That last point answers the brief's question directly: **the guide-layer
exclusion is the right mechanism for the wrong problem here.** It is needed when
a real layer must be dropped at export; a controller never becomes a layer, so
reusing `forExport` would be adding a check that can never fire. The guard for
"controllers do not render" therefore has to observe something else — rule 5·0:
the observable is that an exported frame is byte-identical with and without
controllers present, which no snapshot-layer assertion can see.

### The UI bar has an unresolved question — surfaced, not guessed

The brief says to colour-code by side using the existing `--color-layer-*` tokens
and not to invent a palette. Measured against the tree, that instruction cannot
be followed as written:

* `--color-layer-*` (`tokens/colors.css:60-68`) encodes layer **KIND** —
  text/shape/image/video/audio/camera/light/null/3d. There is no left/right/centre
  triple. Mapping sides onto three kind tokens (rose = left, blue = right,
  yellow = centre) would give a rig colour a meaning the token does not carry,
  and would drift the moment someone retints "video".
* **Every existing canvas overlay hardcodes hex** — `BoneOverlay` uses
  `#00e699`, `#ff0055`, `#a855f7` directly. No overlay resolves a token, so
  "resolve at runtime from the theme" would be a new convention, not a reused one.
* The one documented runtime resolver carries a perf warning:
  `useWorkspace.ts:1932` notes `getComputedStyle` + `getPropertyValue` forces a
  style recalculation — and an overlay redraws per frame during a drag.

Three defensible options, needing a decision rather than a guess: add three named
`--color-rig-side-*` tokens in `colors.css` following its existing conventions;
reuse three kind tokens and accept the semantic drift; or hardcode hex to match
every other overlay. Left open deliberately.

### Deferred, not started (per the brief)

IK/FK switching per chain; auto-rig presets (biped/quadruped) with controllers
pre-linked; controllers driving puppet pins directly.

### Why this stopped here

The merge, verification and this sweep consumed the run. Controllers need a
model, commands, the overlay grab surface (drawing, hover/active, halo, enlarged
hit target, link indicator), inspector wiring, five guard categories each
verified-to-fail, and runtime verification. Starting that with insufficient room
to guard it produces exactly the half-shipped result the standard forbids, so
nothing was begun. The sweep is the deliverable: it removes the wrong host
(`EffectHandleOverlay`), names the right one (`BoneOverlay`), settles the storage
question against the tree, and surfaces the one instruction that cannot be
followed as written.

## 2b. Findings logged, not fixed

Catalogued rather than absorbed.

| # | Finding | Severity | Proposed |
|---|---|---|---|
| **F34** | **`strokeWidth` is a registered keyframeable property the renderer never reads for a shape stroke — a stopwatch wired to nothing.** It sits in `propertyMeta` (`propertyMeta.ts:226`) with label, unit and default, so the inspector and timeline offer it and `isAnimated` reports true once used. But a shape stroke's width comes from `readNodeStroke(node).width` — the `fx` object — and `buildSnapshot` folds only `stroke_r/g/b/a` into the resolved stroke. `strokeWidth` appears NOWHERE in `buildSnapshot`; its live readers are the text-animator stack and preset preview, presumably where it came from. **Verified in the running app rather than inferred from a grep:** a solid stroke of width 6 with a `strokeWidth` track ramping 6 → 40 rendered **5296 stroke pixels at both ends** — track animated, keyframes present, output identical. Found while adding `strokeDashOffset`, which deliberately copied the `stroke_r` fold instead so as not to inherit this. | **Write-only UI** — the house style calls this worse than a missing feature, because it reads as working | Small: fold `a.get('strokeWidth')` in beside the dash-offset fold, guarded in `dashOffsetSnapshot.test.ts`'s shape. NOT taken here because it changes the rendered output of any project that already carries a dead `strokeWidth` track — a behaviour change wanting its own re-bless and release note, which §2a says not to bundle into an unrelated feature. Worth checking the multi-stroke stack at the same time: animated tracks bind to entry 0 only. |
| **F33** | **FIXED — see §2b-sexdecies.** ~~ARAP's local step fits the INVERSE of the rotation its own global step applies, and nothing anywhere observes the sign.** The global step rotates rest edges by `R(θ) = [[c,−s],[s,c]]` (`arap.ts:651`, `rbx += w·0.5·(cs·ex − sn·ey)`), so the local step must return the θ maximising `Σ w (R·e_rest)·e_def`. Expanding gives `c·(s00+s11) + s·(s01−s10)`, maximal at **`θ = atan2(s01 − s10, s00 + s11)`**. The code computes `atan2(s10 − s01, s00 + s11)` (`arap.ts:621`) — the negation. Checked numerically as well as on paper: flipping it moves a two-pin ARAP solve's vertex checksum from 13012.214 to 12750.384 (max \|x\| 93.32 → 90.57, ≈3%), so it is load-bearing, not a term that cancels. **And yet flipping it fails NOT ONE of the 188 tests in `src/core/rig`.** The sign is entirely unguarded — every existing assertion is determinism, NaN-freedom, difference, or clamping, and all four are symmetric under a mirrored rotation. This is §2b-quinquies' rule playing out on the solver rather than on an effect: a wrong distortion looks exactly like a right one, and ARAP degrades gracefully (it warm-starts from LBS, and an inverted local step drifts the fixed point toward softer, Laplacian-like behaviour) so there is no obvious tell. Found while deriving the bend-pin rotation convention, which deliberately did NOT reuse this expression for that reason.~~ **The struck text above overstates the coverage gap and should not be quoted.** "Every existing assertion is symmetric" was asserted, not measured; measuring it (§2b-quindecies) found **four of seven** mirror mutations already caught. The real gap was narrow: ARAP's INTERNALLY fitted rotation, unguarded because its ARAP tests compare against LBS on area preservation and rigidity and both survive a mirror. Corrected on `feat/arap-rotation-sign`, with directional guards, the mutation sweep behind them, and five re-blessed rig goldens. | **Correctness, live — visual magnitude unknown** | Not fixed here: outside the bend-pin scope, it changes the rendered output of **every ARAP-rigged layer**, and re-blessing rig goldens for it inside an unrelated change is the attribution mistake §2a forbids. Wants its own branch: add a **directional** guard first (rotate a mesh rigidly by a known +30° through its pins, assert the interior follows by +30°, not −30°), confirm it fails at HEAD, then correct the sign and re-bless with a release note. The guard must be directional — a magnitude or difference assertion reproduces the hole exactly. |
| **F32** | **Twelfth instance of underestimating what is already built — this time measured across a whole brief.** A pre-implementation sweep of ten requested features found **four already complete**: the advanced-pin on-canvas manipulator (rotation ring *and* scale handle, the part the brief assumed was missing), continuous rasterization (model, UI toggle, render tests), layer-edge/centre snapping (wired end to end through `SelectTool`'s move and resize), and the Numbers and Timecode effects (registered, with keyframeable parameters). **Three more were partial with the engine already done**: `sequenceLayerBars` takes an overlap parameter and is tested, but the only UI caller passes a hardcoded `0`; dashes exist and render, only the offset is missing; gradient strokes exist and are reachable from the inspector. Convert Expression to Keyframes was found **already shipped on the very branch the work was told to stack on**. Only two of ten were genuinely absent. All three search shapes the brief named paid out — the feature under a different name (`sequenceLayerBars` vs the unrelated keyframe-stagger `sequenceLayers`), the algorithm under a domain filename, and the model shipped without UI. | **Process** | No code fix. The standing lesson now has a number: budget the verification sweep as a real phase rather than a formality — here it cost ~15% of the run and removed ~60% of the assumed work. |
| **F14** | **FIXED (multi-subpath geometry).** ~~Trim Paths does not trim — it only trims the stroke.~~ `buildSnapshot.ts:1986` writes `layer.trim = segs`, and that field has exactly two non-test readers: the content-hash cache key (`contentHash.ts:52`) and `strokeTrimmed`, called only inside the stroke branch (`Canvas2DVectorRasterizer.ts:458`). The fill runs `shapePath → ctx.fill()` **unconditionally**, above it and independent of it (`Canvas2DVectorRasterizer.ts:445-452`). AE's Trim Paths cuts **the path itself**, so the fill follows the trim. Ours is wrong against AE for **any filled shape**, today, in shipped builds — and a new shape layer defaults to a solid fill (`#2B7EFF`), so this is the common case, not an edge one. Found while deciding whether `trim` folds into `fx.pathOps`. **This is a correctness defect, not a missing feature** — "trim doesn't fold into the stack" and "trim doesn't trim fills" get prioritised very differently, and the second is the true one. | **Correctness, live** | Fix = the multi-subpath prerequisite: lift `Pt[][]` — already produced by `trimPolyline` (`trimPath.ts:191`), the only such producer, currently consumed entirely inside `strokeTrimmed` and never escaping into the render contract — into `RenderLayer`, and teach the **rasterizer, content hash, hit-testing and bbox** about subpath lists. **The fix and the `trim`/`rep` fold-in prerequisite are the same work**; one change unblocks both. **Deliberately breaks byte-identity** for filled+trimmed shapes, so it ships as an announced **behaviour change with a release note**, not a silent migration — same treatment as the curves interpolation change and F1's error surfacing (M8b). Design context: `PREMATION_COMPLETE_REFERENCE.md` §17.5. |
| **F31** | **`captureDocument` stamps every document it writes `version: '1.1.0'`** — a hardcoded literal at `cloudDocument.ts:43`. Nothing writes `CURRENT_DOCUMENT_VERSION` (1.6.0), so a project saved by this build is five versions behind its own contents and is walked through the whole migration chain again on every open. It has been survivable only because each step happens to no-op on already-current data, which is luck rather than design: it makes IDEMPOTENCE load-bearing for every migration, present and future, and a step that rewrites unconditionally would corrupt freshly-saved work on the first reopen (1.6.0 nearly did — see §2b-septiesdecies). It also means `DocumentVersionError`'s "saved by a newer version" check can never fire for a document this build wrote. Found while writing the 1.6.0 migration. | **Correctness, latent** | One line — `version: CURRENT_DOCUMENT_VERSION` — plus a test that a captured document round-trips at the current version and a sweep of the five existing steps for anything that is only correct because it never sees its own output. NOT taken in this run: it changes which migrations run on every existing local project, which deserves its own change and its own break sweep. |
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
| **F18** | **WITHDRAWN AS WRITTEN — the conclusion was wrong, and the correction matters more than the finding.** F18 originally read "there is no way to visually verify an effect in the running app" and was about to be raised to blocking. It is false. `renderStillFrame(params, frameIndex)` (`src/core/export/offlineRenderer.ts:204`) renders a frame through the real pipeline and returns a PNG Blob; it has FOUR production callers, including `src/core/ai/renderFeedback.ts`, which exists precisely so the assistant can look at rendered frames. Verified 2026-08-05 in the running app: a Checkerboard effect with colours #ff0000/#00ff00 applied to a text layer produced a 1920x1080 PNG containing 1331 red and 886 green pixels clipped to the glyphs. **What is actually true** is narrower and was misdiagnosed: the LIVE VIEWPORT canvas cannot be read back at an arbitrary later moment. `drawImage` from it returns the clear colour because a WebGPU canvas's current texture is only valid within the task that drew it (see `gotcha_webgpu_canvas_readback_macrotask`). `componentThumbs.ts:200` does the same `drawImage` successfully by reading back in the SAME task as `renderFrame` — so the mechanism was timing, not capability, and 'drawImage returns only clear colour' named the wrong cause. Screenshots timing out when the Browser pane is not displayed is real but is a harness property, not a product gap. **Method note.** This is the seventh instance on this project of underestimating what already exists, and the first where the underestimate was recorded as a blocking finding. The error was reasoning from two failed attempts to a capability claim without grepping for an existing renderer. | **Was: development loop, blocking. Now: none — no work required** | Use `renderStillFrame` for in-app pixel verification; it is already the supported path. If live-viewport readback is ever wanted for its own sake, the fix is a debug hook that calls `renderFrame` and reads back in one task, which is the pattern `componentThumbs` already ships — S, not the renderer surgery F18 implied. |

## 2b-quinquies. Standard — testing a spatial effect

Adopted 2026-08-05 after Twirl and Corner Pin were both found shipping guards
that could not fail.

**A wrong distortion looks exactly like a right one.** Spherize shipped inverted
and passed three checks: the pixels changed, it differed from Bulge at equal
settings, and its render-test golden matched — because the golden had been
blessed from the bug. Auditing its neighbours afterwards found the same hole
open in two of them:

* **Twirl** asserted `sign(pos.x) === -sign(neg.x)` — that +90 and -90 land on
  opposite sides. Mirror the entire rotation and both flip together, so it
  passes just as happily on a twirl that spins backwards. A DIFFERENCE assertion
  wearing a directional one's clothes.
* **Corner Pin** was subtler and worse. Its projectivity and identity checks are
  both symmetric in the quad, so neither ever established where content actually
  lands. Swap source and destination and both still pass.

### The rule

1. **Derive the expected value independently, on paper, before looking at the
   implementation.** A test written from the code cannot disagree with the code.
   Twirl's expectation is arithmetic anyone can recheck: a dot at (32,12) about
   centre (32,32) with radius 30 rotates by `90 * (1 - 20/30) = 30 degrees`, and
   since `remap` asks the inverse question it lands at
   `(32,32) + R(-30) * (0,-20) = (22, 14.68)` — LEFT. A mirrored twirl puts it
   at x = 42.
2. **Assert an absolute position, not a relation between two runs.** "These two
   differ" and "these two are opposite" are both invariant under mirroring.
3. **Choose a case whose arithmetic you can do by hand**, so the test does not
   re-derive the implementation inside its own assertion. Corner Pin's uses an
   axis-aligned quad inset to the middle half, where source (8,8) maps to
   (20,20) by inspection — deliberately not a general projective quad.

   **3a. Then ask what those clean values make IMPOSSIBLE, and add a fixture at
   that boundary.** This is rule 3's failure mode, and it is the sharpest
   mistake this project has made — not a shortcut taken, but the right practice
   applied without asking what it excluded.

   Vegas: every contour fixture used alpha 200 against threshold 100, chosen so
   each crossing solves to exactly 0.5 and the whole contour is derivable on
   paper. That choice is what made the tests good. It is also what made a
   DEGENERATE crossing structurally unreachable — a sample landing exactly ON
   the threshold, where the crossing solves to 0 or 1 and lands on a grid corner.
   Nine contour tests, all green, all blind, and the defect they could not see
   broke one contour into six. The boundary fixture is three lines: the same
   block, at alpha exactly equal to the threshold.

   The pattern generalises, and every gate this project has nearly got wrong sits
   on one of these:

   | Clean value chosen | What it silently excludes |
   |---|---|
   | alpha 200 vs threshold 100 | the sample exactly AT the threshold |
   | `offsetScale` 0.5 / 2 | scale exactly 1, where the repeater commutes |
   | a trim at 37% | a trim exactly at a vertex, which commutes |
   | a repeater with offsets | the translate-only DEFAULT, which is rigid |
   | an interior shape | a shape touching the plane edge |
   | a guide layer, and separately a soloed layer | ONE layer that is BOTH, where the two rules point opposite ways |

   The last row is worth a sentence because the excluded case is not a numeric
   edge — it is a COMBINATION. Solo says "only this one" and guide says "not
   this one", so a layer carrying both is the only fixture where the two rules
   disagree, and no fixture exercising one flag at a time can produce it. Guide
   wins (a guide layer is an authoring aid; soloing one should not deliver it),
   and that is now asserted rather than left to whichever branch happens to run
   first. Rule 3a's question — what can my fixtures never produce? — reaches
   combinations as readily as numbers, and clean fixtures are single-variable
   by construction.

   **THE QUESTION TO ASK IS REACHABILITY, NOT INERTNESS.** This is the part
   worth carrying, because the obvious phrasing — "check the boundary case" —
   is not enough to know WHICH case to check, and the natural instinct
   ("is the boundary a no-op?") points the wrong way half the time.

   The direction genuinely differs:

   | Boundary | Behaviour there | The clean sample… |
   |---|---|---|
   | `offsetScale` exactly 1 | COMMUTES — the reorder is inert | …fails to commute, so the boundary is the quiet one |
   | trim exactly at a vertex | COMMUTES — degenerate | …does not, same shape |
   | alpha exactly AT threshold | BREAKS — crossings collapse onto a grid corner | …works fine, so the boundary is the loud one |
   | shape touching the plane edge | BREAKS — the contour never closes | …works fine |

   Two of those are inert-at-the-boundary and two are broken-at-the-boundary, so
   any rule phrased around inertness gets half of them backwards. What they all
   share is that the fixture could not REACH the boundary: nothing in the chosen
   values could produce a scale of exactly 1, or an alpha exactly equal to the
   threshold, or a cut exactly at a vertex.

   So the question is: **what values can my fixture never produce?** Answer that
   and add a fixture there, whatever the behaviour turns out to be. It is a
   property of the fixture, which you control and can enumerate, rather than a
   prediction about the code, which is the thing under test.

   **Worked example, applied PROSPECTIVELY rather than in hindsight.** The
   distort centres rest at the layer origin, which made the main rig's screen
   position trivially checkable — and useless: at the origin every rotation and
   scale term multiplies zero, so the composed matrix contributes nothing but
   its translation. That was spotted while writing the fixture, so a
   MOVED-centre fixture went in beside it.

   The break confirmed the reasoning afterwards: a typo'd param key
   (`centreX` for `centerX`) leaves the origin fixture GREEN, because with no
   offset applied a wrong key reads 0 exactly like a right one, and fails only
   the moved fixture. The rule found the hole before the break did, which is the
   order it is supposed to work in.

   **The rule applies to the fixtures that demonstrate the rule.** Added
   2026-08-06, from Exponential Scale, and it is the sharpest evidence the rule
   generalises: the miss was found INSIDE its own demonstration.

   The bake writes the final keyframe from the ORIGINAL end value rather than
   from the formula, because `s0 · (s1/s0)^1` is not reliably `s1` in floating
   point and an end-of-animation that drifts by a hair is unexplainable later.
   The test pinning that used 37 → 991 — values picked to look awkward, with a
   comment saying so.

   Breaking the endpoint failed NOTHING. 37 → 991 is one of the pairs where
   `s0 · (s1/s0)^1` lands exactly on `s1`, so the fixture could not reach the
   case the guard exists for. "Awkward-looking" is not the same property as
   "reaches the boundary", and picking values by eye selects for the first.

   A sweep of integer pairs found `7 → 29`, where the formula gives
   `29.000000000000004`; a sweep of random pairs put the rate near **1 in 14**,
   so the inexact case is ordinary rather than exotic — the original fixture was
   simply unlucky, in the way rule 3a says fixtures chosen for tidiness are. The
   premise is now an assertion (`expect(exponentialScaleAt(r, 1)).not.toBe(29)`)
   so it cannot rot, and breaking the endpoint fails exactly one test.

   Two things worth carrying: the property to test for is REACHABILITY, not
   apparent messiness — and where reachability is a numeric accident, SWEEP for
   a case rather than guessing one. The sweep is three lines and it answers the
   question the eye cannot.

   **Second worked example: the capture-speed ANCHOR.** Added 2026-08-06, from
   Motion Sketch, and it is the best application of this rule so far for one
   reason — the brief listed three things a casual path excludes, and DERIVING
   found a fourth that nobody had named.

   Capture speed rescales a recording's sample times. The question rule 3a asks
   is "what can my fixture never produce?", and the answer was: a first sample
   at anything other than zero. Scaling times about ZERO and scaling them about
   the FIRST SAMPLE are the same operation when the first sample is zero, and
   completely different otherwise — at 50% speed a take starting at t=2 either
   stays at 2 (correct) or jumps to 4 (wrong), and a fixture recorded from t=0
   cannot tell those apart. Every capture-speed fixture therefore starts at
   t=2, and breaking the anchor fails three tests.

   Nothing about the anchor was messy, surprising, or flagged in advance. It
   was found by asking the rule's question mechanically about a value —
   `t0` — that the obvious fixture would have set to zero without a thought.
   Which is the argument for asking it every time rather than when something
   looks suspicious: **the excluded case is usually the one chosen by default,
   and defaults do not look like choices.**
3b. **A test's stated rationale is an assertion too — measure it, and rewrite
   it when it is wrong.** Added 2026-08-05.

   The coordinate-space guards shipped with a comment claiming the 90-degree
   main case was blind to a TRANSPOSED rotation. Measured: transposing the
   matrix DOES move the result, so the claim was false. The real blind spot was
   different and worse — at 90 degrees the composed diagonal is zero, so an
   error in the `a`/`d` terms contributes nothing, which deleting those two
   terms confirmed (all four hand-derived assertions stayed green).

   Both versions of the comment sat above a passing test. That is exactly the
   danger: **a false explanation is what the next person trusts INSTEAD of
   re-deriving.** A test with no rationale at least prompts them to work it out;
   a test with a confident wrong one sends them away satisfied, and the blind
   spot it misdescribes stays open.

   So the rationale gets the same treatment as an expected value: derive it,
   then verify it by breaking the thing it names. If the break does not produce
   the failure the comment predicts, the comment is wrong — rewrite it to the
   mechanism actually measured, and say in it that it was measured.

   **The better outcome, from Bezier Warp: promote the claim to a TEST.** A
   comment there said the down-bow's null was itself directional — that a
   mirrored implementation would cover the same point. Breaking the source to
   check it did not demonstrate that, and the reason is instructive: mirroring
   `coonsPoint` alone leaves `coonsJacobian` inconsistent with it, so Newton
   stops converging and the null then comes from non-convergence rather than
   from the geometry. The break was not a faithful mirror, so it was not
   evidence either way.

   Rewording the comment would have been the minimum. What actually closed it
   was making the claim a fixture: handles moved UP put the boundary at −30, and
   the same point IS covered there. Down-bow excludes it, up-bow includes it —
   which no mirrored implementation satisfies both halves of.

   So the ladder is: a claim in prose is weakest, a claim verified by breaking
   is stronger, and a claim that has become an assertion cannot rot at all.
   Prefer the last whenever the claim is checkable — and note that an
   INCONSISTENT break (changing a function without its derivative, a value
   without its cache) proves nothing, which is its own trap.

3c. **Read a parameter's MEANING from the dispatch, not from its
   declaration.** Added 2026-08-05, from the three distort centres.

   The declaration says what a param is CALLED and what its default is. It does
   not say what the number means. Bulge, Twirl and Spherize all declare
   `centerX`/`centerY` defaulting to 0 — identical in shape to Corner Pin's
   `topLeftX`/`topLeftY`, which are offsets from a CORNER. But the dispatch
   computes `w / 2 + centerX`, so these are offsets from the MIDDLE of the box.

   Taking the declaration at face value would have rested all three handles on
   the layer's top-left and written every offset a half-box out. It compiles, it
   renders, and — this is the part that matters — it looks like a plausible bug
   in the EFFECT rather than in the wiring, so the search would start in the
   wrong file.

   The dispatch is where a param stops being a name and becomes a number in an
   expression. Read it. This generalises past offsets: units (degrees or
   radians?), sign conventions (is +Y down?), and whether a "radius" is measured
   before or after the layer's scale are all invisible in a `params` table and
   all obvious one call further in.

4. **Verify by breaking the direction, and watch which tests fail.** The proof
   is not that the new test fails; it is that the OLD guard passes while the new
   one fails. Mirroring the twirl leaves its distance-preservation check green;
   mirroring the corner-pin u axis leaves projectivity green. That demonstrates
   the blind spot instead of assuming it.
2a. **A UNIFORM error is invisible to every relative assertion.** Added
   2026-08-05, from the effect-handle overlay, and it is rule 2's mechanism
   rather than another instance of it.

   Dropping the half-box offset in `effectToLayer` moves EVERY handle by the
   same amount. So every assertion phrased as a relationship between handles —
   which one is nearest, which wins a tie, whether a point 8px away hits and one
   10px away misses — stays green, because all the distances between them are
   unchanged. Only the fixtures asserting an ABSOLUTE screen position saw it.

   Same shape as Twirl's difference assertion, but caught by design rather than
   in the wild: the question to ask of any positional guard is *what class of
   error moves my two operands together?* A translation does. A uniform scale
   does, for anything phrased as a ratio. A mirror does, for anything phrased as
   "these two are opposite".

   The defence is the same each time and it is rule 2: at least one assertion
   per guard set must name a coordinate, not a relationship.

4a. **Breaking a guard that fails NOTHING is a finding, not a null result.**
   Added 2026-08-05, from Bezier Warp, and it is the reason rule 4 has to be
   applied to EVERY guard rather than only the ones that look load-bearing.

   Deleting `solveUV`'s residual verification — the check that the (u,v) Newton
   lands on actually maps back to the target — broke no test in the file. The
   comfortable reading is "the other guards already cover it". The true reading
   is that the check was **never live**: the range check on (u,v) happened to
   reject every case the fixtures probed, so nothing in the suite had ever
   exercised the residual path at all.

   When a break produces no red, exactly one of two things is true, and both
   need closing before the guard set can be trusted:

   * the guard is DEAD — nothing it does can change any outcome, so delete it
     and stop implying coverage that does not exist; or
   * the FIXTURES cannot reach what it covers — the guard is real and the suite
     is blind to it, which is rule 3a in a different costume.

   Here it was the second. What the check was hiding is worth naming because it
   is the Spherize class — **wrong output that looks like output**: on a FOLDED
   patch Newton can exhaust its iterations at a (u,v) comfortably inside the
   unit square and nowhere near the target, and sampling there returns a
   plausible wrong pixel that reads as texture rather than as an error.

   The closure is a swept CONTRACT assertion rather than another hand-picked
   point: *every non-null answer must map back*. That is the right shape when
   the claim is universal and there is no single interesting case to derive —
   and it is what the same break now fails, and nothing else does.

   Corollary: a break that fails EVERYTHING is also weak evidence. It says the
   thing is load-bearing, not that any particular guard is watching it. The
   informative breaks are the ones that fail a little.

4b. **When a break fails nothing, the FIXTURE is a suspect too — and so is the
   break.** Added 2026-08-06, from `marker.*` and the audio channels, where
   four separate breaks failed nothing and NONE of them was a missing guard.

   Rule 4a names two readings for a silent break: the guard is dead, or the
   fixtures cannot reach what it covers. There are two more, and they are the
   ones that look most like success:

   * **The fixture ERASES the distinction under test.** Both instances were
     mocks more PERMISSIVE than the thing they replaced.
     `readAudioClipTimings` was stubbed as `() => clipTimings`, ignoring its
     node-id argument — and the thing under test was *which node's* timings get
     read, so the two nodes were identical to the fixture and swapping them
     failed nothing. The `mono()` stub returned its samples for ANY channel
     index, where a real `AudioBuffer` throws `IndexSizeError`; reading
     channel 1 of a one-channel buffer therefore "worked". Both were fixed by
     making the stub depend on what the real one depends on, after which the
     same breaks failed 2 and 1.
   * **The break itself was inconsistent**, which 3b already warns about in
     another costume. `markerScope('zzz' as 'layer')` looked like a scope swap
     and was not: the provider's `scope === 'comp' ? … : layer` branch sends
     anything non-`'comp'` to the layer list, so the code under test never
     changed. Removing a `n <= 1` mono guard likewise changed nothing, because
     a `Math.min(1, n - 1)` clamp two lines down did the same job — which is
     also a small finding about the code (one rule, two mechanisms).

   So a silent break has FOUR readings, and they need separating before any of
   them is reported: **dead guard, unreachable fixture, unfaithful fixture,
   incoherent break.** The last two are *your* mistakes rather than the suite's,
   and reporting them as coverage gaps is worse than saying nothing.

   The generalisation worth carrying, and it gets the same treatment as a
   rationale under 3b:

   > **A mock's signature is an assertion about the real API. A stub that
   > ignores an argument the real code branches on is blind to every bug in
   > that argument, silently, from inside a green suite.**

   For every stub, ask which of its parameters the real implementation actually
   honours, and which inputs the real one REJECTS.

   **Three instances is a pattern, not three incidents.** A test double
   modelling a different system than production has now bitten this project
   three times, in three unrelated subsystems:

   | Where | The double | What production actually does |
   |---|---|---|
   | `setResponsiveTime` | RETAINED mutations between calls | does not — so the test proved a state that never exists |
   | Vegas contour fixtures | clean alpha 200 against threshold 100 | 8-bit alpha lands exactly ON the threshold routinely; degeneracy was unreachable |
   | `readAudioClipTimings` / `mono()` | ignored the node id; returned samples for any channel index | branches on the node id; throws `IndexSizeError` |

   They look like three different mistakes and they are one: **the double was
   built from what the test needed, not from what the real thing does.** Every
   time, the suite stayed green; every time, what it could not see was the exact
   thing the test was named after. The check is cheap and belongs in the writing
   rather than the debugging — read the real implementation's signature and its
   failure modes before writing the stub that stands in for it.

4c. **A guard SET can be complete over the parts and empty over the SEAM.**
   Added 2026-08-06, from F30, and it is a category the four readings of 4b do
   not contain. Every one of those — dead guard, unreachable fixture, unfaithful
   fixture, incoherent break — is a property of ONE guard. This is a property of
   the set: full coverage of every component, zero coverage of their
   composition.

   The shape, concretely. Guide layers are decided by `exportComp`, a one-line
   helper that stamps `forExport` onto the comp handed to `buildSnapshot`. Two
   guards watched it, both deliberate, both correct:

   | Guard | What it observes |
   |---|---|
   | `exportPathsMarkForExport` | that the four export call sites *mention* `exportComp` — source text |
   | `guideLayers.test.ts` | that `buildSnapshot` honours `forExport` — on a comp it builds itself |

   Changing `exportComp` to return `forExport: false` — the single line deciding
   whether a guide layer reaches a delivered file — broke **nothing**. The first
   guard reads the call sites and never runs the helper; the second runs the
   rule and never asks the helper what it returns. The helper's body is watched
   by neither, and the split is exactly why: **test A checks the caller, test B
   checks the callee's contract AS A IMAGINES IT, and the callee's actual body
   falls through the middle.**

   Splitting rule from wiring was still right — they fail differently and need
   different media, which is 5·0. The cost of the split is this seam, and it has
   to be paid for deliberately rather than discovered.

   **Why §2·0's "which guards stayed green" cannot find this one.** That check
   is the strongest signal available for a set built by ENUMERATION — break a
   thing, read the whole result, and a neighbour staying green proves the two
   guards are independent. It is useless for a set built by SPLITTING, because
   the answer here is *all of them stayed green*, and a wholly green run reads
   as "nothing broke" rather than as "nothing was watching". The informative
   break of 4a fails a little; this one fails nothing at all, and 4a's two
   readings both point at a single guard that does not exist yet. The set is the
   subject and no per-guard question reaches it.

   **The mechanical check, and it is cheap.** For any value that crosses a seam
   between two guarded units, ask *which guard observes the crossing*. If the
   answer is "the first one assumes it and the second one constructs it",
   nothing does — write the third guard that calls the real producer and asserts
   what it actually returns, including the arguments the clean path never passes
   (F30's was `comp === undefined`, which every honest call site reaches and no
   fixture did).

   Ask it at the joins the code already names: a helper between a caller and a
   callee, a value threaded through a constructor, a legacy branch that
   bypasses a converter every other path runs. Task 1 of this run found one
   prospectively that way — `restoreRecovery`'s pre-1.1 branch calls
   `defaultAnimation.restore` directly, so nothing between an old snapshot and
   the engine observes the shape change (see §2b-septiesdecies).

4d. **Assert the test COUNT when verifying a break. A suite that shrinks is not
   a suite that passes.** Added 2026-08-06, from the same run, and it is the
   trap that makes every rule above unenforceable when it fires.

   Deleting a line to verify a guard left an unused import behind.
   `guideLayers.test.ts` then failed to COMPILE, its ten tests never ran, and
   the totals went 17 → 7 while the summary reported **zero failures**. Read as
   a break result, that is "the guard did not fire". Read correctly, it is "the
   guard was not present".

   "Zero failures" and "nothing ran" are indistinguishable in a summary line,
   and the break sweep is exactly when a suite is most likely to stop compiling
   — because breaking a thing is how imports become unused, types stop matching
   and fixtures stop type-checking. The failure mode is aimed at the moment you
   are relying on the count.

   So a break result is a PAIR: the tests that failed, and the total that ran.
   Record the baseline total before the sweep, compare after every break, and
   treat any drop as the break being invalid rather than as evidence. This is
   the OneDrive tell (`--listTests` counted 392 against 405) arriving through a
   different mechanism, and it belongs in 5·0's table: **a green suite cannot
   see a suite that did not run.**

5·0. **Before blessing a scene, confirm the thing under test can REACH the
   medium.** Added 2026-08-05, from F23, and numbered `·0` because it is the
   prior question to all of rule 5 rather than another clause of it. Every
   subject-choice rule below — count don't look, never test a spatial transform
   on smooth material — assumes the medium is CAPABLE of showing the failure.
   That assumption is worth one minute and is occasionally false.

   F23 is the rig overlays drawing their handles at the unparented position. The
   natural gate is a render-test scene: parent a rigged layer, bless the frame,
   fix the bug, re-bless. Rule 5b was already satisfied — a rig on structured
   material, not a smooth gradient. It would have proved nothing. The harness
   runs `createRenderBackend → buildSnapshot → renderFrame`, which is the
   COMPOSITING pipeline; pins, bones and effect handles are React chrome drawn
   over the viewport and are not in a composited frame at all. No pixel in that
   golden could move when the bug was fixed, or when it was put back.

   The distinction from 5b is the one that matters:

   | | 5b — wrong subject | 5·0 — wrong medium |
   |---|---|---|
   | Failure | dead by unlucky choice | dead by construction |
   | Recovery | pick a better subject | no subject exists |
   | Tell | frame looks plausible either way | frame cannot contain the observable |

   5b is recoverable inside the medium. This is not, and that is why it has to be
   asked first — a bad subject wastes the scene, a bad medium wastes the whole
   approach and everything built on it.

   It generalises past pixels, and each pairing below has bitten something:

   | Medium | What it structurally cannot see |
   |---|---|
   | a pixel gate | chrome, overlays, cursors — anything outside the composite |
   | a DOM snapshot | a renderer bug; the markup is identical either way |
   | a unit test | wiring — the function is right, nobody calls it |
   | a typecheck | any value, including the one that is always `undefined` |
   | a green suite | a suite that did not run (see the OneDrive trap) |

   The check is mechanical. Name the observable, name the layer of the stack that
   produces it, and confirm the medium samples THAT layer. When it samples a
   different one, stop and change medium — do not go looking for a cleverer
   fixture, because there isn't one.

   This is rule 4a arriving early. A scene that cannot see its subject is a guard
   that fails nothing, discovered before it was blessed rather than after it had
   spent a year implying coverage. Note also that such a scene does not announce
   itself: a render-test scene that fails to BUILD is not gated, so a dead scene
   reports as a pass in both directions.

   **The ordering discipline is medium-independent, which is the useful half.**
   Changing medium did not mean abandoning the method. The sequence — derive the
   expected numbers on paper, record them before touching the code, then match —
   carried over to a component test unchanged: the parented pin was predicted to
   move from `(30,0)` to `(100,110)` and landed there exactly. What rule 5
   actually teaches is the ORDER of prediction and observation. Pixels were only
   ever one way to observe.

   **The cleanest instance so far is F29 (§2b-quinquiesdecies), because the test
   file PREDICTED its own blind spot and was then proved right.** Motion Sketch's
   guards are complete and correct about the reduction, the capture speed, the
   splice and the two-track fan-out — and every one of them passes with the
   recorder never fed a single sample, because they construct their own arrays.
   The header says exactly that, in advance:

   > *What it CANNOT see is that the samples are in the right SPACE … Nothing
   > here would change if the wiring fed it screen pixels. That is a wiring
   > fact, checked in the running app.*

   And that is precisely where the bug was. `moveNodes` only keyframes when
   Auto-Keyframe is on or the layer already has an x/y track, so on a fresh
   layer the recorder was never called at all — the commonest case, silent, no
   error, with a fully green suite. Naming the blind spot did not close it; only
   changing medium did.

   Which is the rule's real content. **A test header that names what the medium
   cannot sample is a promissory note, not a guard.** It tells the next person
   where to look, and it obliges THIS person to go and look there before calling
   the feature done — in another medium, not by writing more tests in the same
   one.

5. **A golden is not independent evidence.** It records whatever the code did on
   the day it was blessed. Spherize's golden was blessed from the bug and had to
   be re-blessed after the fix.

   **Check a new golden by COUNTING, not by looking.** Added 2026-08-05. Vegas's
   first blessed frame was plausible at a glance — lights along the star, right
   colour, right size — and it was wrong. What found it was arithmetic: 13
   connected blobs against an expected 10, then a direct measurement showing SIX
   contours where the alpha had exactly ONE connected region. Eyeballing would
   have blessed it, and the golden would then have recorded the bug as the
   expectation. Pick something in the frame you can predict a NUMBER for — blob
   count, inked area, extent — and check that number.

   **And when the number is CLOSE but not equal, find out why.** Added
   2026-08-05. Moving a distort centre by 200 layer px shifted the measured
   distortion centroid 94 output px against a predicted 100. "Close enough,
   antialiasing" is the tempting reading and it is a way of not looking. The
   actual cause was geometric: at that offset the radius-160 disc reaches output
   x 660 against the layer's right edge at 630, so the clipped part biases the
   centroid left. Confirmed by re-measuring at an offset small enough not to
   clip, where the shift is EXACTLY the predicted 50.

   A 6% discrepancy you have explained is evidence. A 6% discrepancy you have
   excused is a 6% discrepancy you will still have when it becomes 60%.

   **NEVER test a spatial transform on SMOOTH material.** Added 2026-08-05, as
   a DEFAULT rather than a lesson, because it is now three runs running:

   | Effect | Subject it was first given | Why the frame proved nothing |
   |---|---|---|
   | Median | a smooth gradient | a rank filter has no outliers to remove |
   | Vegas | a convex ellipse | lights on any smooth curve look alike |
   | Bezier Warp | the gradient ellipse | a warped smooth gradient is a smooth gradient |

   Each produced a plausible frame that would have passed whether the effect ran
   correctly, ran wrongly, or did not run at all. The generalisation is that a
   transform is only visible against structure it can DISTURB, so the subject
   must carry structure of the kind the transform acts on: grain for a denoiser,
   a concave contour for a contour effect, a regular grid for a warp.

   The tell is that the effect family's shared subject is chosen for breadth,
   not for any one effect. When the effect under test is spatial, assume the
   shared subject is wrong for it and write a bespoke scene — `effect-median-
   denoise`, `effect-vegas-contour` and `effect-bezier-warp-grid` all exist for
   exactly this reason.

   **What makes a RE-bless evidence: predicting the diff first.** Added
   2026-08-05. Blessing a scene, changing the code, and blessing it again proves
   only that something moved — and "something moved" is equally consistent with
   the intended change and with a bug riding along beside it. The re-bless
   becomes evidence when the new numbers were derived on paper BEFORE rendering
   and then matched. On the repeater fold: the scaled scene's bars were predicted
   at x = 60/180/300 (spacing 80 × 1.5) and the rotated scene's copy centres at
   (100,90) → (272,211) (70 × cos/sin 35°), both written into the scene file as
   comments one commit before the fold, and both matched. Equally load-bearing:
   the untransformed scene was predicted to stay pixel-identical, and did — a
   prediction that CANNOT be satisfied by any change that moved more than
   intended, which is what makes it the strongest assertion of the three.

Applies to anything positional: warps, distortions, transforms, path operators,
layout, hit-testing.

### The deadness check is not a formality — Vegas, 2026-08-05

Rule 5 says to check a new golden is not dead before blessing it. On Vegas that
check found a real defect in the effect being blessed, and the sequence is worth
recording because every step of it was load-bearing.

**Choosing the subject was the first half.** The effects family renders every
effect on one gradient ellipse. For a CONTOUR effect that is the Median mistake
again: an ellipse's alpha boundary is smooth and convex, so lights along it look
like lights along any smooth curve — including the one a bounding-box shortcut
would draw. The scene would have passed whether the contour came from marching
squares or from `layer.width`. A five-pointed STAR was used instead, because its
outline is concave and roughly 2.4x its bounding box's width, so both the shape
and the SPACING of the lights are wrong under any fake.

**Eyeballing it was the second half.** The first blessed frame looked busy and
broadly plausible — lights along the star, roughly the right colour and size.
Zooming into one region showed a dense cluster of short dashes where the walk
should have produced one. Counting connected components put 13 blobs where 10
were expected.

**Then measure, do not guess.** Running the real extractor on the real
rasterised star reported SIX contours instead of one, four of them three-point
specks. The decisive follow-up was counting connected components of the ALPHA at
the same threshold: exactly ONE region. So the shape was not broken up — the
extractor was breaking it, and the bug was mine rather than the fixture's.

**The mechanism.** When a corner sample equals the threshold exactly, the
crossing solves to t = 0 or 1 and lands precisely on a grid CORNER, coinciding
with the crossings of the perpendicular edges. With 8-bit alpha and a threshold
of 128 that is ordinary — the star produced 85 collisions. The stitcher keyed
segments by start point alone, so each collision silently discarded one, the
walk ran into a consumed point, and one contour came apart into fragments.

**Why the unit tests could not have caught it.** Every hand-built fixture used
alpha 200 against threshold 100, chosen so crossings land at exactly 0.5 and the
arithmetic could be done on paper. That choice — the one that made the tests
derivable — is precisely the one that made degeneracy unreachable. Nine contour
tests, all green, all blind. The regression guard added afterwards uses alpha
EXACTLY at the threshold, and reverting the stitcher fails it while leaving all
nine of the others green.

The generalisation: **a fixture chosen for its arithmetic is chosen against its
edge cases.** Pick at least one whose values are awkward on purpose, and let the
render-test subject be the thing that is allowed to be messy.

### Two more rules, added 2026-08-05 from the repeater gate

Both come from runs where the OBVIOUS test case would have given the wrong
answer — in opposite directions, which is what makes them worth writing down
rather than treating as one bad day.

6. **Pick the sample by the mechanism, and assert the boundary.** The trim gate
   nearly returned the wrong answer from a DEGENERATE case (zigzag at exactly
   50% of a rect trims at a vertex, so it commutes). The repeater gate would
   have returned the wrong answer from the DEFAULT one: `defaultRepeater()` is
   `offsetX: 80, offsetRotation: 0, offsetScale: 1` — translate-only, and
   translation is rigid, so it commutes with every operator in the chain. A gate
   measured on a freshly added repeater would have reported the reorder arrows
   inert and blocked a feature that works.

   The fix is not "use a weirder sample". It is to name the ingredient the
   result rests on and vary THAT: every operator measures its effect in ABSOLUTE
   px, so a per-copy SCALE changes the ratio between operator and geometry and
   a translation cannot. The rule that generalises is `offsetScale != 1`,
   checked across 0.5/1.5/2/3 — with the boundary at exactly 1 ASSERTED rather
   than assumed, because "inert here" is half the claim and the half that
   explains the other.

7. **A gate that can say "do not build this" cannot depend on the thing it
   gates.** `repeaterFoldGate.test.ts` is written against a local `repeatRuns`
   replica, deliberately, so it could run before the operator existed and could
   return a NEGATIVE answer. Importing the shipped module would have made the
   gate unrunnable exactly when it was needed, and would have let the
   implementation define its own success criterion. The tests that exercise the
   real operator live in a separate file (`pathOpChain.test.ts`); the gate is
   not retired once the feature ships, because it is the record of why the
   feature was worth shipping.

8. **A guard that HANGS is worse than no guard.** Added 2026-08-05, from
   verifying Vegas. Breaking `walkArc`'s unwrapping did not turn the suite red —
   it allocated until the process died, because the loop's termination depended
   on an invariant maintained somewhere else. A red test names the thing that
   broke; a hang makes the whole suite unusable and says nothing. A wrong picture
   is debuggable; a hang is a hang.

   So: any loop whose exit depends on a computed quantity gets a STRUCTURAL bound
   as well. `walkArc` is bounded by the vertex count, because a run clamped to
   one perimeter can pass each vertex at most once — the bound is derived from
   the problem, not a guessed iteration cap. Then breaking the invariant produces
   a visibly wrong run, which is a test result.

   **8a. PREFER THE FORM THAT CANNOT RUN AWAY OVER THE ONE THAT IS BOUNDED.**
   Amended 2026-08-06, from Exponential Scale, where the stronger version was
   available for free and the rule as written would have accepted the weaker one.

   The bake first walked the span with an accumulator:

   ```js
   for (let t = t0 + step; t < t1 - step / 2; t += step)   // hangs on step <= 0
   ```

   A negative or zero `step` never advances toward `t1`, so the loop runs
   forever. A `Math.max(1, fps)` floor upstream prevented that — and breaking
   the floor HUNG the suite rather than failing it, which is precisely rule 8's
   complaint. Adding an iteration cap would have satisfied rule 8 as stated.

   Counting instead removes the failure mode rather than catching it:

   ```js
   const frames = Math.floor((t1 - t0) / step);
   for (let i = 1; i < frames; i++) { const t = t0 + i * step; … }
   ```

   `i` advances by construction, so no value of `step` can produce a runaway —
   the floor upstream became belt-and-braces rather than load-bearing, which is
   what "structural" should mean. Two things came free with it: float
   accumulation disappeared (frame 600 is `600 · step`, not 600 additions), and
   a guard that had been guessing at the end (`t < t1 - step/2`) turned out to
   be DEAD once `i < frames` was strict, and was deleted rather than left
   implying coverage.

   So the ladder is: an unbounded loop is worst, a bounded loop is acceptable,
   and a loop whose counter cannot fail to advance is the one to reach for. Ask
   whether the iteration can be COUNTED before reaching for a cap — a cap is a
   guess about the problem, a count is a statement of it.

## 2b-sexies. 2026-08-05 — the repeater gate PASSES, and F19 blocks the fold anyway

**The gate answer: the arrows would NOT be inert.** Measured, hand-computed
first, in `src/core/scene/repeaterFoldGate.test.ts`.

Baking copies into geometry makes chain position meaningful because every
operator measures its effect in ABSOLUTE px — zigzag's amplitude, Round Corners'
radius, Offset Path's distance — while the repeater's ladder applies a per-copy
SCALE. Scaling before the operator changes the ratio between them; scaling after
does not. On one open run (0,0)-(10,0), zigzag amplitude 1, two copies at
offsetScale 2, copy 1's midpoint is **y=2 with zigzag first and y=1 with the
repeater first**. Both figures were derived on paper and matched the
implementation exactly.

**The special case is the DEFAULT, which is the part worth recording.**
Translation and rotation are rigid, so they commute with every operator in the
chain — the ruffle moves without resizing. `defaultRepeater()` is
`offsetX: 80, offsetRotation: 0, offsetScale: 1`: translate-only. A gate measured
on a freshly added repeater would have reported the arrows inert and blocked a
feature that works. The trim gate nearly returned the wrong answer from a
degenerate case; this one would have returned the wrong answer from the default.
The rule that generalises is `offsetScale != 1`, verified across 0.5/1.5/2/3 with
the boundary at exactly 1 asserted rather than assumed.

| # | Finding | Severity | Proposed |
|---|---|---|---|
| **F19** | **RESOLVED by decision, 2026-08-05 — option (a) taken, and shipped.** ~~The fold-in cannot satisfy "existing documents render identically", and no lossless migration exists.~~ The diagnosis stands and is unchanged: copies were placed in COMP space (`x: px + c.dx`), so a repeated layer's arrangement stayed axis-aligned however the layer was rotated; folding bakes them into LAYER-LOCAL geometry, after which the layer transform turns and scales the whole group. What changed is the verdict, not the analysis. The comp-space model was an artifact of where the copies were emitted rather than a feature anyone chose, and preserving it would mean permanently carrying a wrong model to protect documents that were rendering wrong. So the semantic change is ACCEPTED and announced (§2b-septies), the migration claims what is true rather than losslessness, and the pixel gate's blindness was closed FIRST: `shape-repeater-rotated-layer` and `shape-repeater-scaled-layer` were blessed against the old behaviour one commit ahead of the fold, so the re-bless is the evidence. Measured on those two goldens: 23.4% and 20.9% of pixels moved, and `shape-repeater` — the untransformed scene — stayed pixel-identical, which is the claim. Option (b) was not taken: making the operator read the layer transform would break the chain's contract that operators are pure point-to-point functions, and would still behave badly under non-uniform scale. | **Closed — shipped as an announced behaviour change** | Document version 1.5.0. See §2b-septies. |

## 2b-decies. 2026-08-05 — the interaction layer has FIVE point-drag mechanisms

Surveyed before building the effect-handle overlay, because "which of these is
the mechanism?" is a cheaper question than "how do I build a sixth?".

| Overlay | Hit-test | Zoom-invariant | Projection | Write path | Undo |
|---|---|---|---|---|---|
| Transform gizmo | numeric, SCREEN space, `HANDLE_PICK_RADIUS = 9` | yes, by construction | `camera.worldToScreen` | WorkspaceCommand → ports | command |
| Direct Selection (mask, anchor) | numeric, WORLD space, `screenDistanceToWorld(9)` | yes, converts the constant | same | `UpdateMaskPath` → `setMaskPoints` | command |
| Device handles (camera, light) | numeric, COMP space, tolerance arg | yes, caller passes | `Project3D.projectPoint` + `parentWorldMatrixAt` | **`applyNodePropsKeyframed`** | merge key |
| Puppet pins | **DOM** — `onPointerDown` per SVG element | yes, element drawn at fixed px | own `localToScreen` | `defaultAnimation.setKeyframe` direct | `beginAnimEdit()` txn |
| Bone / skeleton | **DOM**, same | yes | **byte-identical copy** of puppet's | own | own |

**Three duplications, one of which is load-bearing.**

1. `localToScreen` / `screenToLocal` are byte-identical in `PuppetOverlay` and
   `BoneOverlay`. Textbook §2·0, low severity only because both are correct
   today.
2. "How close is close enough" is `HANDLE_PICK_RADIUS = 9` in the engine, a
   `tolerance` argument in `deviceHandles`, and a "12px tolerance" in
   `SceneGeometryOverlay`'s comment. Three numbers for one idea.
3. **The autokey rule has two incompatible definitions** — see F22.

**Is one general enough to extend? No, and the reasons are specific.**
`applyNodePropsKeyframed` is the right RULE but is welded to the Transform
component (`if (!transComp) return`) and cannot express `effect.<id>.<param>`.
`deviceHandles` is the right SHAPE — collect → hit-test → drag, pure, in core,
unit-tested — but its `DeviceHandle` is specialised to camera/light with a
hardcoded prop triple. `SelectTool.pickHandle` is the right HIT-TEST but lives
inside a tool and is tied to selection-bounds handles.

So the honest outcome was: copy `deviceHandles`' shape, generalise the write
rule rather than the writer, and reuse `layerSpaceAt` for projection rather than
adding a third `localToScreen`. Not a sixth overlay, and not an extension of any
one of the five either.

| # | Finding | Severity | Proposed |
|---|---|---|---|
| **F22** | **"Does editing this property create a keyframe?" has two answers.** Transform props go through `ports.applyNodePropsKeyframed`, which keyframes when `autoKeyframe \|\| hasAnyTrack(group)` — so the Auto-Keyframe preference counts. Effect params went through `EffectStack`'s inline `isAnimated(path)` branch, which ignores the preference entirely. A user with Auto-Keyframe ON gets a keyframe from dragging a layer and a static write from dragging a Bezier Warp handle, in the same session, with no way to tell which they will get. NOT resolved here — changing when an effect param autokeys alters behaviour every existing project depends on, which is a decision rather than a refactor. What IS resolved is the thing that would have made it worse: both the numeric field and the new canvas handle now call one `writeEffectParams`, so they cannot drift from each other while the larger question is open. | **Consistency, live** | **DIRECTION DECIDED 2026-08-05, TIMING NOT.** Effect params will unify on HONOURING the preference — "Auto-Keyframe is on but this property ignores it" is indefensible once anyone notices. It ships as its own announced behaviour change with its own release note, bundled with nothing else, same treatment as the repeater fold and the trim/fill change — and not yet. `writeEffectParams` is the single place to change when it does. |

## 2b-septiesdecies. 2026-08-06 — the expression enabled-state, and a seam found by asking

**The model change was the whole difficulty, and it was a representation
problem in three places at once.** `setExpression(nodeId, prop, src)` stored a
compiled expression, present or absent, so "disable but keep" had nowhere to
live. Adding a bit is one line; the work is that PRESENCE was doing the job of
enablement in the engine, in the undo record, and in the persisted document, and
each of the three encodes it differently.

| Layer | How presence was encoded | What it becomes |
|---|---|---|
| engine | a key in the map, or no key | `{ compiled, enabled }` |
| undo | `expressionAfter: string \| null` — the string IS the bit | `ExpressionState \| null` |
| document | `expressions[node][prop]: string` | `{ src, enabled }`, document 1.6.0 |

The undo one is the trap, and it was named in advance. `string | null` has two
states and the model now has three, so an undo across a disable had only wrong
answers available: restore the string, and a formula the user switched off runs
again; treat it as absent, and one they wanted kept is deleted. Neither is a
bug you would find by reading the diff — both look like the code doing what it
says.

**`tsc` clean means nothing on a change of this shape, and the sweep is what
matters.** A reader of presence where it should read enablement type-checks
perfectly. The sweep found three:

* `sampleInternal` — the one line where the bit decides anything.
* `diffTracks`'s `eb === ea` — correct on strings, a REFERENCE comparison on
  objects. Every snapshot allocates fresh ones, so it would have reported the
  expression as changed on every unrelated edit.
* The AI's `set_expression`, which reports "it now overrides any keyframed
  value". `setExpression` preserves the disabled bit deliberately, so on a
  disabled property that sentence is false and sends the model hunting a
  rendering bug that does not exist.

The last one is the same class as the showcase seed and `set_repeater`: a prop
path with no compile-time surface, found by reading call sites rather than by
the compiler.

### The seam, asked prospectively rather than found afterwards

Rule 4c's question — *for a value crossing between two guarded units, which
guard observes the crossing?* — was run over this change while designing it, and
it returned an answer.

`restoreRecovery` has a pre-1.1 branch that called `defaultAnimation.restore`
DIRECTLY: the one path from persisted state into the engine with no migration
between, on the subsystem whose entire purpose is not losing work after a crash.
It was correct while every schema change was additive, and it had no test
because until 1.6.0 there was nothing for one to catch. Document 1.6.0 changes
the shape of `expressions`, and `restore` reads one shape only — so an old
snapshot's expressions would have been dropped silently by the restore that
exists to prevent exactly that.

It now assembles a document at `IMPLIED_LEGACY_VERSION` and goes through
`restoreDocument` like every other foreign state — §2·0's "guarantee one
reader". Breaking it back fails exactly one test, the one written for the seam,
and **nothing else** — which is the demonstration rule 4c is about: before that
test existed, this break was green across the whole set.

Asking the question also produced a second, smaller find on the same path:
`restore` did `Object.keys(data.expressions)` on a field that a
pre-expressions snapshot does not have at all, and threw. Nothing had noticed,
because that branch never reached `restore` through a path anyone tested.

### F31, logged not fixed

**`captureDocument` writes `version: '1.1.0'` as a hardcoded literal.** Nothing
writes `CURRENT_DOCUMENT_VERSION` (now 1.6.0), so every document this build
saves is stamped five versions behind and is walked through the entire
migration chain again on every open.

It is out of scope and it is not harmless: it makes IDEMPOTENCE load-bearing
for every migration rather than a nicety. This step converts only a `string`
value and passes an object through untouched, which is why a project saved by
this build keeps its `enabled: false` — a step that rewrote unconditionally
would have worked perfectly right up until the first reopen, and the test that
catches it is in the round-trip suite, not the migration's own.

### Boundaries, and one fixture class that agrees by accident

Rule 3a on the engine guards. The obvious fixture is a keyframed property with
an expression, and it excludes:

| Excluded | Why it matters |
|---|---|
| a property with NO keyframes | its fallback is the base-value provider, a different branch |
| an expression that AGREES with the keyframes | enabled and disabled return the same number, so the fixture cannot fail |
| a CROSS-LAYER read | enablement is consulted on a node the fixture never names |
| an expression that ERRORS | `sample` catches cycles and falls back itself — same answer, other reason |

The second and fourth are worth keeping because they are fixtures that LOOK
like enablement tests and measure something else. `value * 0 + 50` on a track
that reads 50 at the sample instant proves nothing however the bit is read, and
a self-cycling expression answers identically either way because the catch
block, not the flag, produced the number. Both are in the file as negative
examples, and the main fixture's discriminating power is asserted beside them so
it cannot drift into that class unnoticed.

### The medium found the wiring, again

The component test caught something neither unit test could: `ExpressionEditor`
subscribed to the SCENE revision only. Every state it showed until now happened
to change local `draft` state too, so a scene bump was enough by accident; the
toggle changes only engine state, and without `useAnimationRevision` the switch
stayed visually on after being turned off. Both unit suites were fully green
while that was true — 5·0's point, and F29's shape one more time.

### The break sweep, with counts (rule 4d)

Baseline for the guard set: **8 suites, 92 tests.** Every break below held that
total; a drop would have meant the break was invalid rather than informative.

| Break | Failed | Stayed green |
|---|---|---|
| sampler ignores the bit | 18 | migration + undo suites — they watch shape and diffing, not sampling |
| `setExpression` re-enables on rewrite | 3 | everything else |
| `exprEqual` compares only `src` | 3 | the engine suite entirely |
| `snapshot()` always writes `enabled: true` | 10 | the migration suite |
| migration step unregistered | 5 | engine + undo suites |
| migration rewrites unconditionally | 3 | the engine suite; caught by the round-trip AND idempotence tests independently |
| recovery bypasses the migration | **1** | all seven other suites |
| panel does not subscribe to changes | 2 | everything not rendering |
| toggle button inert | 2 | everything not rendering |
| `restore` also accepts the legacy string | 1 | all but the guard written for that rule |
| AI report ignores enablement | **0** | **everything** |

The last row is a 4b finding, and the reading is *unreachable fixture*: every
`set_expression` test creates a fresh layer, where an expression is new and so
enabled, making the disabled branch structurally unenterable. Closed with a test
that disables first; the same break now fails exactly one.

The `getExpressionState` row is not in the table because it produced a different
kind of result. Breaking it failed exactly ONE test — its own — which is what a
unit no production path touches looks like. It had been written to mirror
`getDataTrack` (genuinely used in four places) and doc-commented "the undo
seam", which was false: the undo path reads `snapshot()`. Deleted rather than
left implying coverage.

### Runtime verification

In the running app (`vite`, local edition): a shape layer, Position X animated,
`value + 200` typed into the expression editor. Enabled, the status line reads
`= 1160.00 @ 0.00s` and the inspector's Position X reads 1160px — 960 + 200, as
derived. Toggled off, the switch reports `aria-checked="false"`, the source
stays in the editor, the status line reads *"Disabled — the property uses its
keyframes. Would be 1160.00"*, and Position X reads **960px**. One Undo returns
it to 1160px. No console errors.

The status-line wording is deliberate: showing `= 1160.00` beside a formula
that is not driving anything would be the misreport this feature exists to
prevent, in the one panel a user opens to find out.

## 2b-duodevicesimum. 2026-08-06 — Convert Expression to Keyframes, and two decisions taste would have got wrong

Task 1's enabled-state existed so this command had somewhere to put the
expression it replaces. The bake itself is a loop; both hard parts are choices
the code cannot make for you, and both have a wrong answer that looks fine.

### THE RANGE: the layer's extent, not the work area

The brief offered either. They are not equivalent and the argument is not about
convenience:

| | Work area | Layer extent |
|---|---|---|
| What it is | a PREVIEW scope (B/N, playback, render) | the comp times where the property affects anything |
| Outside it | the track CLAMPS — the motion silently stops | there is no outside |
| Depends on | a control set for an unrelated reason | the layer |

A work-area bake changes frames the user did not ask about. Bake two seconds of
a ten-second wiggle and the other eight hold at the endpoint — a valid-looking
result from a command whose entire promise is that the picture does not move.
The extent is exactly the range over which "nothing changed" *can* be true,
which is what makes it the one that can be tested.

The extent is HALF-OPEN, and that is not tidiness. A clip bar's `end` is one
frame past its last live frame — `isActiveAt` rejects it — so a closed range
bakes a frame the layer does not occupy. On an offset clip that frame is
outside every bar, the time axis passes it through unmapped, and the keyframe
lands a whole clip offset out of place. Found by the offset fixture; with a bar
at 0 the two axes are the identity and the extra frame is invisible.

### PLAN, THEN WRITE

The one thing this module has to get right, and it is invisible once wrong. An
expression can read its own property — `value + 200`, `valueAtTime`, `loopOut`
all do — and `value` is the KEYFRAMED base. Writing as the walk proceeds
changes the input to every later sample: frame 0 bakes 200, frame 1 then reads
a base of 200 and bakes 400. The output compounds smoothly and reads as motion.

So the plan is pure and the caller applies it in one go. Every fixture that
ignores `value` passes either way, which is the whole reason the `value + 200`
one is in the file.

**The same property has a consequence, and it was mistaken for a defect during
runtime verification before being understood.** Re-enabling a `value`-reading
expression after a bake does not restore the original motion — it compounds,
because the expression now reads the baked track where it used to read the
static value. The bake's invariant is about the DISABLED state and holds
exactly; UNDO is what restores, which is why the command is one step. Pinned as
an assertion rather than left as a sentence, per 3b's ladder.

### Rule 3a over the three obvious expressions

The brief named three and they are ordered by strength, which is worth keeping:

| Fixture | Cannot fail on |
|---|---|
| a CONSTANT expression | sampling at all — a bake that sampled once and copied passes |
| a LINEAR one | curvature — an endpoints-only bake passes, since interpolation fills it in correctly |
| `wiggle()` | nothing; it pins per-sample seeding, and only it does |
| a clip starting at 0 | the time axis — both are the identity |
| an expression ignoring `value` | the plan/write ordering |

Breaking the axis (`t = compT` instead of `getRemappedTime`) fails exactly the
two offset-clip fixtures and leaves all four clip-at-0 tests green — the
cleanest demonstration in this run that a fixture's convenience is what makes
it blind.

### The menu ⇄ registry seam, closed before it could bite

A menu entry names its command by STRING id, and both renderers grey an
unregistered id out rather than failing. "The menu lists it" and "the command
exists" were therefore two claims with nothing requiring them to meet — rule
4c's shape, in the wiring rather than in a helper. The natural guard (assert the
menu model contains the id) reads source text and stays green through a typo, a
missing registration, and an `execute` that does something else entirely.

Boot spelled out seven `for (const cmd of buildX())` loops, so there was no
single answer to "what commands does this app have". They are now one exported
`buildStaticCommands()`, which the boot sequence and the guard both read.
Breaking it both ways — typo the menu's id, drop the builder — fails 1 and 6
tests respectively; before, both were green.

Noted while there, not fixed: **Exponential Scale, Motion Sketch and Convert
Audio to Keyframes are registered commands that reach the palette and never the
Animation menu.** Adding them is their features' change, not this one's.

### The break sweep, with counts

Baseline **4 suites, 47 tests** (48 after the compounding guard). Every break
held the total.

| Break | Failed | Notable green |
|---|---|---|
| endpoints only, no per-frame sampling | 6 | the wiring and eligibility suites entirely |
| store on COMP time, not the layer axis | **2** | every clip-at-0 fixture — see above |
| write-as-you-go | 5 | the constant/linear fixtures, which cannot compound |
| delete instead of disable | 2 | the whole bake suite; only the two "not deleted" claims move |
| range = work area, else first bar | 2 | everything about values — the range is orthogonal to correctness of samples |
| closed range (`i <= frames`) | 2 | the wiggle and end-to-end tests, which compare like with like |
| context menu bakes the layer | **1** | the two-property fixture is the only one that can see it |
| menu names a TYPO'd id | **1** | the command still works; only the crossing fails |
| command never registered | 6 | the module's own suite, entirely |
| two undo steps | 2 | every value assertion |
| `enabled()` stops sharing the predicate | 2 | `execute` still works, which is the §2·0 failure exactly |

### Runtime verification

In the running app: a shape layer, Position X animated, `wiggle(3, 50)` typed
into the expression editor. Animation ▸ Keyframe Assistant ▸ Convert Expression
to Keyframes was the only ENABLED entry in that menu, which is its `enabled()`
predicate working. It reported *"Expression baked — 300 keyframes across 1
property. The expression is disabled, not deleted."*

The invariant, measured on the inspector's Position X across frames 0, 7, 14
and 21, with the expression live and after the bake:

| | f0 | f7 | f14 | f21 |
|---|---|---|---|---|
| live expression | 952.1 | 988.5 | 977.4 | 940.1 |
| baked keyframes | 952.1 | 988.5 | 977.4 | 940.1 |
| after undo, then redo | 952.1 | 988.5 | 977.4 | 940.1 |

**The first attempt at this measurement compared the baked Position X against
the panel's "Would be" preview and got 988.5 against 1016.95**, which looked
exactly like a seeding defect. It was the compounding property above: the
preview evaluates the expression against the CURRENT base, which after a bake is
the baked track. The comparison was wrong, not the bake — and the way that was
established was to measure the actual observable in both states rather than to
reason about which number was right. Rule 2a, in a medium with no goldens.

## 2b-sexiesdecies. 2026-08-06 — guide layers, and two green guards watching nothing

**Where a purpose flag lives is decided by NESTING, not by taste.** Guide
layers need `buildSnapshot` — shared by preview and export — to know which it
is building. Two homes were available and they are not equivalent:

| Home | Propagates into a precomp? |
|---|---|
| `RenderView` | **NO.** The nested recursion passes `view: undefined` on purpose (a precomp renders at its own size with none of the editor's chrome). |
| `SnapshotComp` | **YES**, free. The recursion already spreads `{...comp, width, height}`. |

`RenderView` is the more natural-sounding choice — it is the parameter that
already differs between preview and export, and `exportView()` is a single
chokepoint every export path passes through. It is also the one that would have
shipped the bug: a guide layer inside a precomp rendering into the delivered
file, one level below where anyone would look for it. The propagation question
is what separates them, and it is not visible from the call sites — only from
the recursion.

Recorded as a check: **before choosing where a render-context flag lives, find
the recursive call and read what it forwards.** Anything the recursion drops is
a flag that works at the top level and fails inside a precomp, which is the
worst failure shape available — correct in every test anyone writes casually.

| # | Finding | Severity | Status |
|---|---|---|---|
| **F30** | **Two guards, both green, neither watching the deciding line.** `exportPathsMarkForExport` asserts the four export call sites *mention* `exportComp`; `guideLayers.test.ts` asserts `buildSnapshot` honours `forExport`. Changing `exportComp` to return `forExport: false` — the single line that decides whether guide layers reach a delivered file — broke **nothing**, because the first test only reads source text and the second builds its own comp. Closed with direct tests of what the helper returns, including the `comp === undefined` boundary the clean fixture cannot reach. | **Coverage gap** | **FIXED** |

**F30 is a shape worth naming, because both guards were deliberate and good.**
Splitting rule from wiring was right — they fail differently and need different
media. But splitting a claim into two tests can leave a seam neither one covers:
test A checks the caller, test B checks the callee's *contract as A imagines
it*, and the callee's actual body is watched by neither. The join is where to
look. When a guard set is built by splitting a claim, ask which line each half
would let you change silently — and note that this one was found by rule 4's
routine break sweep, not by inspection.

## 2b-quinquiesdecies. 2026-08-06 — Motion Sketch, and a reduction that is wrong by default

**The eleventh instance, in a new form: not the feature, the ENGINE.** Motion
Sketch genuinely did not exist. `core/rig/puppetSketch.ts` did, and it holds the
entire sample→keyframe reduction — Douglas–Peucker on the spatial path, time
thinning, same-instant collapse, easing of the survivors — written for Puppet
Sketch, tested in `rig/phase3.test.ts`, wired to `PuppetOverlay`, and completely
generic: it operates on `{x, y, t}` and knows nothing about pins.

Worth distinguishing from the previous ten. Those were "the thing you are about
to build is already there". This is "the *hard part* of the thing you are about
to build is already there, under a name that does not mention it". The search
that finds it is not `grep -i "motion sketch"` — that correctly returns nothing.
It is noticing that `puppetSketch` in the rig folder is a general algorithm with
a domain-specific filename.

### The search heuristic this gives us

**When a feature seems absent, search for the ALGORITHM it needs, not the name
it has.** A name search answers "has anyone built this feature", which is the
question you already suspect the answer to. The algorithm search answers "does
the hard part exist", which is the one that changes the estimate.

For Motion Sketch the feature name returned nothing, correctly, while the
algorithm — reduce a timed point stream to keyframes — was sitting complete and
tested two folders away. Concretely, the searches that would have found it:
`Douglas`, `simplify`, `tolerance`, `Recorder`, `samples`, `{ x, y, t }`.

Filenames encode the first caller, not the capability. `puppetSketch` is generic
over `{x, y, t}` and mentions pins nowhere in its logic; `layerSpace` serves
expressions, overlays and rig handles alike; `puppetSketch`'s reduction now
serves two features under a name that still names one. That is not a mistake to
go and fix — renaming churns imports for no behaviour — but it IS a permanent
reason to search by what a thing DOES.

Stated as a check to run before estimating: name the operation in the abstract
("reduce a timed point stream", "map layer-local to screen", "undo the
layer-relative offset"), then grep for that, across `src/` **and** `packages/`.

### F28 is what the standard is FOR

Both findings below are real, but they are not equal. F29 was caught by running
the thing; a careful person catches it eventually, because an empty take is
visible the first time anyone tries the feature. **F28 would have shipped**, and
shipped looking fine: smoothing on by default produces a plausible curve from
any recording, and the only symptom is that pauses you performed are not in the
result — which reads as "I must have drifted", not as a bug.

It was caught before a line of the feature was written, by asking what
Douglas–Peucker does to a stationary hold and answering it on paper: a hold is
exactly collinear, the test is `distance > tol`, therefore the hold is dropped
at every tolerance including zero. No fixture, no run, no debugging. That is the
entire argument for deriving on paper first — the cost was five minutes and the
alternative was a feature that quietly discards the thing it was built to
record.

### `simplify: false` — the right shape for changing a shared engine

The fix needed the shared reduction to stop reducing, and the tempting spellings
were both wrong. `tolerance: 0` does not mean "keep everything" (the test is
`distance > tol`, so collinear points still go). Forking the function for
Motion Sketch would have made two implementations of the one algorithm, drifting
on exactly the cases nobody re-tests.

What went in instead is worth naming as a pattern:

* **ADDITIVE.** A new optional flag, defaulting to the existing behaviour, so
  every existing caller is untouched by construction rather than by inspection.
* **The existing consumer's suite stays green THROUGH THE BREAK SET.**
  `phase3.test.ts` — Puppet Sketch's own guards — passed on every one of the
  seven breaks run against the new code, including the break that removes the
  flag's effect entirely. That is the evidence the change is additive, and it is
  stronger than reading the diff.
* **The new behaviour is documented at the shared function**, not only at the
  new caller, because the next person to reach for the engine needs to know the
  reduction is spatial and what that costs.

| # | Finding | Severity | Status |
|---|---|---|---|
| **F28** | **A spatial reduction is the WRONG DEFAULT for motion capture, and `tolerance: 0` does not turn it off.** Douglas–Peucker keeps a point when its distance from the chord between its neighbours exceeds the tolerance. A stationary hold is exactly collinear, so every sample of it sits at distance 0 and is dropped *at any tolerance including zero* — the test is `distance > tol`. A layer held still for a second and then moved reduces to two keyframes: a straight drift across the whole take, with the pause gone. For Puppet Sketch that is an acceptable trade (pins are dragged continuously). For Motion Sketch the timing IS the content. | **Correctness, would-have-shipped** | **FIXED before shipping.** The shared engine gained `simplify: false` (additive — `phase3.test.ts` stays green through the whole break set), and Motion Sketch defaults to one keyframe per frame as AE does, with smoothing as an opt-in. Both halves asserted: the default preserves a 21-sample hold, smoothing reduces it to 2. The cost is a fact the suite holds, not a warning in a comment. |
| **F29** | **`moveNodes` only keyframes when Auto-Keyframe is on or the layer already has an x/y track** (`ports.ts:874`), so an armed Motion Sketch on a FRESH layer recorded nothing at all — the commonest case, failing silently with an empty take and no error. An armed recording now always keyframes, which is the same intent as a lit stopwatch. | **Wiring, live** | **FIXED** |

**F29 is rule 5·0 earning its place.** The unit tests are complete and correct
about the reduction, the capture speed, the splice and the two-track fan-out —
and every one of them passes with the recorder never fed, because they build
their own sample arrays. The header of `motionSketch.test.ts` says so in
advance. It took driving the real command in the running app to see zero samples
come back, and the fix is in a file the tests never touch.

**Also worth noting: this is adjacent to F22 but not it.** F22 is about whether
effect params should honour the Auto-Keyframe preference. F29 is not a change to
what Auto-Keyframe means — it is that an explicit "record this path" request
implies keyframes regardless, the same way dragging a property with a lit
stopwatch does. F22 stays untouched and undecided on timing.

## 2b-quaterdecies. 2026-08-06 — the lint gate, and why the RATIO is the argument

**42 errors, one of them real. That ratio is the case for the gate, and it is a
stronger case than "the suite should be green".**

### The real one: a constant the code never used

`stylize.ts`'s value-noise hash multiplied the seed by `1442695040888963407` —
splitmix64's constant. It needs 61 bits. A double carries 53, so JavaScript
silently rounds the literal to `1442695040888963328`, 79 less than written. The
code had never performed the arithmetic it appeared to describe, and nothing
anywhere would ever have said so: the hash still hashes, the noise still looks
like noise, and no test can fail because no expected value was ever derived from
the intended constant.

**Written as the true value rather than replaced with a representable one, and
that choice is the interesting part.** Any odd constant works for a hash, so
"fixing" it properly — picking a number that fits in 53 bits — would change
every frame of every layer using this noise. That is a behaviour change to a
shipped effect *wearing a lint fix's clothes*, and it would have shipped inside
a commit whose message said "satisfy no-loss-of-precision". Writing
`…328` keeps the output bit-identical (`1442695040888963407 ===
1442695040888963328` is `true`, which is the whole proof) and stops the source
claiming an arithmetic it does not perform. The correction is a no-op by
construction rather than by test.

### Why the other 41 matter

They were style, config and false positives — deliberate `require()` in tests,
`no-undef` on real Node globals, a `rules-of-hooks` hit on an SVG `<use>`
resolver that happened to be called `useTarget`. Individually, none worth a
commit.

Collectively they are what hid the first one. **A gate nobody can pass is worse
than no gate**, because the next real error arrives indistinguishable from the
existing noise — and this one did exactly that, for months. The argument for
running lint is not tidiness; it is that a signal only works against a quiet
background, and 41 harmless errors are not a quiet background.

Root cause worth naming separately: `CONTRIBUTING.md` promised contributors that
typecheck, test and lint must all be clean, and **nothing ran lint anywhere**.
`release.yml` ran typecheck and test, but only on a release TAG, so `dev` was
ungated entirely. The promise had no enforcement behind it, which is the same
shape as a comment where an enforcement should be (§2·0).

### The globals list is F25 at smaller scale

The eslint config declared eight Node globals inline, with a comment explaining
the choice: *"rather than pulling in the `globals` package for six names."* It
then covered nothing written afterwards — `setTimeout`, `clearTimeout`, `fetch`,
`Blob`, `FormData` all reported undefined.

This is **exactly F25** (see §2·0, *the variant INSIDE the guard*), one level
down: a hand-maintained list standing in for a set that should have been
derived, inside the thing meant to catch the problem. And the cost has the same
shape too. It was never the six false errors — it is that `no-undef` had become
**inert** in those files, so a genuinely undefined name would have looked
identical to the false ones and been dismissed with them. A guard that reports
constant false positives is not a weak guard; it is a disabled one that still
looks enabled.

Both are now derived from the thing under test — `boundScopeNames()` reflecting
the real scope Map, `globals.node` replacing the hand list.

### `better-sqlite3`: the hard dependency WAS the bug

`npm install` failed in a fresh checkout because `better-sqlite3` builds from
source and its failure aborts the entire install, leaving `node_modules` empty.
The copy-`node_modules`-across workaround was a workaround. Making the package
an `optionalDependency` is the actual fix, and the reason is that **it was
already optional in fact**: `electron/localIndexDb.ts` loads it behind a guarded
require, `index:available` returns false without it, the renderer falls back to
an in-memory index, and the header says outright that "a missing DB never blocks
editing". The manifest claimed a hard requirement the code did not have. The
declaration was the defect.

What makes that safe rather than merely convenient is the other half:
`release.yml` now asserts the driver really built before packaging. Optional for
a contributor without MSVC, mandatory for a release — otherwise "optional" would
quietly become "sometimes absent from shipped installers", which is a worse bug
than the one it fixed.

### Reverting `--fix-type directive` was also correct

32 of the remaining warnings are unused `eslint-disable` directives, and eslint
removes them all with one flag. It was applied and reverted. It rewrites 30+
files the change had no other business touching, and it deletes comments that
carry intent — an `eqeqeq` disable sitting on a *deliberate* loose compare in
the expression evaluator, where the rule is not even enabled, so the comment is
documentation rather than suppression. It also leaves trailing whitespace.

**A change that looks purely mechanical and is not.** The right home for it is
its own commit where a reviewer is looking at exactly that, not folded into a
gate change where 30 incidental files make the two real ones invisible — which
is the same "signal against a quiet background" argument as the 41 errors above,
pointed at a diff instead of a log.

## 2b-terdecies. 2026-08-06 — two features that already existed, and a guard that only half worked

**The ninth and tenth instances of underestimating what exists, back to back,
and the same reflex caused both: searching `src/core` and concluding "absent".**

`marker.*` was sized as large because "there is no marker model in `src/core`
at all". The model is in `packages/timeline/src/markers/` — `Marker` (id,
frame, duration, name, color, comment, scope, ownerId, four scopes) and
`MarkerList`. But the claim was wrong on its own terms as well:
`src/core/timeline/TimelineController.ts` carries six marker methods
(`addMarkerAtPlayhead:610`, `addLayerMarkerAtPlayhead:621`,
`goToNextMarker:711`, `goToPrevMarker:716`, `getMarkers:772`,
`getLayerMarkers:793`), plus persistence and five UI call sites. Grepping the
exact word in the exact directory the claim named would have falsified it.

The same reflex cost a second search minutes later: the expression engine is in
`packages/animation`, not `src/core`, so `setSourceRectProvider` "did not
exist" either. **`src/core` is not the codebase.** A "does X exist" check that
does not include `packages/` is not a check.

**Two checks, both cheap, both skipped:**

1. **Grep the exact word, over the whole repo, before claiming absence.** The
   marker claim named a directory and a term; running that term against that
   directory would have refuted it in one command. An absence claim is the one
   kind of claim a single grep can settle, which is exactly why it should never
   be made from memory or from a partial search.
2. **Search `src/` AND `packages/`.** Twelve packages hold the engine, the
   scene graph, the timeline, the renderer, animation, audio and workspace. A
   sweep of `src/core` alone can miss the entire subsystem under discussion —
   and has now done so twice, in one run, for two unrelated features.

The failure is not that a search came back empty. It is that "I did not find it"
was reported as "it does not exist", and a large estimate was built on top.

Then Convert Audio to Keyframes turned out to be built — `audioKeyframes.ts`,
eleven exports, the `setKeyframes`/`batch` fix for the freeze it used to cause,
and keyframes already on the layer's own axis. Three of the four requirements
were already met; only channels, the AE null shape, and reachability were
missing.

| # | Finding | Severity | Status |
|---|---|---|---|
| **F24** | **`marker.*` was a provider binding, not a data model.** Estimated large, delivered small-to-medium. The decisive detail was that `expressions.ts:410-430` already implements `numKeys`/`key(n)`/`nearestKey(t)` for property keyframes including the out-of-range clamp, so the marker surface mirrors a proven shape rather than inventing one. | **Estimation** | **SHIPPED** |
| **F25** | **The §2·0 discoverability guard only covered a hand-written list.** `expressionApi.test.ts` asserts "every function is discoverable", and its scope→table direction ran over a hardcoded `ROUND_TWO` array — so a name bound in `run`'s scope but missing from `EXPRESSION_API` worked, was invisible, and failed nothing. Proven by deleting `marker`'s autocomplete row: **0 failures.** The file's own header claimed it "closes the third edge", which was true only for sixteen names — rule 3b, a rationale that had rotted. Closed by exporting `boundScopeNames()`, a reflection of the real Map rather than a fourth list, and asserting the whole scope. That immediately surfaced **three names undocumented since they were written — `audio`, `ctrl`, `framesToTime`** — all now in the table. `audio` is the audio-reactive expression, i.e. the one feature most related to the other half of this run. | **§2·0, live** | **FIXED** |
| **F27** | **`npm run lint` was RED on `dev` — 42 errors — and nothing anywhere ran it.** `release.yml` runs typecheck and test but only on a release TAG, so nothing gated `dev` at all and lint ran in no job. **Exactly one of the 42 was a real defect:** `stylize.ts` multiplied by `1442695040888963407`, splitmix64's constant, which needs 61 bits and so is silently rounded by a double to `...328` — the code never used the constant it named. Written as the true value rather than a representable one, because any odd constant hashes fine and changing it would alter every frame using that noise; verified a no-op (`1442695040888963407 === 1442695040888963328`). The other 41 were style, config or false positives — 18 deliberate `require()` (no ESM spelling exists for "load this now, below the `jest.mock()` I just wrote"), 6 `no-undef` on real Node globals, 1 `rules-of-hooks` on an SVG `<use>` resolver named `useTarget`, 1 disable comment naming an unconfigured rule. **That ratio is the argument for the gate, not against it:** a real defect sat unnoticed for months precisely because 41 harmless ones made it unremarkable, and the next real error would have been equally invisible. | **Hygiene → one real defect** | **FIXED.** 0 errors; `ci.yml` runs typecheck/test/lint on every push and PR to `dev` and `main`; lint added to the release gate; 129 warnings frozen with `--max-warnings` so they cannot drift again. |
| **F26** | **Convert Audio to Keyframes existed and was reachable from exactly one place.** The audio layer's inspector panel — so anyone who knew the AE command by name and searched for it found nothing, and read the feature as missing rather than hidden. A model with UI, but with the UI in one corner, which is the same defect class as F25 one level up. | **Discoverability** | **FIXED** (palette command) |

**The audio channel maths carried the one design decision worth recording.**
Splitting Left/Right is only useful if the two are COMPARABLE, and the natural
implementation — call the single-channel function three times — normalises each
to its own peak, so every channel reaches 100 and a quiet right side swings
exactly as hard as the left. The information the split exists to carry is
destroyed by the obvious code, and the result looks entirely reasonable on
screen. `amplitudeEnvelopes` shares one peak across the channels actually
requested, which also makes the single-channel case reduce to the old behaviour
exactly, so the existing path is unchanged rather than "probably unchanged".

## 2b-duodecies. Release note — puppet pins and bones draw where the artwork is (F23, SHIPPED)

**Behaviour change, editor only. Rig handles move on parented and on keyframed
layers. No rendered frame changes, no export changes, no document migration.**

Puppet pins and bone handles were positioned through `worldMatrix(readGeometry
(node))`, which composes that node's own translate/rotate/scale and reads its
STATIC props. Two things were missing from that, and both are fixed by routing
the overlays through `layerScreenMapping` → `layerSpaceAt`, the resolver the
expression functions and the effect handles already used.

**They now follow layer PARENTING.** On a layer parented to anything that has
moved, the pins and bones drew at the unparented position while the artwork
rendered at the parented one. Parent a rigged layer to a null and slide the null
across the comp, and the handles stayed behind. They travel with it now. 3D
parenting works too, which the old 2×3 matrix could not express at all.

**They now follow the layer's own ANIMATION.** This is a second change, and it
is called out separately because it moves handles for an unrelated reason.
`worldMatrix` read the static x/y/rotation/scale, so on a layer whose own
transform is keyframed the handles sat at the rest pose for the whole animation
while the artwork moved away from them. They track the artwork through the
animation now.

What you will see:

  * A rig on a **parented** layer, or on a layer with a **keyframed** transform:
    the pins and bones snap onto the artwork. If you had learned to work around
    the offset, that compensation is no longer needed.
  * **Dragging** is corrected in the same motion, in both directions. The
    screen→layer conversion had the identical omission, so on a parented layer a
    dragged pin used to jump. A drag now lands where you release it.
  * A rig on an **unparented layer with a static transform** is unchanged — the
    parent chain and the animated sample both collapse to the old matrix there.
    That is the common case, and it is the reason this is not a bigger deal than
    it looks.
  * **Effect handles** — Bezier Warp, Corner Pin, and the three distort centres —
    are unaffected. They already went through `layerSpaceAt` and were already
    correct; they moved onto the shared helper as a refactor.

**Your rigs are not modified, and nothing re-renders differently.** Pin and bone
positions are stored in layer-local space, and the deformer consumes them in
layer-local space — so the deformation was always applied at the right point on
the artwork. It was only the overlay that drew somewhere else. The handle moves
onto the point it was already controlling; the change touches six files under
`src/layout/Workspace` and nothing in the renderer, the document schema or the
migration chain.

Announced rather than absorbed, on the grounds in F19 and F14: someone with a
keyframed rigged layer will notice their pins moved, and an unexplained change
in where the tooling draws is worse than a documented one. Side-effect
improvements arriving unannounced beside a fix is how behaviour drifts without
anyone owning the decision.

## 2b-undecies. 2026-08-05 — the Puppet/Bone consolidation is NOT a refactor

**Closed the same day, and one thing learned in the closing.** The obvious move
— a render-test scene with a parented rigged layer, blessed before the fix —
does not work: the harness is `createRenderBackend → buildSnapshot →
renderFrame`, and the overlays are React chrome that never enters the rendered
frame. That golden would have stayed byte-identical through the fix and proved
nothing, which is F15's dead golden in a new costume.

The repeater's ORDERING still applied; only the medium changed. A component test
asserting the wrong-but-current handle position landed first, with the corrected
number written down as a prediction, and the fix re-blessed it.

This is now **rule 5·0** of §2b-quinquies — *before blessing a scene, confirm the
thing under test can reach the medium* — recorded there with the pixel-gate /
snapshot / unit-test / typecheck generalisation, and placed ahead of the
subject-choice rules because all of them assume a medium that can show the
failure. The half worth repeating here: only the MEDIUM changed. The ordering
survived intact, which is what says the discipline was never about pixels.

Also checked, and the same blindness as `shape-repeater`: NO existing rig scene
uses a parented layer. The `parent` matches in `rig.ts` are all `parentId` on
BONES — skeleton hierarchy, not layer parenting.


Deferred, and the reason is the point rather than an excuse.

The existence table found `localToScreen`/`screenToLocal` byte-identical in
`PuppetOverlay` and `BoneOverlay`, and consolidating them onto the effect
overlay's projection looked like the cheap way to close the third duplication.
Checking before starting says otherwise: **the two projections are not
equivalent.**

`worldMatrix(g)` (`core/workspace/geometry.ts:281`) composes
`translate(g.x, g.y) · rotate · scale` — the node's OWN transform and nothing
else — and `readGeometry` supplies that node's LOCAL x/y. Neither walks the
parent chain. `layerSpaceAt` does, through `worldMatrixOf`.

So replacing one with the other would not preserve behaviour. It would CHANGE
it, which makes this a behaviour change to rig tooling wanting its own
verification, not a tidy-up. Doing it as an afterthought at the end of a run is
exactly how a "pure refactor" ships a surprise.

| # | Finding | Severity | Proposed |
|---|---|---|---|
| **F23** | **The puppet and bone overlays ignore layer PARENTING.** Both position their handles through `worldMatrix(readGeometry(node))`, which composes only that node's own translate/rotate/scale; neither references `worldMatrixOf` or `parentWorld3d`. So on a layer parented to anything that moves, the pins and bones draw at the unparented position while the artwork renders at the parented one — the same class of drift `liveWorld3d` was written to end for cameras, lights and layer-box gizmos, in a fourth and fifth place. Not reproduced on a rig yet: found by reading `worldMatrix` while checking whether the two overlays could share the effect overlay's projection. | **FIXED 2026-08-05** | Both overlays now go through `layerScreenMapping`, which wraps `layerSpaceAt`. `layerScreenMapping` is the ONLY code in `src/layout` that composes a layer transform to screen — every remaining `worldMatrix(` there is a comment — and it has three consumers: Puppet, Bone and the effect-handle overlay, whose inline copy went the same way. So the third duplication the existence table found is closed by the same change that fixed the bug. Guard landed first asserting the wrong-but-current (30, 0) with (100, 110) written down as the prediction; it is now (100, 110). **A SECOND behaviour change came with it and is called out rather than absorbed**: `layerSpaceAt` samples the ANIMATED layer transform where `worldMatrix(readGeometry(node))` read static props only, so an overlay on a keyframed layer now tracks the artwork instead of sitting at the rest pose. Same defect class, separately guarded. **Both changes ship with a release note (§2b-duodecies)** — editor-only, no rendered frame or export changes, no migration; a rig on an unparented static layer is unchanged. |

## 2b-nonies. 2026-08-05 — Bezier Warp, and a guard that covered nothing

Corner Pin's generalisation: four cubic edges, a Coons patch interior, and a
Newton inverse because a bicubic surface has no algebraic one.

**Rule 3a paid for itself twice more, and one of the demonstrations is the
cleanest yet.** The main fixture bends the TOP edge with BOTH handles moved
equally, which is what collapses the displacement to the tidy 3k·u(1−u). Two
things become unreachable as a direct consequence:

  * x is never displaced (S.x is identically w·u), so the left and right curves
    contribute nothing. Replacing both with straight lines left **every**
    top-edge assertion, the identity, and the asymmetric fixture GREEN — only
    the left-edge boundary fixture caught it. An implementation ignoring half
    the control points would have shipped.
  * the displacement is symmetric in u about ½, so conflating the two handles is
    invisible. Taking the second handle's Y from the first left the identity and
    the entire symmetric block green and failed only the three asymmetric
    assertions.

**F21 — a guard that covered nothing, found by breaking it.** Deleting
`solveUV`'s residual verification broke NO test in the file: the range check on
(u,v) happened to reject every case the fixtures probed. On a FOLDED patch it
does not — Newton can exhaust its iterations at a (u,v) comfortably inside the
unit square and nowhere near the target, and an unverified answer there samples
a plausible wrong pixel, which reads as texture rather than as an error. Closed
with a swept contract assertion (every non-null answer must map back), which the
same break now fails and nothing else does.

That is rule 4 doing the job it exists for. The check had been written on
reasoning, looked obviously necessary, and was covered by nothing — and only
breaking it said so.

**Padding: deliberately NONE, and the reason is sharper than wave-warp's.** The
patch is built by `defaultWarpPoints(w, h)` from the dimensions the effect is
HANDED, which are the padded canvas's. Padding therefore does not shift the
result, it rebuilds the rest patch around a larger box, and the same offsets
describe a different warp — the deformation would weaken as padding grew.
Unpadded keeps the warp correct and costs content pushed past the layer box.
Same exit as wave-warp and turbulent-displace: an origin and extent threaded
into the warp math.

**UI: numeric rows ship, on-canvas handles are DEFERRED and said so.** Twelve
points as twenty-four keyframeable offset rows, the same surface Corner Pin has.
Draggable handles are a real gap and their own piece of work — hit-testing,
autokey-on-drag, and viewport↔layer conversion under the layer's own transform,
which is the gizmo problem rather than the warp problem. Recorded in the module
header so the numeric-only version cannot pass for finished.

## 2b-octies. 2026-08-05 — coordinate-space expressions, and one logged limit

`toComp` / `toWorld` / `fromComp` / `fromWorld` ship over a provider, following
`setSourceRectProvider`'s shape. Two things are worth carrying forward.

**The contract is FUNCTIONS, not a matrix, and that was a §2·0 call.** A 2×3
affine covers 2D layers and nothing else: a 3D layer's layer→comp conversion
passes through the camera (a perspective divide) and its comp→layer conversion
is a ray/plane intersection. Neither is a matrix. A matrix contract would have
forced the expression host to reimplement the app's projection — a second copy
of "where does this point land", kept in step by attention. Instead the provider
hands over conversions, the arithmetic stays on the SAME `worldMatrixOf` /
`nodeWorldWithParents3d` / `readSceneCamera` the renderer uses, and
`@motion/animation` only marshals arguments.

Worth noting what made this cheap: `liveWorld3d.ts` had already established the
rule ("the renderer's answer and the chrome's answer are the same computation
with different caches"), so this is a third consumer of it rather than a new
mechanism. The first survey of `buildSnapshot`'s inline 3D block suggested the
opposite — that 3D would need a hot-path refactor. Reading one more file
changed the estimate from "block it" to "ship it". Eighth instance of
underestimating what exists.

| # | Finding | Severity | Proposed |
|---|---|---|---|
| **F20** | **`thisLayer.toComp(...)` in an expression on that layer's own Position is self-referential.** The provider resolves transforms through `evaluateNode`, which samples expressions, so the position feeds the transform that computes the position. Measured in the running app: `toComp([42, 7])[0]` returned 14904 instead of 42. It does NOT hang or corrupt — `AnimationEngine.sample` catches the cycle and falls back to the track value, so the result is bounded, just meaningless — and AE has the same hazard, reporting it as a self-reference. Everything else is exact, including the case the API exists for (`thisComp.layer('Other').toComp(...)`, verified against hand-derived coordinates in the running app) and `thisLayer.toComp(...)` from any non-transform property. | **Correctness, narrow and bounded** | Resolve the EVALUATING node's own transform from keyframes only, exactly as `ExprContext.selfAt` already does for `valueAtTime`. Needs a keyframe-only resolver threaded through BOTH this file's 2D path and `resolveNode3DTransform`'s 3D one — doing the 2D half alone would leave the two disagreeing, which is why it is logged whole rather than half-applied. |

## 2b-septies. Release note — the Repeater turns with its layer (F19, SHIPPED)

**Behaviour change, and a schema bump. A repeater on a ROTATED or SCALED layer
looks different after this build. Document version 1.5.0.**

The Repeater is an entry in the `fx.pathOps` chain now, alongside Trim Paths and
the six deformers, instead of a fixed stage that ran after all of them. Two
things follow, one of them visible.

**Its position in the stack is now meaningful.** Every operator in the chain
measures its effect in absolute px — Zig-Zag's amplitude, Round Corners' radius,
Offset Path's distance — while the Repeater applies a per-copy SCALE. Putting
the Repeater above a Zig-Zag ruffles the copies at their own sizes; putting it
below ruffles the original and scales the ruffle with each copy. Measured, not
assumed: on an open run with two copies at `offsetScale: 2`, copy 1's midpoint
sits at y=2 one way round and y=1 the other.

**Its copies live in the layer's own space.** This is the part that changes
existing projects. Copies used to be emitted at the layer's comp position plus
the ladder delta, which meant the ARRANGEMENT stayed axis-aligned however the
layer was turned: a rotated layer drew rotated copies marching along a
horizontal line. They are baked into the layer's geometry now, so the layer's
own rotation and scale carry the whole repeated group — which is what AE does
(its Repeater lives inside `contents`, below the layer's Transform) and what
anyone coming from AE expects.

What changes on screen:

  * A repeater on a **rotated** layer: the copies now march along the layer's
    own axis instead of along comp +X. Measured on the new render-test scene at
    35 degrees: 23.4% of pixels move.
  * A repeater on a **scaled** layer: the spacing scales too, so copies spread
    further apart (or closer) by the layer's scale factor. Measured at 1.5x:
    20.9% of pixels move.
  * A repeater on an **untransformed** layer is pixel-identical. That is gated,
    not asserted — `shape-repeater` still matches its original golden byte for
    byte.
  * A **gradient** fill on a repeated layer now spans the whole repeated group
    rather than repeating per copy, because the layer's box grows to contain the
    copies and gradients are built from that box. Solid fills are unaffected.
  * Per-copy **stroke width** now follows `offsetScale`, as it did before, via a
    per-run stroke override. Layers with a MULTI-stroke stack are the exception:
    the per-run override carries one stroke, so a multi-stroke repeater keeps its
    authored widths on every copy. Logged rather than half-applied.

The migration (1.4.0 → 1.5.0) converts `fx.repeater` into a chain entry appended
LAST — reproducing the old fixed `pathOps → trim → repeater` order exactly — and
reroutes all nine keyframeable parameters from `rep.<param>` to
`pathop.<opId>.<param>`. The legacy key is deleted; nothing reads it any more,
per the `fx.pathOp` (1.3.0) and `fx.trim` (1.4.0) precedent.

**The migration does not claim losslessness, and that wording is deliberate.**
It claims "identical except on rotated or scaled layers, deliberately". No
lossless migration exists: dividing the layer transform out of the offsets works
only while that transform is STATIC, and a keyframed rotation would force the
compensation to vary per frame — which makes the repeater operator depend on the
layer transform and breaks the chain's contract that operators are pure
point-to-point functions. Announced rather than silent, on the same grounds as
the curves-interpolation change, F1's error surfacing (M8b) and the Trim Paths
fix (§2b-bis).

**The gate was closed before the change, not after.** `shape-repeater` had always
used an untransformed layer, so the pixel suite was blind to exactly the case
this moves. Two scenes with a rotated and a scaled repeater layer were added and
blessed against the OLD behaviour one commit ahead of the fold, so the re-bless
is the evidence. A golden blessed after the change would have proved nothing.

**Inspector:** the Repeater's own section is gone. Its nine rows, its Composite
picker and its bounds moved onto a Repeater card in the path-operator stack,
with the same reorder arrows every other operator has.

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

## 2e. DECISION D4 — per-vertex width: ONE geometry primitive, TWO consumers

**Made before building either feature**, because deciding it while building one
is how it gets decided badly. Stroke taper and variable-width mask feather both
want "a width that varies along a path", and whether that is one mechanism
changes the shape of both.

### What already exists — checked, not assumed

`ribbonOutline` in `packages/workspace/src/tools/builtin.ts` is already a general
variable-width-stroke algorithm, under a brush-tool filename. Its own docstring
says so: *"Build the closed outline of a variable-width stroke: offset each
centreline point along its normal by half the local width, walk the left side
forward and the right side back."* It carries an arc-length taper profile, a
densifier for short inputs, and a width floor proportional to the brush.

This is the fifteenth-instance trap the brief warned about, and it is real: the
mechanism exists, it is tested, and it is invisible to a search for "taper" in
the renderer.

### The decision

**Extract the GEOMETRIC core as one shared primitive. Do NOT force one mechanism
on both features.**

The shared part is genuinely shared, and it is small:

    offsetAlongNormals(points, distanceAt) → { left[], right[] }

That is the whole of what taper and variable feather have in common — per-vertex
normals from the local tangent, offset by a per-vertex distance.

Past that point they diverge in a way that a single mechanism would have to
paper over:

| | stroke taper | variable-width mask feather |
|---|---|---|
| consumes the offsets as | ONE closed outline, filled | TWO boundaries bounding a band |
| output is | geometry (a path to fill) | a gradient//distance ramp — a rasterizer concern |
| input path is | authored beziers, needs flattening | authored beziers, needs flattening |
| profile source | two endpoints + an ease | a per-vertex authored value |

A "shared mechanism" that produced both would be a function returning either a
fill path or a shading band depending on a flag — two features wearing one name,
which is the shape §2·0 exists to stop.

### What this makes unreachable, stated

A single call cannot give a feathered tapered stroke. That is a real
composition someone will eventually want (a brush stroke with a soft edge), and
under this decision it is two passes rather than one primitive. Judged
acceptable: nothing in the current brief asks for it, and the alternative
prices every stroke draw with a shading path it does not use.

### The layering constraint this forces

`ribbonOutline` lives in `packages/workspace` — the INTERACTION package. A
renderer-side taper importing from it would be a layering inversion (the
rasterizer depending on the tool layer). So the extraction is not optional
cleanup: the primitive has to move somewhere both can reach before either
feature is built on it, and `ribbonOutline` then becomes its first caller,
keeping its brush-specific policy (pressure normalisation, the 0.05 taper floor,
the 1.4× clamp) where it belongs.

### Sizing taper, measured rather than estimated

Shape strokes are drawn by Canvas2D `ctx.stroke()` with a single `lineWidth`
(`vectorDraw.ts:310`, `:483`). Canvas2D has no variable-width stroking, so taper
is not a parameter change — it is a **change of drawing operation**: flatten the
path, build the outline, `fill()` instead of `stroke()`.

That collides with four things the stroke path already does through Canvas2D and
would have to re-implement on the filled outline:

- **dashing** — `setLineDash` + `lineDashOffset`, which the dash-offset work
  deliberately reused rather than cutting the path up (see 2b-septendecies);
- **cap and join** — free today, hand-built on an outline;
- **align** (centre/inside/outside), which currently fakes inside/outside by
  doubling the width and clipping (`vectorDraw.ts:478`);
- **gradient strokes**, whose paint is built in the layer's local space.

And unlike F34, taper WOULD need new goldens: a tapered stroke is a visible
change with no existing coverage, so it carries a blessing of its own.

**Conclusion: taper is an M, not an S**, and its first unit is the primitive
extraction plus the flatten-and-fill path — not the `taperStart`/`taperEnd`
properties, which are the cheap half and would otherwise land as a stopwatch
wired to nothing (exactly F34, one item earlier on this same board).

### Revisit if

A second consumer of the band form appears (a variable-width glow or contour
shading). At two consumers the shading half earns its own primitive; at one it
would be a generalisation written for nobody.

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
