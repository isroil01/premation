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
