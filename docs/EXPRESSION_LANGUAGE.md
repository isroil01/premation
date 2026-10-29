# The expression language — what it accepts (2026-10-20, extended 2026-10-21)

`native/libs/motion_expr` is the engine's property-expression language: the
JavaScript expression subset ported from the TypeScript engine, plus — since
2026-10-20 — the statement forms After Effects rigs are written in. This note
lists what parses and runs today and what still does not, so a pasted AE
expression can be judged at a glance. The parity gate (`native/tests/
golden_expr.inc`) still holds every single-expression source to the TypeScript
engine's bits; the rows that changed are marked `HAND-EDITED` at its top.

## Programs

- **A program is a statement list.** Statements are separated by `;` or by a
  line break (JavaScript's automatic semicolons: `a = 1\nb = 2`; an operator at
  the start of the next line continues the expression). `//` and `/* … */`
  comments are skipped.
- **The value is the last expression statement's** (AE semantics, the
  JavaScript completion value): `var a = 2; a * 3` is 6, and
  `if (time < 1) { 10 } else { 20 }` is 10 or 20. Declarations have no value;
  an `if` whose branch is empty or not taken completes `undefined`, which is
  the usual "Expression must return a number" error. A top-level `return x`
  ends the program with `x`.
- **A single expression is unchanged**: it parses to exactly the nodes it
  always did, evaluates on the same path, and gives the same numbers and the
  same error text. Only a source with two or more statements, a declaration,
  a function or a block takes the new path.

## Declarations and assignment

- `var`, `let`, `const` (with `,` lists). `var` is function-scoped and
  hoisted; `let`/`const` are block-scoped. Assigning to a `const` is
  "Assignment to constant variable." A `const` needs an initializer.
- `=`, `+=`, `-=`, `*=`, `/=`, `%=`, prefix and postfix `++` / `--`. Targets
  are names and members (`a[i] = v`, `a.length = 0`; a known property of a
  plain object).
- **Undeclared names may be assigned** (`amp = 10; wiggle(2, amp)`): sloppy-mode
  JavaScript, as AE runs it; they become variables of the program. The
  language's own names cannot be (`value = 3` is a syntax error that says to
  declare your own variable).
- Names are resolved at parse time to frame slots: a lookup costs nothing at
  run time, and a name nothing declares is still "Unknown name" as before.

## Control flow

- `if (…) … else if (…) … else …`, braces optional.
- `while (…)` and `for (init; test; update)` (`for (var i = 0; …)` and
  `for (let …)`), with `break` and `continue`. **Loops are bounded**: more than
  50 000 iterations of one loop is a stated error, and the evaluation's step
  budget (200 000 AST nodes, shared with cross-layer reads) still applies, so a
  rig can never hang a frame. Evaluation stays deterministic.
- The ternary `? :`, `&&`, `||` and `!` as before; `typeof` (of an unknown
  name: `"undefined"`, no error); `**` (right-associative).

## Functions

- `function name(a, b) { … }` declarations hoist within their block (a helper
  may be used above its definition; helpers may call each other in any order).
- Function expressions (`var f = function (x) { … }`), arrows (`x => x * 2`,
  `(a, b) => { return a + b }`), IIFEs. Closures capture the enclosing
  variables by reference (a counter built in a factory keeps counting).
