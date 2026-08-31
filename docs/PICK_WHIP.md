# The pick-whip

Drag a line from one thing onto another to link them. Two places have one:

| Where | Drag it onto | What happens |
|---|---|---|
| Timeline ▸ **Parent & Link** column | any layer | that layer becomes the parent |
| Inspector ▸ **Parent** row | any layer | the same |
| Expression editor ▸ header | a layer, or one property row | inserts a reference to it at the caret |

Both surfaces already had a dropdown, and the dropdown stays: it is the right
control when the layer you want is scrolled out of sight. The whip is the one
people reach for first, and its absence is the thing that reads as "this is not
really After Effects" more than any missing effect does.

---

## Parenting

Drag the spiral onto a layer in the **scene tree** or the **timeline**. The line
turns solid and accented over a layer it will accept, and stays dashed over one
it will not — a layer cannot parent to itself or to its own descendant, because
that is a cycle, and the whip asks `eligibleParents` the same question the
dropdown's list answers.

Parenting never moves the layer on screen. Both controls go through
`reparentNode`, so it cannot mean two different things depending on which one
you used.

### Alt: the "jump" variant

Hold **Alt** (Option) while dropping the whip — or while choosing from the
parent dropdown — to link the layer *without* compensating its transform. Its
values stay exactly as typed, so it jumps into the parent's coordinate space
instead of staying put. After Effects has the same modifier.

Use it when the child's numbers are already authored relative to the parent —
building a rig from measured offsets, or re-attaching something you positioned
in parent space — where the default compensation is something you would undo by
hand a second later. On an animated layer the difference is visible in the
keyframes: the default offsets every one of them to hold the pose, Alt leaves
them untouched.

All four surfaces (the inspector's picker, the compositing panel's, the
timeline's Parent & Link column, and the whip on each) turn the modifier into an
option through the one `parentOptionsFor` helper, so it cannot come to mean
different things in different places.

## Expressions

Typing `layer('Hero', 'y')` requires knowing the function, the layer's exact
name, and the property's internal key. Dragging requires knowing which layer you
meant.

- Dropped on a **property row**, it references that property.
- Dropped on a **layer**, it references *the same property this expression is
  on* — "follow that layer's Y", which is what the gesture means when you drag
  from Y, and what After Effects produces for it.

The reference is inserted at the caret and the caret lands after it, so you can
keep typing. A layer name containing a quote is escaped rather than emitted as
broken syntax. The whip refuses its own property: an expression that reads
itself is a cycle the evaluator would refuse anyway, and refusing at the gesture
is a better place to say so.

## How a surface becomes a drop target

Targets are **attributes**, not a registry:

```html
data-whip-layer="<nodeId>"    <!-- this element is a layer -->
data-whip-prop="<prop>"       <!-- …and this property of it -->
data-whip-scope="layer"       <!-- inside here, data-id is a layer id -->
```

The obvious alternative — a store every droppable row registers its bounds with
— is the wrong one here. Rows are virtualised in both the scene tree and the
timeline, they move on every scroll, and a registry of live rectangles would
need invalidating by scroll, resize, panel drag, zoom and layout change: five
subscriptions to maintain a copy of something the browser already knows exactly.
So hit-testing is `elementFromPoint`, and adding a target is one attribute.

The `scope` form exists for the scene tree, whose rows already carry `data-id`
from the shared `TreeView`. Marking the container is one line; teaching
`TreeView` to emit whip attributes would be a new API on a component six panels
use with four different kinds of id.

## Implementation notes

- **Pointer events, not HTML drag-and-drop.** Native DnD cannot draw a line,
  puts its own drag image in the way, and gives no pointer position during a
  drag on Firefox.
- **Pointer capture** is what makes the drag survive leaving the button.
  Without it the events go to whatever is under the cursor and the line stops
  following after ten pixels.
- **The line is a portal on `document.body`.** The whip lives inside panels that
  clip and scroll, and a line drawn in place would be cut off at the first panel
  edge it crossed — which is every drag that matters.

| File | What it owns |
|---|---|
| [`whipTarget.ts`](../src/core/whip/whipTarget.ts) | Resolving a target from a point, and the expression text. Pure. |
| [`PickWhip.tsx`](../src/components/PickWhip/PickWhip.tsx) | The spiral, the rubber band, the drag. |
