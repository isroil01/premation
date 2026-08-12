# `.motion` — what a 1.0 format freeze actually requires

**Derived from source at `a5a7f45`, 2026-08-10.** A plan, not a freeze. Nothing
here is implemented.

## Why this document exists

"Breaking `.motion` changes still expected" plus no project browser was the
combination that made the tool feel unsafe to commit real work to. The browser
now exists; this is the other half.

The point of a freeze is not that the format stops improving. It is that a file
written today opens in every later build **without the user being asked to think
about it**. That is a narrower promise than "never change the schema", and it is
achievable now.

## What the format is

A `.motion` project is a **directory bundle**, not a file (`bundleCodec.ts`):

```
project.motion/
  manifest.json     BundleManifest — documentVersion + a content hash per chunk
  scene.json        doc.scene        the scene graph
  animation.json    doc.animation    keyframe tracks + expressions
  timeline.json     { timelines, motionBlur, guides }
  meta.json         { comps, comp }  composition registry (comp = legacy single)
  …content-addressed asset blobs
```

Every `EditorDocument` field lands in exactly one chunk; empty chunks are
omitted. `doc.version` is lifted to `manifest.documentVersion`. Local-first is
**on unconditionally** in the local edition (`main.tsx`), so this is the only
shape that edition writes.

## The upgrade machinery already exists and works

`src/core/project/migrations/` is a registry of ordered steps walked by
`migrateDocument`, invoked from `restoreDocument` — the single point where a
foreign document becomes live state. That one call site covers the bundle
loader, local version history, the cloud API and legacy single-file reads.

`CURRENT_DOCUMENT_VERSION = '1.6.0'`, reached in six steps:

| Step | Change |
|---|---|
| 1.0.0 → 1.1.0 | Hoist the single active `comp` into the `comps` registry |
| 1.1.0 → 1.2.0 | Track matte: four enum values → `{ mode, inverted }` |
| 1.2.0 → 1.3.0 | Path operators: a single `fx.pathOp` → an ordered `fx.pathOps` chain |
| 1.3.0 → 1.4.0 | Trim Paths: a fixed `fx.trim` stage → an entry in the chain |
| 1.4.0 → 1.5.0 | Repeater: a fixed `fx.repeater` stage → an entry in the chain |
| 1.5.0 → 1.6.0 | Expressions: bare string → `{ src, enabled }` |

**So the honest position is better than the README's.** Old documents already
open. What is missing is not machinery — it is a *commitment*, a *test that
proves the commitment*, and a *decision about what still wants to move*.

## What still wants to move before 1.0

Each of these is a shape change the migration ladder can absorb, but each is
cheaper to do before a compatibility promise than after.

1. **`meta.json`'s legacy `comp`.** The 1.1.0 migration hoisted the single comp
   into `comps`, but the singular field is still written for back-compat. It is
   the last remnant of the pre-registry model and every reader has to consider
   both. Dropping it is a 1.6.0 → 1.7.0 step.
2. **Per-point mask feather.** `MaskPoint` carries x/y + handles and one scalar
   feather per path. Variable-width feather (a real gap — see
   `EDITOR_REFERENCE.md` §4) needs a per-point width, which is a `MaskPoint`
   shape change. If it is coming, it should land before the freeze.
3. **`trim` and `repeater` singleton assumptions.** Both are chain entries now,
   but the code resolves each with `find` because AE allows one. If that ever
   becomes many, the keyframe prop-path scheme changes again — the 1.3.0 step
   already showed that re-keying tracks is the expensive half.
4. **Template data binding.** Does not exist (zero hits for `dataBinding`).
   Whatever shape it takes will add persisted state to templates; the field
   should be reserved or the feature landed pre-freeze.
5. **Plugin-authored content.** Custom layer kinds and plugin effect parameters
   persist into the document. That surface is under active development and is
   the most likely source of a late breaking change.

## What a freeze actually requires

Four things, in order. Only the first is hard.

**1. A round-trip corpus, and a test that walks it.**
Today each migration has its own fixture. A freeze needs the inverse: a set of
committed `.motion` bundles, one per historical version, opened by the current
build in CI with the resulting document asserted — not just "did not throw", but
equal to an expected shape. Without this, "old files still open" is a claim
nobody is checking, which is the failure mode this repo has documented three
times.