- Recursion is bounded by the evaluation depth (512 levels: "This expression
  is nested too deeply"). A function without `return` gives `undefined`;
  missing arguments read `undefined`. `f.name` and `f.length` work.
- The array callbacks (`map`, `filter`, `reduce`, `sort`, `forEach`, …) take
  these functions.

## Vector arithmetic

AE's operators on arrays: `[1, 2] + [3, 4]`, `position - [10, 0]`,
`scale * 2`, `2 * [1, 2]`, `[4, 6] / 2`, `[1, 2] + 1`. Element-wise; a shorter
vector reads 0 past its end. Arrays with strings stay JavaScript's
(`[1, 2] + ""` is still `"1,2"`), and the `add` / `sub` / `mul` / `div`
functions keep their previous semantics.

## Layer bindings

On `thisLayer`, on `thisComp.layer("Name")` / `layer("Name")`, and — as AE
allows — by their bare names (which read `thisLayer`'s):

- `transform.position`, `transform.anchorPoint`, `transform.scale` (percent),
  `transform.rotation`, `transform.xRotation` / `yRotation` / `zRotation`,
  `transform.orientation`, `transform.opacity` (0–100), `transform.pointOfInterest`;
  the same members directly on the layer object. Vectors are three
  components (`[x, y, z]`). Unset members read AE's defaults (opacity 100,
  scale 100 %), not 0.
- `inPoint`, `outPoint` (and `startTime`), `index` (1 = top of the stack, in
  the API's layer order: a parented layer sits under its parent), `parent`
  (a layer object, or `null`), `hasParent`, `enabled` / `active`.
- `thisComp.layer(3)`: a layer by its stack index.
- `effect("Name")("Param")`, `effect("Name").param("Param")`,
  `effect("Name")(1)` (parameters by 1-based index), `effect("Name").name`.
  "Name" is an expression control's name (`effect("Speed")("Slider")`, also
  `("Point")`, `("Color")` …), or an effect instance's own name, its
  definition's label, or its match name — all case-insensitively. A scalar
  parameter reads a number, a point `[x, y]`, a colour `[r, g, b, a]` in 0..1
  (an expression control's 0–255 channels are converted). A keyed or
  expressed parameter evaluates through the engine's sampler, with the usual
  cycle and depth guards. A missing effect or parameter is a stated error.

The engine side is `DocExprEnv` (`native/engine/src/core/docexpr.cpp`): facts
from the layer's bar in its composition's timeline, the stack order, the API
parent; parameters from the layer's controls (`ctrl_<name>` numbers) and its
`fx.effects` instances (`effect.<id>.<key>` numbers and `_r/_g/_b/_a`
channels).

## Added 2026-10-21

**Language.** Object literals (`{ a: 1, "b c": [2], 3: x, short }`, any key,
 member read and write: `o.foo = 1`), template literals (`` `x = ${value}` ``,
 nested), `switch` / `case` / `default` (strict equality, fall-through,
 `break`; `continue` reaches the enclosing loop), `do … while`, `for (x of
 array | string)` and `for (k in array | object)` (bounded like every loop),
 `try` / `catch (e)` / `catch` / `finally` and `throw` (a caught runtime error
 is `{ message, name }`; `e.message` is JavaScript's own text, e.g. `foo is not
 defined`; a thrown value is caught as itself; budget errors — the step, depth
 and loop limits — are never catchable, nor is a cross-layer cycle), `??`,
 `?.` (member, `?.[…]`, `?.(…)`; a nullish link ends the whole chain with
 `undefined`), default parameters (`function f(a, b = a * 2)`, arrows too;
 `f.length` stops at the first default), and the bitwise operators `& | ^ ~ <<
 >> >>>` (ToInt32 semantics). Note: `undefined` is still the language's `null`
 (the TypeScript's), so test with `== null`.

**AE globals.** `degreesToRadians`, `radiansToDegrees`, `hslToRgb`,
 `rgbToHsl` (`[h, s, l, a]` / `[r, g, b, a]` in 0..1), `smooth(width = .2,
 samples = 5, t = time)` (the mean of `samples` values over
 `[t - width/2, t + width/2]`; also `thisProperty.smooth`, and on any property
 object), `temporalWiggle(freq, amp, octaves, amp_mult, t)` (the property at a
 time wiggled by up to `amp` seconds), `timeToTimecode(t = time, base = 30)`
 (`H:MM:SS:FF`), `timeToCurrentFormat(t = time)` (the comp's rate),
 `comp("Name")` (`.layer("L")` / `.layer(i)`, `width`, `height`, `duration`,
 `frameDuration`, `numLayers`, `name`), `thisComp.name`, and a layer object's
 own `.name` (`thisComp.layer(2).name`, `parent.name`). `thisProperty` also has
 `numKeys`, `key(n)`, `nearestKey(t)`, `wiggle`, `smooth`, `temporalWiggle`.

**Property objects.** A layer's transform members (`position`, `anchorPoint`,
 `scale`, `orientation`, `pointOfInterest`, `rotation`, `x/y/zRotation`,
 `opacity`, the camera / light options) — on `thisLayer`, other layers,
 `parent`, `comp(…).layer(…)` — and every `effect("X")("Param")` are AE
 Property objects: used as a value they are the value (vectors are arrays,
 scalars behave as numbers in arithmetic, comparisons, `if`, `===`, string
 concatenation and the Number methods), and they answer `.value`,
 `.valueAtTime(t)`, `.velocity`, `.velocityAtTime(t)`, `.speed`, `.numKeys`,
 `.key(n)` (`{index, time, value}`), `.nearestKey(t)` and `.smooth(…)`.
 `effect("X").active` / `.enabled` read the effect's switch (an expression
 control is always on). `typeof` of a scalar property is `"object"`, as in AE.

**Units.** An expression sees AE units: on Scale, `value`, `valueAtTime` and
 keyframe values are percent (the document's multiplier ×100) and the result
 is read back in percent — so `thisComp.layer("A").transform.scale` on another
 layer's Scale copies it exactly. Opacity is 0–100, rotations degrees,
 position comp pixels (they were already). (Before 2026-10-21 an expression on
 Scale saw the multiplier: a `wiggle` amplitude written then in multiplier
 units is now in percent.)

**Errors.** Every syntax and runtime error carries the 1-based line and
 column of the token / node that failed (`Result::line` / `column`,
 `Expression::compile_error_line()`; the API's `ExpressionDiagnostic.line` /
 `column`). The message text is unchanged. During a frame build, a property
 whose enabled expression fails keeps its pre-expression value and the frame
 reports a layer error `{layer, stage: "expression", message: "Line N: <message>",
 path: <API property path>}` — one per property (a vector's members are one),
 in evaluation order; an export lists it as a warning and completes.
 `PropertyInfo.expressionError` is still the compile error only.

## Added 2026-10-29

**Paths.** A Mask Path or a shape's Path takes an expression that returns a
 path: `value`, `createPath(points, inTangents, outTangents, isClosed)`,
 `mask("Mask 1").maskPath` (also another layer's, through
 `thisComp.layer("A").mask(…)`), `content("…").path`. A path answers
 `points(t)`, `inTangents(t)`, `outTangents(t)`, `isClosed()`, and
 `pointOnPath(p)` / `tangentOnPath(p)` / `normalOnPath(p)` by arc length.

**sampleImage.** `layer.sampleImage(point, radius = [0.5, 0.5], postEffect =
 true, t = time)` (bare `sampleImage(…)` is this layer's) returns `[r, g, b,
 a]` 0–1 in the working space: the pixels over `point ± radius` in the layer's
 own space (its source size; text and shapes the comp's), each weighted by how
 much of it the rectangle covers, outside the layer transparent. Colour is
 alpha-weighted (a half-covered red edge reads red), alpha the covered mean; a
 zero radius reads the one pixel under the point. `postEffect` false reads the
 untouched source (no masks, effects or paint). The layer is drawn alone —
 the Layer panel's frame — on the GPU and read back, once per layer, time and
 mode in a frame; a layer larger than 2048 px is drawn smaller and sampled
 through that scale. A layer whose drawing samples itself is an error (a
 cycle). In an export the render loop draws it between frames; in a renderer
 that has no GPU (`premation-engine-headless`) the expression fails and keeps
 its pre-expression value.

## Still not supported

- Destructuring, regular expressions, `new`, classes, getters, `this` inside
  functions, `arguments`, spread, hexadecimal / binary number literals,
  compound bitwise assignment (`|=`…), labelled statements.
- Per-iteration `let` bindings for closures made inside a loop (they share
  one slot per declaration); function declarations inside `case` clauses are
  not hoisted.
- `content("…")` shape groups with their own transforms (one Path is read
  whatever the names), `sourceRectAtTime` on other
  layers' objects, `thisLayer.source`, `thisComp.layer("Name")` lookups by
  partial name, `parent` chains through a precomp, `.wiggle()` / `.loopOut()`
  on another layer's property object, `.key(n)` on a property with no keys (an
  error), the property object's `.name`.
- Any name AE provides that is not listed in `native/libs/motion_expr/keys.cpp`
  (the globals) or `keys.def` (the members).

## Tests

- `native/tests/test_expr_lang.cpp` — parser, interpreter and the bindings
  through a fake host; the five AE rigs (a bounce with `var`/`if`, `loopOut`
  through a helper function, a text counter on a Slider Control, a
  parent-relative offset, an in-point fade).
- `native/engine/tests/test_expression_lang.cpp` — the same bindings over a
  real document through the session API.
- `native/tests/test_expr.cpp` — the parity gate, unchanged except the rows
  listed at the top of `golden_expr.inc`.
