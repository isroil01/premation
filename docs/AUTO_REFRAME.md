# Auto-reframe

Retarget a composition to another aspect ratio, following the subject and
jumping at every shot change.

**Composition ▸ Auto-Reframe to …**, or type the aspect into the command palette
(`9:16`, `1:1`, `4:5`, `16:9`, `4:3`). Each entry greys itself out for a
composition already at that aspect, which would have nothing to pan within.

---

## What it produces

A **new composition** at the target size, holding the original as a comp
instance, scaled to cover and with a pan keyframed onto it. The source is not
touched.

That is the whole point of the shape. A 16:9 cut retargeted to 9:16, 1:1 and 4:5
is four deliverables from one edit, and all four have to follow when the edit
changes — as instances they do. Baking the crop into the original would have
produced one file and destroyed the thing it came from.

The target size keeps the source's **shorter edge**, so retargeting never
invents resolution: a 1920×1080 master becomes 1080×1920 vertical, not 2160×3840
upscaled from pixels that were never there. Both dimensions come out even,
because every H.264/HEVC encoder wants them.

## How it decides where to look

The composition is rendered once at 160 px wide, 12 frames a second, through the
same deterministic offline loop the exporter uses — the **composition**, not its
footage, because a comp is titles, graphics and effects too and a reframe that
ignores the lower third can crop it off.

Each sampled frame is scored on two cheap signals:

- **Motion** — what changed since the previous frame. The subject is the thing
  that moves; the background is the thing that does not. This carries almost
  every real shot.
- **Detail** — local gradient energy. It carries a locked-off shot: a talking
  head, a title card, a product on a table.

A **centre prior** is then *added* — not multiplied. That distinction is the
whole trick, and a failing test is what found it: scaling the map by a centred
bell does nothing to a lone blob's centroid, so a corner highlight in an
otherwise empty frame won outright and the crop lurched into the corner. Adding
a weak centred field gives the middle real mass to compete with, so an isolated
speck is pulled back while a genuine subject still wins on its own energy.

Frames with nothing in them — a dip to black, a flat graphic, an empty sky —
report low confidence and do not move the frame at all.

## How it moves

Finding the subject is the easy half. What separates a usable result from a
seasick one is three rules:

1. **A dead zone.** The frame does not move until the subject has drifted
   meaningfully off centre. Without it the crop chases a centroid that wobbles
   by a pixel a frame, which reads as a handheld camera nobody asked for.
   Operators call this slop, and every shoulder rig has it deliberately.
2. **Lag.** Once it does move, it eases toward the target over about half a
   second rather than snapping.
3. **Cuts are walls.** At a shot change the frame **jumps**. Smoothing across a
   cut produces the worst artefact this feature can have — the crop visibly
   sliding to catch up during the first half-second of every new shot, which no
   editor would leave in.

Shot changes come from the same analysis pass that scores the frames (a luma
histogram distance with an adaptive threshold — the same detector as Scene Edit
Detection). Rendering twice to ask two questions about the same frames would
double the only expensive part of this.

A subject merely *moving* is not a cut, and the detector is right about that:
it compares luma distributions, which barely change when something slides
across an otherwise unchanged frame.

## The keyframes are yours

The pan is written as ordinary position keyframes on an ordinary layer, thinned
to the ones worth having: a 30-second shot that barely moves gets two, not 360.
Cut boundaries are held on both sides so nothing ramps through them.

So the result is editable. If the automatic framing misses on one shot, drag its
keyframes — you are not fighting a black box, and there is nothing to re-run.

## Source map

| File | What it owns |
|---|---|
| [`saliency.ts`](../src/core/reframe/saliency.ts) | Where the eye goes in one frame. Pure. |
| [`reframePath.ts`](../src/core/reframe/reframePath.ts) | The dead zone, the lag, the cut walls, and the keyframe thinning. Pure. |
| [`autoReframe.ts`](../src/core/reframe/autoReframe.ts) | The analysis pass and the new composition. |
| [`reframeCommands.ts`](../src/core/reframe/reframeCommands.ts) | One command per target shape. |
