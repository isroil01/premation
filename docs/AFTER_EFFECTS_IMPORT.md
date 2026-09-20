# Opening After Effects projects

The editor reads `.aep` and `.aepx` files: **File ▸ Open After Effects Project…**,
or drop one onto the canvas. The project is converted into a native document —
compositions, layers, keyframes, masks, effects and footage — and everything
after that is ordinary editing. Nothing stays linked to the original file, and
the editor never writes back to it.

## What the conversion is, and is not

An `.aep` is Adobe's own format for Adobe's own renderer, and this is a
different renderer. So the import is a **conversion with a report**, not a
round trip: it carries across everything it has an equivalent for, and tells
you plainly what it could not. The dialog that appears after an import with
losses is the contract — if it is empty, nothing was dropped.

The original file is never modified. Opening one starts a new untitled
document, so the first Save asks where to put it rather than overwriting a
project After Effects still needs to open.

---

## What comes across

| | Notes |
|---|---|
| **Compositions** | Size, frame rate, duration, background, work area, motion blur settings. Every comp in the project, including ones nothing references. |
| **Folders** | The project's folder tree is read and carried on each item. |
| **Layers** | Name, stacking order, in/out points, start time, parenting, enabled/solo/shy/locked/guide/adjustment/3-D switches, label colour, blending mode, track matte. |
| **Transforms** | Anchor point, position (including separated dimensions), scale, rotation, orientation, opacity — static and keyframed. |
| **Keyframes** | Times, values, hold/linear/bezier interpolation, temporal eases, spatial tangents, roving. See *Easing* below. |
| **Masks** | Outline, mode, inversion, feather, opacity, expansion. |
| **Effects** | ~200 effects map onto this editor's own (see `aepEffects.ts`). Parameters are matched by label. |
| **Text** | The string, font, size, fill colour, justification, tracking, faux bold/italic. |
| **Footage** | Files are relinked from the paths AE recorded; solids become solid layers with their colour; placeholders come across as placeholders. |
| **Nested comps** | A comp used as a layer becomes a comp layer pointing at the imported composition. |
| **Expressions** | Carried as text on the property that had them — **not evaluated**. Re-enable one to run it here. |

### Known limits

These are reported in the import dialog rather than being silent:

- **Shape layers** arrive as empty groups with their transform, effects and
  children intact. The vector contents are not converted yet.
- **Animated masks** import their first shape; the rest of the outline
  animation is dropped.
- **Mixed character styling** in a text layer flattens to the first style.
- **Third-party effects** with no equivalent here are skipped and named.
- **Expressions are not evaluated** on import.
- **Camera and light layers** come across as layers, but their AE-specific
  options are not mapped parameter for parameter.

---

## How it works

Six steps, each its own module, each testable on its own:

```
bytes ─▶ riff.ts / aepx.ts ─▶ aepRead.ts ─▶ aepPlan.ts ─▶ aepApply.ts ─▶ report
        chunk tree           AepProject     import plan   the live scene
```

| Module | Job |
|---|---|
| `riff.ts` | The RIFX container: chunks, lists, and a byte reader with named offsets. |
| `aepx.ts` | The XML form of the same document, producing the identical chunk tree. |
| `aepProperties.ts` | Property trees, values, keyframes, mask outlines. |
| `aepText.ts` / `cos.ts` | Text layers, written in Adobe's COS object notation. |
| `aepRead.ts` | Chunk tree → `AepProject`, still in **AE's** units and conventions. |
| `aepEase.ts` | AE's speed/influence easing → cubic bezier handles. |
| `aepEffects.ts` | AE match names → this editor's effects. |
| `aepPlan.ts` | **Pure.** `AepProject` → an import plan, in *this editor's* terms. |
| `aepApply.ts` | Builds the plan in the live scene. The only impure step. |
| `aepImport.ts` | The single entry point every surface calls. |

The split between `aepRead` and `aepPlan` is the important one: the reader
speaks AE and the planner speaks this editor, so a defect is either *"we read
the file wrong"* or *"we mapped it wrong"*, never both at once.

---

## The format, for anyone changing this

