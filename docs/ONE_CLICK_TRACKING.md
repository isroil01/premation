# One-click motion tracking

Point at something in the shot. Get keyframes.

Everything a tracker normally asks you to decide before it will run — which
feature, how big the feature box, how big the search box, which direction — is
measured from the footage instead. The controls that answer questions the
footage *cannot* answer (planar pin vs mesh warp, which layer receives the
track) are still there, one disclosure down in the Track Motion panel.

## Using it

1. Select a video layer, open **Track Motion** in the inspector.
2. Press **Pick target in viewport**. The card and the canvas both arm.
3. Click the thing you want followed. `Esc` cancels the pick.
4. It snaps to the nearest trackable detail and tracks the whole clip, both
   ways from the playhead.
5. **Create null & apply** makes a null carrying the motion — parent your
   layer to it. **… with rotation & scale** does the same using the companion
   feature. Or choose a layer and press **Apply**.

The path is drawn on the canvas as it stands: green dots are measured samples
(fading with match confidence), amber dots are frames the tracker *predicted*
through an occlusion, and the dashed ring around the chosen feature carries the
same good/fair/poor verdict the panel's pill shows.

## What gets measured, and why

| Decision | How it is answered | Where |
| --- | --- | --- |
| Which feature | Shi-Tomasi min-eigenvalue over a stride grid, refined by a Gaussian-weighted window, biased toward the click | `core/tracking/autoFeature.ts` |
| Is it unique | The patch correlated against its own neighbourhood at a distance | `autoFeature.distinctnessAt` |
| Feature box size | Smallest window on a `6…16` ladder that still resolves the feature | `autoFeature.suggestFeatureHalf` |
| Search box size | `2.5 ×` the feature's own displacement, corroborated over two frames | `core/tracking/autoTrack.ts` |
| Direction | Both, outward from the playhead | `autoTrack.runAutoTrack` |
| Rotation & scale | A companion feature picked nearby and tracked in the same walk | `autoTrack.pickCompanion` |

Six notes on why those are the answers:

**The minimum eigenvalue, not the sum.** A point on a straight edge scores well
on total gradient energy and is the worst thing you can track: its correlation
peak slides freely along the edge. Taking the *smaller* eigenvalue asks whether
the intensity surface curves in both directions, which is the formal version of
"this patch pins down x *and* y".

**Distinctness is a separate measurement.** A brick corner is a textbook strong
corner, and there are two hundred identical ones next to it. Strength cannot
see that; only correlating the patch against its own surroundings can. When a
feature comes back ambiguous the search window is *tightened* rather than
widened — the way to avoid locking onto the wrong brick is to keep the wrong
brick outside the window. The panel says "Ambiguous feature" when this happens,
because a track that hopped one brick over looks perfectly smooth.

**Smaller windows are better, not cheaper.** A 33×33 feature box on a rotating
or receding surface contains pixels whose relationship to the centre is
changing, which is drift the correlation cannot see. Choosing the smallest
window that works is a quality decision that happens to also cost ~7× less
arithmetic than the largest one.

**A default search radius is wrong in both directions at once.** Too small
loses a whipping pan on frame two; too large spends ~4× the arithmetic per
frame *and* invites a rival peak in from across the window. So it is sized from
what the feature actually did between the anchor frame and the next one.

**But one probe is not a measurement.** The probe is a correlation match, so it
is fooled by exactly what the track would be fooled by. Measured on real
footage — a static camera pointed at a slatted bench — a single probe reported
22 px/frame of motion that did not exist, because the patch matched the next
slat along; the window inflated to its 64 px clamp, and the track was lost at
frame 243 of 255. So the displacement is measured over one frame *and* over
two, and believed only if the two-frame answer is about twice the one-frame
answer. Real motion satisfies that by definition; a rival sits at a fixed
offset rather than a fixed velocity, and does not. On the same clip the track
now runs 255 of 255 frames with a 20 px window.

**Rotation and scale ride along.** A second feature is picked near the first
and tracked in the *same* walk, so it costs matching but not decoding — and
decoding is the expensive half. The angle and length of the line between the
two points is what carries rotation and scale, which is why the companion is
picked locally (a point across the frame is as likely to be on the background
as on the subject) and at a minimum separation (half a pixel of error on a
10 px baseline is 3° of phantom rotation). One click still applies position by
default; rotation and scale are the second button.