**2. A written compatibility promise, scoped honestly.**
The defensible one is: *any bundle written by 1.0 or later opens in every later
1.x, and a bundle written by a later 1.x opens in an earlier one with unknown
chunks preserved and unknown fields ignored.* Forward-compat needs
`manifest.json` readers to carry unrecognised chunks through a save instead of
dropping them — cheap now, impossible to retrofit once a build has silently
eaten someone's data.

**3. A refusal path.** A document whose `documentVersion` is newer than the
build understands must fail loudly and legibly, naming the version. Today the
walker's behaviour on an unknown-future version is defined by the registry
walk; the freeze makes it a user-facing contract.

**4. Deleting the legacy single-file reader, or committing to it.** The routed
storage still opens pre-bundle `.motion` blobs. Either that is part of the
promise and gets a fixture, or it is dropped at 1.0 with a one-way conversion.
Leaving it undecided is what makes the format feel unstable even though it is
not.

## Recommendation

The migration ladder is in better shape than the product's own messaging says.
The gap is **evidence and commitment**, not engineering. Do (1) — the corpus
test — first and independently: it is valuable whether or not a freeze is
declared, and until it exists nobody can honestly say what still opens.

---

## Backend parity: what a document is promised on a weaker machine

Added 2026-08-12. This policy was already being followed — consistently, in
three separate subsystems — and had never been written down. That is worth
correcting here rather than in a code comment, because it is a promise about
what a `.motion` file MEANS, and the format freeze is where such promises live.

**The rule, in one line: degrade visibly, label it, never refuse the document.**

Unpacked, and in priority order:

**1. A document opens everywhere.** The renderer tiers WebGPU → WebGL2 → Null.
A feature that only the top tier can draw must never make a document fail to
open, fail to save, or lose data on round-trip. Whatever cannot be drawn is
still parsed, still stored, still exported, and still there when the file is
opened on a machine that can draw it.

**2. What cannot be drawn draws its INPUT, not nothing and not garbage.** A
plugin effect ships WGSL only. Requiring authors to also write GLSL ES 3.0 to
serve a fallback tier was judged the worse trade — it doubles the authoring
cost of every effect and the second version is the one nobody tests — so the
host generates a GLSL **passthrough** and the effect draws its input unchanged
on WebGL2 (`pluginEffectMaterial.ts`). A layer that renders as itself is a
degraded picture. A layer that renders as nothing, or as a broken frame, is a
corrupted one, and a user cannot tell the second from a bug in their project.

**3. The UI says so, at every surface that can show the feature.** This is the
half most easily skipped, and skipping it is what turns a documented limitation
into a support ticket: the effect appears in the browser, adds to the stack,
shows its parameters, and does nothing — which reads as a broken plugin and
sends the user to uninstall it. The predicate is `pluginEffectsCanRender()`;
the effects browser tags such an effect **"No WebGPU"** with a tooltip saying
it is saved with the project and renders where the capability exists, and
`hostApi` reports it inert to the plugin itself.

Note the shape of that predicate: it asks about a **capability**, not about a
tier name. A second predicate `isPassthroughOnly(tier)` existed beside it, was
documented as being for exactly these surfaces, and was called by none of them;
it was deleted on 2026-08-12. Two predicates for one question is how the two
answers drift apart, and the unused one was the weaker — a tier string is not
what decides whether a WGSL pipeline can be built.

**4. Nothing is hidden on the grounds that this machine cannot draw it.** A
plugin effect stays listed and stays addable on WebGL2. Hiding it would make a
document depend on which laptop authored it, which is precisely the property a
format freeze exists to deny.

**5. Divergence between backends is measured and ratcheted, not assumed.**
WebGL2 is the reference oracle — it needs no GPU and is what golden references
are blessed from — and WebGPU is gated against those references by a per-frame
ceiling (`webgpu-baseline.json`). Byte equality between two hardware
rasterizers is not a reasonable demand, so the gate's claim is narrower and
enforceable: *a frame may not get worse.* Until that ratchet existed, a plugin
shader that failed to compile on WebGPU sat at 87.8% divergence and printed a
number nobody acted on.

### What this does NOT promise

Not that a document looks identical on both tiers. It cannot: 26 frames of the
render-test suite differ measurably today, and the honest position is that they
are recorded and bounded rather than resolved. The promise is about **data and
legibility** — the file survives, and the user is told what this machine could
not draw — not about pixels.