`.aep` is a big-endian RIFF file: `RIFX`, a size, the form type `Egg!`, then a
tree of chunks. `.aepx` is the same tree transcribed to XML, with leaf bodies
hex-encoded in a `bdata` attribute.

```
RIFX / Egg!
  head                     AE version
  LIST Fold                the project's root folder
    LIST Item              idta byte 0–1: 1 folder, 4 composition, 7 footage
      idta  Utf8 "name"
      cdta                 composition settings (204 bytes)
      LIST Layr            one per layer, TOP LAYER FIRST
        ldta               layer record (164 bytes)
        Utf8               the layer's name, empty when never renamed
        LIST tdgp          the property tree
      LIST Sfdr            a folder's contents
      LIST Pin             a footage item: sspc, the alias JSON, opti
```

A property group alternates `tdmn` (a 40-byte match name) with the member it
names, and ends at `tdmn "ADBE Group End"`. A leaf property is a `LIST tdbs`
holding `tdb4` (what kind of property), `cdat` (its static value) and, when
animated, a `LIST list` of `lhd3` + `ldat`.

### Things that are not guessable

Each of these was found the hard way and is the reason the corresponding code
looks the way it does:

- **`DLay` and `SLay` are not layers.** Every comp carries eleven of them —
  they are the comp viewer's own cameras (Default, Front, Top, …) and they have
  the same `ldta` and the same property tree as a real layer. Only `Layr` is a
  layer.
- **A property at its default is absent, not written.** No `ADBE Position` in
  the file means "centred in the comp", not "at 0, 0". Reading a missing
  transform as zero piles every layer into the top-left corner.
- **Keyframe layout is decided by item SIZE, not by a type tag.** `lhd3` says
  type 4 for every keyframe kind. 3-D position and 3-D scale are *both* 128
  bytes and are told apart only by the spatial flag on the property's `tdb4`.
- **Several properties are not stored in AE's own units.** Opacity, Scale and
  Mask Opacity are 0–1 fractions shown as percentages; colours are ARGB in
  0–255; an effect's point parameters and a footage layer's anchor point are
  fractions of the layer's size; mask vertices are fractions of a bounding box
  that is itself a fraction of the layer.
- **The influence in a keyframe's ease is a fraction** (0.75), not a percentage.
- **Text is COS, and its body is a dictionary with no `<<` around it.** Its
  strings are UTF-16BE behind a byte-order mark, and its parentheses nest.
- **Blending-mode indices are neither contiguous nor in menu order.**
- **Keyframe times are counts of the comp's `internalTimebase`** (24576 at
  24 fps), not seconds.

### Easing

AE stores a speed and an influence per keyframe, not a curve. For a segment
from A to B with `dt = tB − tA` and `dv = vB − vA`:

```
x1 = A.outInfluence                       x2 = 1 − B.inInfluence
y1 = A.outSpeed · dt/dv · A.outInfluence  y2 = 1 − B.inSpeed · dt/dv · B.inInfluence
```

`dt/dv` normalises AE's real-world speed into the unit square; multiplying by
the influence turns a tangent *direction* into a control-point *position*. This
is the same conversion Lottie exporters perform, which makes a useful
cross-check: a file exported from AE to Lottie and one imported here from the
`.aep` should ease identically.

---

## Testing

`src/core/aep/__testHelpers__/buildAep.ts` writes real RIFX bytes from named
options — real `cdta`, real `ldta`, real keyframe `ldat`. Every offset in it is
the inverse of one in the reader, so the pair is a genuine round trip and a
wrong offset in either direction fails.

```bash
npx jest src/core/aep
```

The offsets themselves were read off real After Effects projects (AE 25.6) and
cross-checked against the values AE's own scripting API reports for the same
files — in particular the mask-outline denormalisation, which is the one place
a plausible-looking arithmetic mistake produces a plausible-looking rectangle.

## Acknowledgement

The binary layout of `.aep` is not documented by Adobe. The chunk and record
layouts implemented here were verified against real project files, informed by
the reverse-engineering published in [py-aep](https://github.com/forticheprod/py-aep)
(MIT). The implementation in this repository is our own.
