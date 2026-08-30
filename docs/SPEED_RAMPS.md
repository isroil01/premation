# Speed ramps

Park the playhead, press **Ramp to 25%**, and the video (or audio, or pre-comp)
eases into quarter speed over half a second and stays there. **Ramp back to 100%** eases out
again. There is also 50%, 200%, and a ramp to a freeze.

Slowing turns on Pixel Motion frame blending, because 25% without it is the
same frames held four times each — which reads as broken rather than as slow
motion.

## Why speed cannot just be keyframed

Speed is a *rate*. What the renderer needs is which source frame to show at a
given composition time, which is the **integral** of speed. Keyframe a speed
value and sample it per frame and the curve's slope is wrong everywhere: ramp
100% → 50% and the footage does not decelerate, it jumps to a different frame
and then plays at some third rate.

This is why After Effects makes you shape a Time Remap graph instead of
offering a speed track, and why that graph is famously awkward. Here the ramp
is *specified* in the units a person thinks in — "100% here, 25% there" — and
integrated into the units the renderer needs.

## Two keyframes, not ninety

Integrating numerically and writing a keyframe per frame would work and would
be terrible: a three-second ramp becomes ninety keyframes and the graph editor
becomes unusable.

It is also unnecessary. Over a segment where speed moves linearly from `v₀` to
`v₁`, source time is a **quadratic** in composition time — and a cubic Bézier
represents any quadratic *exactly*. Fixing the handles' x at `1/3` and `2/3`
makes the Bézier's x-parameter equal normalized time, and the y handles fall
out of matching coefficients:

```
y(u) = a·u + b·u²        a = 2v₀/(v₀+v₁),  b = (v₁−v₀)/(v₀+v₁),  a + b = 1
y₁ = a/3                 y₂ = (b + 2a)/3
```

The cubic term vanishes identically because `a + b = 1`. Two keyframes and one
derived curve reproduce the integral with **zero** error, and the result is a
graph you can still grab and edit.

Sanity check: constant speed gives `[1/3, 1/3, 2/3, 2/3]` — a straight line,
which is what constant speed must be.

This is not asserted against a golden array. `speedRamp.test.ts` compares the
curve against a 200,000-step numerical integration of the same speed profile,
at every sampled point across a multi-segment ramp. If the algebra were wrong
that comparison is the only thing that would notice — the endpoints would still
be right.

## What it applies to

**Anything with a source to retime: video, audio, and pre-comps.**
`buildSnapshot` samples a node's own `timeRemap` when it computes that layer's
`sourceTime`, so a ramp retimes the frames a video layer shows exactly as it
retimes a precomp's contents.

A shape or solid is excluded, and not arbitrarily: `timeRemap` feeds
`sourceTime` only. It does **not** move the layer's own transform keyframes —
the same separation After Effects makes, where time-remapping footage retimes
the picture and not the animation you put on top of it. A shape has no source,
so nothing would read the value.

> **Corrected.** This shipped restricted to pre-comps, with the docs asserting
> that a footage layer "has no self-remap hook" and that extending it would be
> a render-path change. That was wrong. `precompSourceTime` and the precomp
> ancestor chain both look precomp-specific, and the general layer path a
> thousand lines further down samples `timeRemap` for every node. The
> restriction blocked the main use case — ramping a video clip — for one
> release. `speedRampRender.test.ts` now drives a real video layer and watches
> its `sourceTime` follow the curve.

`speedRampRender.test.ts` drives the real `buildSnapshot` and reads
`sourceTime`, so "the renderer actually slows down" is checked rather than
assumed. (An empty precomp is not emitted into the snapshot at all, so that
fixture needs a child in it or every ramp reads back as the identity and proves
nothing.)

## Behaviour worth knowing

- **Ramps compose.** The starting speed is read as the *slope* of the existing
  remap curve, so ramping to 25% and later back to 100% starts the second ramp
  from a quarter rather than snapping to full speed first.
- **It continues from the frame on screen.** Inserting a ramp mid-clip does not
  jump the footage back to the head of its source.
- **Keyframes before the playhead are left alone** (`spliceRecordedRange`), so
  earlier ramps survive later ones.
- **A direction change is split at its zero crossing.** A segment from +1 to −1
  covers no net source time, so one curve through it would be a flat line —
  hiding that the footage plays forward, stops, and rewinds.
- **Frame blending is only turned on if it was off.** Overriding a deliberate
  "Off" would be the command overruling a setting someone went and found.

## Layout

```
core/animation/
  speedRamp.ts              pure: the integral, the exact Bézier, sampling
  speedRampCommands.ts      the commands, the selection, the frame-blend switch
```
