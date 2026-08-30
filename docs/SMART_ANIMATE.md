# Smart Animate

Design two boards. Get the transition between them.

Put your "before" in one composition and your "after" in another, give the
elements the same names in both, and run **Smart Animate to "…"**. You get a
third composition — `Before → After` — where matching layers move, resize and
rotate into place, layers that only existed in the first fade out, and layers
that only existed in the second arrive.

After Effects has no equivalent. Figma's Smart Animate and Keynote's Magic Move
are the reference; this is the same idea for a timeline.

## How layers pair up

Naming is how designers already express identity, so that is what the matcher
reads. In priority order:

| Rule | What it catches |
| --- | --- |
| Same **name**, same place in the tree | The ordinary case |
| Same **name**, anywhere | The element moved between groups |
| Same **source** | Renamed footage or image |
| Same **text** | Renamed text layer, identical words |

**Kind must always agree.** A text layer never matches a video, however alike
the names.

There is deliberately **no geometric or visual similarity rule**. "Both roughly
square and roughly here" produces matches nobody asked for, and a wrong match
is far worse than none: an unmatched layer just fades, which reads as a
deliberate cut, while a wrong one flies across the screen and turns into
something else.

Each pass consumes what it matched, so a strong signal always beats a weak one
— a layer paired by name is never re-paired by text later.

## What gets written

Only what actually differs. A layer whose position is identical in both boards
gets **no position track at all**. That is not an optimisation: writing every
property for every layer would bury the three things that move under ninety
that do not, and the whole promise here is that the result is ordinary
keyframes you go and tune afterwards.

Differences below a per-property noise floor are ignored too — positions that
differ in the twelfth decimal are the same position, and a track for that is a
flat line cluttering the graph editor.

Tweened: `x`, `y`, `anchorX`, `anchorY`, `width`, `height`, `scale`, `scaleX`,
`scaleY`, `rotation`, `opacity`.

## Departures and arrivals do not cross-dissolve

A leaving layer holds at full opacity while everything else starts moving, then
fades over the first 40% of the transition. An arriving layer stays invisible
until 60% through, then fades up.

Those two numbers are one constant, and it has a **correctness bound**: above
0.5 the two fades overlap, which puts the old and new element on screen
together — a cross-dissolve, which is exactly the look Smart Animate exists to
replace. At 0.4 the outgoing layer is gone before the incoming one starts, and
the gap between them is covered by the matched layers still moving.

The hold matters as much as the fade. Fading a departure from the first frame
makes the board look like it was already dissolving; letting it sit while the
layout rearranges around it reads as an exit.

## It never edits either board

The transition is built in a **duplicate** of the first composition. Both
boards are things you designed and will keep designing — animating one in place
would mean the source of the transition no longer shows the state it
represents, with no way back except undo. A third composition also matches how
the result is used: A and B are boards, `A → B` is a shot.

Arriving layers are **cloned** into the transition — subtree, components and
keyframes — rather than referenced. A reference would tie the transition to
later edits of the target board, which is the opposite of what a baked
transition is for.

## When nothing matches

You get a cross-fade, and the toast says so explicitly: *"Nothing matched —
layers pair up by name, so give the elements the same names in both boards."*
A transition that silently dissolves looks like the feature is broken; naming
the cause makes it a two-second fix.

## Layout

```
core/animation/
  layerMatch.ts           pure: which layer is which
  smartAnimate.ts         pure: what to write, and what not to
  smartAnimateApply.ts    the graph, the duplicate, the clones
  smartAnimateCommands.ts one command per target composition
```

The first two are pure — descriptors and values in, plans out — so the
correspondence and the restraint are tested exhaustively without a scene graph.

There is one command per target composition rather than a dialog, so the
feature is reachable by typing a board's name into the palette. Boards get
created and renamed while the app runs and `buildStaticCommands` runs once at
boot, so the set is kept in step by a subscription
(`installSmartAnimateCommandSync`) rather than snapshotted — otherwise a board
made after startup would have no command to animate to it.

Two things about that list are easy to get wrong, and both were found by
running it rather than by a test:

- **The excluded placeholder is pristine AND layerless.** The default
  composition keeps `pristine: true` forever — nothing clears it when layers
  are added — so filtering on the flag alone hides the composition most people
  put their first board in. `pristineCompToAdopt` already states the correct
  rule: "a pristine comp the user has already drawn into is theirs by use".
- **The sync key is the active COMPOSITION, not the active tab.** A tab can be
  pointed at a different comp without its id changing, and the active comp is
  the one excluded from its own target list — so keying on the tab left the
  commands offering whichever board happened to be open when they were last
  built.
