# Spike — the compositing-group boundary

**Written:** 2026-08-03 · **Milestone:** M0.5 (design only, no code)
**Question it exists to answer:** is M8 (Stencil / Silhouette) a *generalisation*
of what we have, or a *rewrite*?

**Verdict up front: generalisation.** But the plan's framing of the constraint
was wrong in our favour, and the spike found a pre-existing correctness cliff of
exactly the class we were trying to avoid creating. Both below.

---

## 1. The boundary already exists

`CompositionPass.prepareIsolatedPrecomp` (`CompositionPass.ts:638`) does all
four things a compositing group needs:

1. renders a subtree into a dedicated offscreen target (`:659-660`)
2. bakes the container's own mask into that target (`:664`)
3. registers the result as a texture under `precomp:<id>`
4. returns the container as **one plain full-viewport textured renderable**,
   which then flows through the ordinary per-layer machinery — blend, advanced
   blend, effects, matte (`:630-632`)

Step 4 is the important one. A group is not a special case downstream; it is a
layer. That is precisely the property Stencil/Silhouette needs: apply the
stencil to the group's accumulated alpha, then composite the group into its
parent like any other layer.

---

## 2. Correction — the cap is nesting DEPTH, not group count

The plan (and my audit) treated `PRECOMP_TARGETS.length === 4` as "at most four
groups." **That is wrong**, and the code says so plainly at `CompositionPass.ts:68`:

> Offscreen targets for isolated precomps, one per nesting depth. A precomp's
> subtree renders into its depth's target and is composited (as one unit) before
> any sibling can reuse the slot, so one target per depth suffices.

Slots are indexed by `st.depth`, not by a running count. Siblings reuse the same
slot sequentially, because a group is fully composited before the next one
starts. So:

| | Real limit |
|---|---|
| 100 stencil scopes side by side at the same level | **1 slot.** Fine. |
| A stencil scope nested inside a stencil scope inside a precomp inside a precomp | 4 slots — at the cap |
| 5 levels of *nesting* | Exceeds the cap |

This makes the constraint far more forgiving than the plan assumed. Five levels
of nested compositing groups is rare in real projects; five stencil layers in one
comp is not, and that case costs one slot. **The cap is not the blocker.**

---

## 3. The severity asymmetry is real — and already shipping

Your point 3 was that the same `inlineFallback` carries two severity classes:
degradation for precomp, wrong alpha for stencil. Confirmed. And the spike found
that **the wrong-output branch already exists in the matte path.**

`CompositionPass.ts:1057` prepares a *precomp used as a matte source* with
`inlineFallback: false`:

```
const source = rawSource.precomp
  ? this.prepareIsolatedPrecomp(ctx, rawSource, st, st.depth + 1, false)
  : rawSource;
const matteTex = source ? this.layerIntoTarget(...) : null;
if (matteTex && mattedTex) { …emitMatteCombine… }
// :1068  "No source resolved — fall through and draw the layer normally."
```

When the depth cap is hit, `source` is null → `matteTex` is null → the combine is
skipped → **the matted layer renders with no matte at all.** Not slower. Not
degraded. A layer that should be cut to a shape draws in full, silently.

That is the same failure class we were designing to avoid, live today, one level
deeper than a comp with 4 levels of nesting. I have **not fixed it** — out of
scope for M0.5, and out of scope for M2/M0. Logging it as a finding (§7).

Its relevance to M8: the codebase has already faced "group unavailable, what
now?" for mattes and answered *silently do the wrong thing*. M8 must not inherit
that answer, and there is now a concrete reason to revisit the matte one.

---

## 4. Is `inlineFallback` a legal state for a stencil scope?

**No.** For precomp, collapsing inline (`children × container opacity`, `:649`)
loses isolation but produces the same pixels in the common case. For a stencil
scope, collapse changes *which layers are inside the boundary*, and the stencil
then applies to the wrong set — the alpha result is wrong with no signal.

**Approved behaviour (2026-08-03) — and it differs by surface:**

| Surface | Behaviour |
|---|---|
| **Preview** | Render the group **without** the stencil and surface it via the existing `EngineError` / tier-badge channel `MotionRendererBackend` already uses for GPU-tier fallbacks. Degraded and visible. |
| **Export** (`offlineRenderer`) | **Fail the render.** |

