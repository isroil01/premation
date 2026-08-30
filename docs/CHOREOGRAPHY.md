# Animate In / Out

Select some layers. Press **Animate In**. They arrive one after another, each
with a different entrance, as ordinary keyframes you can then edit by hand.

Animating one layer was never the slow part. The slow part is eight layers that
should arrive in sequence: you animate the first, copy its keyframes seven
times, nudge every offset, and it still reads as mechanical.

## Using it

- **Animation ▸ Animate In / Animate Out**, or type "animate" in the command
  palette.
- The plain command varies the entrance per layer. `Animate In: Rise / Pop /
  Slide / Wipe` force one for every layer.
- Layers animate in **selection order**, starting at the playhead.
- The result is real keyframes on real tracks. Open the graph editor and bend
  them; nothing has to be "expanded" first.

## What it decides for you

| Decision | How |
| --- | --- |
| Which entrance per layer | Weighted pick per role, varied by a seed |
| The gaps between layers | Non-uniform, composed in whole frames |
| Where each layer starts from | Its own resting position, sampled at that time |
| Duration, travel, curve | One of three *feels*, moved together |

**Why the entrance varies.** One entrance applied to everything is what makes
motion look templated — every element rising and fading identically reads as a
slideshow rather than as design. The archetypes come from
`core/animation/entranceArchetypes.ts`, which the AI compose recipes have used
since they shipped; the editor now reaches the same craft without a prompt.

**Why the stagger is uneven.** An evenly spaced stagger is a metronome. Real
choreography breathes, so each gap is ±30% of the nominal one.

**Why feels rather than sliders.** Duration, travel, stagger and easing are not
independent: a long move over a short distance is sluggish, and a snappy curve
stretched over a slow duration reads as a mistake. They move together, and the
per-property tuning lives in the graph editor afterwards.

## The frame-grid trap

Worth knowing if you touch this code. Keyframe times go through
`compToKeyframeTime`, which **snaps to the frame grid** — correct, since
keyframes live on frames. But it means sub-frame timing does not survive.

The first version varied the gaps by ±30% of the nominal stagger *in seconds*.
At a 0.1 s stagger on a 30 fps comp that is ±0.9 of a frame, so the gaps
rounded straight back to equal. Measured on a real selection: planned gaps of
0.0976 / 0.0902 / 0.1060 / 0.0923 were all stored as exactly `0.1`, and the
"non-uniform" rhythm came out a perfect metronome.

Multiplying and rounding was not enough either — whether the variation survived
then depended on where the multipliers happened to land, and one real selection
produced 0.976 / 0.902 / 1.060 / 0.923, every one of which rounds to the same
3 frames.

So `staggerOffsets` composes the rhythm **in frames**: ±30% of the nominal gap
where that exceeds a frame, and never less than one frame, because less than
one frame is not a variation at all. Under a 2-frame stagger every gap is one
frame, which is honest — you cannot syncopate faster than the timebase.

The unit test that missed this asserted the *planned* offsets. It now asserts
the times that were actually written, plus the rate at which a rhythm comes out
flat across 300 seeds (under 10%; it is ~2% in practice).

## Which archetypes

Four of the six: **rise**, **scale_pop**, **slide_settle**, **mask_wipe** —
everything achievable with keyframes alone.

`blur_resolve` needs a blur effect installed on the layer and `char_cascade`
needs a text animator (and a text layer). Both change the layer's *structure*
rather than its animation. They are excluded rather than silently substituted,
because falling back would skew every varied pick toward the fallback — the
sameness problem the archetypes exist to solve.

## Not Stagger Animations

**Animation ▸ Stagger Animations** (`sequenceLayers`) offsets the keyframes a
layer *already has*, and refuses a selection with none. This is the other half:
layers with no animation get one. They compose — animate a selection here, then
re-stagger it there — and neither substitutes for the other.

## Layout

```
motionCurves.ts          the named easing curves (moved out of core/ai/design.ts)
entranceArchetypes.ts    pure: which entrance, what rhythm, what keyframes
choreography.ts          impure: resting positions, frame grid, one undo step
choreographyCommands.ts  the commands, the selection, the toast
```

`entranceArchetypes.ts` is pure — planes of numbers in, plans out — so the craft
is unit-tested with no scene graph, and `core/ai/archetypes.ts` re-exports it so
the recipe layer is untouched.