## Tracking backwards

The playhead is normally in the middle of a shot, and "track this" has never
meant "track the second half of this". But a video decoder is a forward
machine: asking it for frame N, then N−1, then N−2 seeks to the preceding
keyframe and re-decodes the GOP every time — `O(n · GOP)`, which on long-GOP
footage is minutes instead of seconds.

`core/tracking/reverseFrameWalk.ts` decodes forward in bounded chunks and
serves them backwards:

```
decode  ──►  [ lo ................ hi ]  ──►  cached
serve   ◄──  [ hi ................ lo ]  ◄──  from cache
```

Each frame is decoded once per walk, and the cache holds one chunk. The chunk
*length* comes from a byte budget rather than a frame count, because what is
being held is a full luma plane: 2 MB at 1080p, 8.3 MB at 4K. A fixed 64-frame
chunk is 128 MB of comfort on HD and 530 MB — an out-of-memory crash — on 4K.

Two things then decide how much preroll survives: the budget (a bigger chunk
amortizes it over more useful frames) and keyframe alignment (a chunk that
*starts* on a keyframe pays none at all, and snapping to one only ever shortens
the chunk, so the budget still holds).

Measured on 2160×3840 H.264, GOP 91, over a 129-frame backward walk — decode
only, no matching:

| | backward | forward | penalty |
| --- | --- | --- | --- |
| 128 MB budget, no alignment | 3073 ms | 779 ms | 3.94× |
| 256 MB budget + alignment | 1562 ms | 755 ms | **2.07×** |

Backward tracking is still the more expensive direction and always will be —
a decoder cannot run in reverse. Closing the remaining ~2× means a coarse-to-
fine two-pass (track a downsampled pyramid first, then refine at full
resolution against the now-known path), which is deliberately **not** done: it
needs either an offset-aware `LumaPlane` through `patchMatch`'s hot path or a
refinement pass that gives up the chained-template robustness `tracker.ts` is
built on. Neither is worth a further 2× on long-GOP 4K alone.

This also fixes backward tracking for the manual modes, which previously fell
back to per-frame random access.

## Escape while armed

Escape cancels the pick and nothing else. That needed the built-in **Deselect**
command (also on Escape) to report `enabled: false` while `autoPhase` is
`'picking'` — `ShortcutManager` listens on `window` in the capture phase and
was registered at boot, so a competing listener in the panel loses the race
whatever it does, and letting Deselect win unmounted the very section that
armed the pick. A disabled command falling through to other handlers is the
manager's documented mechanism for exactly this.

## When it says no

`pickFeature` returns null on a region with nothing trackable — sky, a white
wall, a defocused background — and the panel says so instead of tracking it.
That is deliberate: the alternative is returning the least-flat flat point,
which produces a smooth, confident, meaningless curve that looks exactly like a
successful track.

## Layout

```
autoFeature.ts       pure  which feature, how unique, what scale
autoTrack.ts         pure  the plan + the bidirectional walk (frame readers injected)
reverseFrameWalk.ts  pure  chunked descending frame access (decoding injected)
trackVideoLayer.ts         the decoder, the clip's time chain, the pixel grids
autoTrackCommand.ts        stores in, stores out — what the click and the button both call
```

The first three take planes and callbacks, so the judgement is unit-tested
without WebCodecs, a demuxer, or a file: `autoFeature.test.ts` runs the
detector against a corner, an edge, flat grey and a checkerboard;
`reverseFrameWalk.test.ts` counts decodes and live planes rather than only
checking that the right frames came back.

## Relationship to the manual tracker

One click is the `follow` mode with its setup measured instead of typed, so
the result lands in the same store, draws with the same overlay, and applies
through the same `applyTrack.ts` paths. Picking a target while the panel is in
a multi-point mode switches it to `follow` — one tracked feature cannot drive a
four-corner planar pin, and showing an Apply button that does nothing is worse
than moving the selector.

See [AE_COMPARISON.md](AE_COMPARISON.md) for the wider tracker family (planar,
mask, Warp Stabilizer-class smoothing, 3D camera solve), all of which remain
under **Advanced tracking**.