The asymmetry is deliberate. A warning in the preview UI reaches the person who
can act on it; the same warning during an export is a log line next to a file
someone is about to ship. Wrong pixels on screen are recoverable — wrong pixels
encoded into a delivered MP4 are not.

Explicitly rejected: silent inline collapse, and dropping the layer.

The preview half keeps the "degraded, not corrupt" discipline used elsewhere
(unknown blend modes fall back to `normal`; a failed GPU tier shows a visible
error rather than a blank stage). The export half is the one place that
discipline is wrong, because there is no one left to see the degradation.

**Scheduled as M8a**, built once and applied at both the stencil boundary and
`CompositionPass.ts:1057` (finding F1, now M8b).

---

## 5. Allocation and cost

**Nothing allocates inside the render loop.** All targets are declared once at
graph-build time via `graph.declareTarget` (`passes/index.ts:115-125`) with a
size function of the viewport; the graph re-materialises them on viewport resize,
not per frame. A generalised group that reuses `PRECOMP_TARGETS` inherits that
property for free.

Each precomp target is **full-viewport, `rgba16float`, `depth: true`,
`samples: 4`** (`MSAA_SAMPLES = 4`, `passes/index.ts:31`). That is the most
expensive target shape in the graph, and there are already four of them. Two
consequences:

- **Growing the pool is not cheap.** Raising 4 → 8 roughly doubles the heaviest
  allocation in the renderer. Do not do it reflexively to buy nesting depth.
- **A stencil scope may not need depth or MSAA.** If stencil groups are 2D-only,
  a separate, cheaper pool (`rgba16float`, no depth, no MSAA) may cost less than
  extending the existing one — worth measuring before choosing.

---

## 6. What the layer model must carry

Minimum for M8:

- **A scope marker** on the layer: which compositing group this layer belongs to.
  Precomp gets this implicitly from the node tree; stencil needs it *within* a
  flat sibling list, since a stencil applies to everything below it **in its own
  group**.
- **The stencil mode itself** — `stencil-alpha | stencil-luma | silhouette-alpha
  | silhouette-luma`, which are 4 of the 21 missing blend modes and therefore
  land in the existing `LayerBlendMode` union, not a new field.

**Is that a schema change?** The blend mode is additive (new enum values, absent
from every existing document — no migration). The scope marker is the open
question: if groups are derived from existing structure at snapshot-build time,
**no schema change and M8 is not gated on M0**. If groups must be authored and
persisted, it is additive-optional and still needs no migration, only a version
bump. Either way M0 is not a hard prerequisite — **downgrade that edge in the
plan's graph from a gate to a maybe.**

---

## 7. Findings logged, not fixed

Per the milestone rules — catalogue, fix nothing outside scope.

| # | Finding | Severity |
|---|---|---|
| 1 | **Precomp matte source beyond the depth cap renders the layer UNMATTED, silently** (`CompositionPass.ts:1057` + `:1068`). Pre-existing; same severity class as the stencil risk. | Correctness, latent |
| 2 | The audit and plan both described `PRECOMP_TARGETS` as a *count* cap. It is a *nesting depth* cap. My error; corrected in §2. | Doc accuracy |
| 3 | Precomp targets are the heaviest in the graph (viewport × rgba16float × depth × MSAA 4). No current test asserts a memory ceiling. | Perf, unmeasured |

Finding 1 is worth its own small milestone. It is not M8 — it is today's matte
path, it has nothing to do with stencil, and it should not be smuggled into a
stencil milestone where it would be invisible in review.

---

## 8. Answer to the M8 decision point

| | |
|---|---|
| **Decision** | Is M8 a generalisation or a rewrite? |
| **Answer** | **Generalisation.** The boundary, the target pool, the "group is just a layer" downstream contract, and the out-of-loop allocation all exist. |
| **Estimate** | **L stands.** Not revised. |
| **Caveat** | The work is in the *scope model* (which layers are in which group) and in the *cap behaviour*, not in the render plumbing. |
| **Gate change** | M8's dependency on M0 downgrades from a gate to a maybe (§6). |
| **Prerequisite added** | Decide cap behaviour per §4 before implementation; do not inherit the matte path's silent fallthrough. |
