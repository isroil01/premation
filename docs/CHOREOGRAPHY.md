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

Pick one with **Animation ▸ Motion Feel: Snappy / Smooth / Bouncy**. It is a
preference, not a per-command argument: four values against ten choreography
commands and five beat ones is a palette nobody can read, and "how motion feels
in this project" is a taste decision made once rather than re-made per gesture.
The beat-synced commands read the same setting — the music sets the rhythm, the
feel still decides how each entrance moves.

(This shipped a day late. The three feels existed, were tested and documented,
and every command hardcoded `smooth`, so two of them were unreachable — the
same dead-option shape this codebase already had in `pickFeatures`. A test now
pins the commands that select them.)

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

## On the beat

**Animation ▸ Animate In on Beats** replaces the computed stagger with the
music's own pulse: one layer per beat of the composition's audio layer. There
is also **Markers on Beats** (and a half-time variant of each, because most
cuts phrase on every second beat rather than every one).

The analysis is `@motion/audio`'s `analyseAudio` — spectral-flux onset
envelope, autocorrelation tempo, phase estimation — which has been in the tree
since the AI caster shipped and was reachable only by prompting. The beats were
computed, handed to a language model, and thrown away.
`core/audio/beatGrid.ts` is the missing half: the same analysis, in
**composition** time.

Verified against ground truth — a synthesized 120.00 BPM click track came back
as **119.68 BPM at 0.88 confidence**, and five layers animated in on frames
14 / 29 / 44 / 60 / 75, which are exactly the beat markers' frames.

**Audio time is not comp time.** The analyser returns seconds from the start of
the file; the layer may start ten seconds into the comp, be trimmed twenty
seconds into the file, and be stretched. Beats go through `keyframeToCompTime`,
the inverse of the chain every keyframe already uses, rather than an offset
computed locally.

**Confidence is reported, not enforced.** `core/ai/audioForCaster.ts` returns
*undefined* below 0.25 confidence, which is right for a language model — it
will time a whole piece to a bad grid and cannot tell. A person can, so the
grid comes back with its confidence attached and the command says it is a weak
guess instead of silently refusing.

**When the music runs out** before the layers do, the grid is extended at the
tempo it was keeping. Dropping the remaining layers would animate fewer things
than were selected, and piling them on the last beat would look like a bug.

## Not Stagger Animations

**Animation ▸ Stagger Animations** (`sequenceLayers`) offsets the keyframes a
layer *already has*, and refuses a selection with none. This is the other half:
layers with no animation get one. They compose — animate a selection here, then
re-stagger it there — and neither substitutes for the other.

## Layout

```
core/animation/
  motionCurves.ts          the named easing curves (moved out of core/ai/design.ts)
  entranceArchetypes.ts    pure: which entrance, what rhythm, what keyframes
  choreography.ts          impure: resting positions, frame grid, one undo step
  choreographyCommands.ts  the commands, the selection, the toast
core/audio/
  beatGrid.ts              the analysis, in composition time
  beatCommands.ts          markers on beats, and animating to them
```

The two features were built a day apart and compose without either knowing
about the other, because both speak in composition seconds: `beatCommands`
hands `animateLayers` a list of start times and the beat grid becomes the
rhythm.

### The virtual-root trap

`findAudioLayer` uses `defaultSceneGraph.traverse`, **not** `flattenScene`. On
a fresh unsaved project every layer hangs off the virtual `comp_root`, which is
a fallback id with no engine node behind it — so `getRoots()` is empty and a
roots-downwards walk returns nothing while the layers are plainly in the
timeline. Measured: a scene with an audio layer and five solids flattened to
`[]` and traversed to all six, which left every beat command disabled with the
music sitting right there. `core/ai/audioForCaster.ts` had the same bug, which
cost the AI caster its beat grid on exactly the projects most likely to be
generated into — brand new ones. Both are fixed and pinned by a test that
builds the virtual-root case.

`entranceArchetypes.ts` is pure — planes of numbers in, plans out — so the craft
is unit-tested with no scene graph, and `core/ai/archetypes.ts` re-exports it so
the recipe layer is untouched.
