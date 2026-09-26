/**
 * Structured property writes — the values a plugin may set that are not scalars.
 *
 * ── The ceiling this removes ────────────────────────────────────────────────
 *
 * `scene.setProperty` accepted `number | string | boolean` and nothing else. The
 * scene graph's own `writeProp` has always taken `unknown`, and native code
 * writes arrays through it routinely — so the restriction was never a storage
 * limit, it was the plugin gate refusing to validate anything harder than a
 * scalar.
 *
 * What that cost is a whole class of plugin rather than a convenience: a path
 * is a bezier array, a gradient is a stop list, a stroke is a record. A plugin
 * could create a shape layer and move it around, but could not give it a
 * SHAPE. Generators, path animators, gradient tools and stroke effects were all
 * blocked on the same missing thing.
 *
 * ── Why a whitelist, and not "objects are allowed now" ──────────────────────
 *
 * The obvious fix — drop the `typeof` check and pass the value through — is
 * wrong twice over.
 *
 * First, `writeProp` will happily store any JSON under any key. A plugin that
 * can write arbitrary objects to arbitrary props produces documents full of
 * keys that render nothing and animate nothing, and the failure surfaces later,
 * to a user, as a layer that does not draw. A refusal at the call site naming
 * the supported props is a bug the AUTHOR sees.
 *
 * Second, these values are untrusted text that crossed `postMessage`. A bezier
 * array with a `NaN` in it propagates into the rasterizer and the hit-tester as
 * a path with no bounds; a stop list ten million long is a memory attack that
 * costs the plugin one line. Every value here is therefore parsed rather than
 * cast: bounded in length, checked for finiteness, and rebuilt field by field
 * so nothing the author did not declare survives into the document.
 *
 * ── Ids are minted here, never accepted ─────────────────────────────────────
 *
 * Gradient stops carry an `id`. Plugins supply `{ offset, color }` and this
 * module calls `makeStop`, because an id that arrives from a worker is either
 * a collision with a host-generated one or a handle to something the plugin
 * should not be able to name. The same reasoning as `scene.createLayer`
 * checking kind ownership host-side: an identifier that crossed the boundary is
 * an argument, not an identity.
 *
 * ── Each prop routes through its OWN canonical setter ───────────────────────
 *
 * Not one shared `writeProp` call. `fillPaint` and `stroke` are stored through
 * `setNodeFill` / `setNodeStroke`, which maintain the fill/stroke STACK (a node
 * can have several), bump the scene revision and emit `AnimationChanged`. A raw
 * `writeProp` writes the same key and skips all three, so the inspector shows
 * the old value and the viewport does not repaint — the classic "it saved but
 * nothing happened" bug. Geometry has no such setter, so that one does write
 * through `writeProp`, and says so.
 *
 * ── Permissions are unchanged, deliberately ─────────────────────────────────
 *
 * A structured write is still "change a property of a layer", so it stays on
 * `scene:write` (or `scene:proxy` inside a plugin's own subtree) rather than
 * inventing a permission. A separate one would put a second line on the consent
 * screen for a distinction the user cannot act on — they already decided
 * whether this plugin may modify their layers.
 *
 * Discoverability is a CAPABILITY (`scene.structured`), which is the right
 * axis: a plugin needs to know whether the host can accept a path, and a
 * capability answers exactly that without a version bump. See `capabilities.ts`.
 */

import type { Command } from '@motion/engine-api';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { makeStop, type ColorStop, type FillPaint, type OpacityStop } from '@core/paint/fill';
import { defaultStroke, getNodeStroke, readNodeStrokes, type Stroke } from '@core/paint/stroke';
import { catalogFor, shapeClosed, shapePathValue } from '@core/engine/props';

/**
 * Bounds. Every one of these is a refusal, not a clamp.
 *
 * Clamping a 10-million-point path to 10 000 would hand the plugin a path that
 * is not the one it built and no way to find out — silently wrong geometry is
 * worse than a named error. These are set far above any hand-authored figure
 * and far below anything that threatens the host.
 */
export const MAX_PATH_POINTS = 10_000;
export const MAX_SUBPATHS = 256;
export const MAX_GRADIENT_STOPS = 64;
export const MAX_DASH_SEGMENTS = 32;

/** A bezier vertex as the geometry component stores it. */
interface BezierPoint {
  x: number; y: number;
  inX: number; inY: number;
  outX: number; outY: number;
}

/** Thrown internally by the parsers; `planStructuredWrite` turns it into a message. */
class Invalid extends Error {}

const bad = (msg: string): never => { throw new Invalid(msg); };

/** A finite number, or a refusal naming where it went wrong. */
function num(v: unknown, at: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    bad(`"${at}" must be a finite number.`);
  }
  return v as number;
}

function numIn(v: unknown, at: string, lo: number, hi: number): number {
  const n = num(v, at);
  if (n < lo || n > hi) bad(`"${at}" must be between ${lo} and ${hi}.`);
  return n;
}

/**
 * A hex colour.
 *
 * Matched rather than passed through because a colour reaches Canvas2D and the
 * GPU uniform packer by different routes, and a string neither of them
 * understands fails differently in each — one draws black, the other draws
 * nothing. The accepted forms are exactly what `ColorStop` documents.
 */
function color(v: unknown, at: string): string {
  if (typeof v !== 'string' || !/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v)) {
    bad(`"${at}" must be a hex colour (#rgb, #rrggbb or #rrggbbaa).`);
  }
  return v as string;
}

/** A plain object — and never one carrying a prototype-polluting key. */
function obj(v: unknown, at: string): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) bad(`"${at}" must be an object.`);
  const o = v as Record<string, unknown>;
  // A worker cannot send a real `__proto__` accessor through the structured
  // clone algorithm, but it CAN send a plain own key by that name, and this
  // object is spread into host records downstream. Refusing costs one check.
  for (const k of ['__proto__', 'constructor', 'prototype']) {
    if (Object.prototype.hasOwnProperty.call(o, k)) bad(`"${at}" may not carry a "${k}" key.`);
  }
  return o;
}

function arr(v: unknown, at: string, max: number): unknown[] {
  if (!Array.isArray(v)) bad(`"${at}" must be an array.`);
  const a = v as unknown[];
  if (a.length > max) bad(`"${at}" has ${a.length} entries; the limit is ${max}.`);
  return a;
}

// ── Geometry ────────────────────────────────────────────────────────────────

/**
 * One bezier vertex.
 *
 * Tangents default to 0 rather than being required: a polyline is the common
 * case and `{ x, y }` is what an author writes first. Making them optional here
 * is the difference between a five-line generator and a twenty-line one.
 */
function point(v: unknown, at: string): BezierPoint {
  const o = obj(v, at);
  return {
    x: num(o.x, `${at}.x`),
    y: num(o.y, `${at}.y`),
    inX: o.inX === undefined ? 0 : num(o.inX, `${at}.inX`),
    inY: o.inY === undefined ? 0 : num(o.inY, `${at}.inY`),
    outX: o.outX === undefined ? 0 : num(o.outX, `${at}.outX`),
    outY: o.outY === undefined ? 0 : num(o.outY, `${at}.outY`),
  };
}

function points(v: unknown, at: string): BezierPoint[] {
  return arr(v, at, MAX_PATH_POINTS).map((p, i) => point(p, `${at}[${i}]`));
}

function subpaths(v: unknown, at: string): Array<{ points: BezierPoint[]; open: boolean }> {
  return arr(v, at, MAX_SUBPATHS).map((s, i) => {
    const o = obj(s, `${at}[${i}]`);
    return {
      points: points(o.points, `${at}[${i}].points`),
      open: o.open === undefined ? false : Boolean(o.open),
    };
  });
}

// ── Paint ───────────────────────────────────────────────────────────────────

function colorStops(v: unknown, at: string): ColorStop[] {
  const list = arr(v, at, MAX_GRADIENT_STOPS);
  if (list.length < 2) bad(`"${at}" needs at least two stops.`);
  return list.map((s, i) => {
    const o = obj(s, `${at}[${i}]`);
    // `makeStop` mints the id and clamps the offset — see the header.
    return makeStop(numIn(o.offset, `${at}[${i}].offset`, 0, 1), color(o.color, `${at}[${i}].color`));
  });
}

function opacityStops(v: unknown, at: string): OpacityStop[] {
  return arr(v, at, MAX_GRADIENT_STOPS).map((s, i) => {
    const o = obj(s, `${at}[${i}]`);
    return {
      id: `pstop_${i}_${Math.round(numIn(o.offset, `${at}[${i}].offset`, 0, 1) * 1e6)}`,
      offset: numIn(o.offset, `${at}[${i}].offset`, 0, 1),
      opacity: numIn(o.opacity, `${at}[${i}].opacity`, 0, 1),
    };
  });
}

/**
 * Paint type spellings an author brings from CSS, mapped to ours.
 *
 * Only the NAME of the function is accepted as an alias — `{ type:
 * 'linear-gradient', stops }` — never a CSS gradient string. Parsing CSS here
 * would be a second, partial gradient grammar with its own idea of what an
 * angle keyword or a colour hint means; see `normaliseFillWrite` for the
 * refusal that says so.
 */
const PAINT_TYPE_ALIASES: Readonly<Record<string, string>> = {
  'linear-gradient': 'linear',
  'radial-gradient': 'radial',
};

function fillPaint(v: unknown, at: string): FillPaint {
  const o = obj(v, at);
  const type = typeof o.type === 'string' ? (PAINT_TYPE_ALIASES[o.type] ?? o.type) : o.type;
  if (type === 'solid') {
    return { type: 'solid', color: color(o.color, `${at}.color`) };
  }
  if (type === 'linear') {
    return {
      type: 'linear',
      angle: o.angle === undefined ? 90 : num(o.angle, `${at}.angle`),
      stops: colorStops(o.stops, `${at}.stops`),
      ...(o.opacityStops === undefined ? {} : { opacityStops: opacityStops(o.opacityStops, `${at}.opacityStops`) }),
    };
  }
  if (type === 'radial') {
    return {
      type: 'radial',
      cx: o.cx === undefined ? 0.5 : numIn(o.cx, `${at}.cx`, -10, 10),
      cy: o.cy === undefined ? 0.5 : numIn(o.cy, `${at}.cy`, -10, 10),
      radius: o.radius === undefined ? 0.5 : numIn(o.radius, `${at}.radius`, 0, 10),
      stops: colorStops(o.stops, `${at}.stops`),
      ...(o.opacityStops === undefined ? {} : { opacityStops: opacityStops(o.opacityStops, `${at}.opacityStops`) }),
    };
  }
  return bad(`"${at}.type" must be "solid", "linear" or "radial".`);
}

const STROKE_ALIGNS = ['inside', 'center', 'outside'] as const;
const STROKE_CAPS = ['butt', 'round', 'square'] as const;
const STROKE_JOINS = ['miter', 'round', 'bevel'] as const;

function oneOf<T extends string>(v: unknown, at: string, allowed: readonly T[], fallback: T): T {
  if (v === undefined) return fallback;
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    bad(`"${at}" must be one of: ${allowed.join(', ')}.`);
  }
  return v as T;
}

/**
 * A stroke, PATCHED onto what the layer already has.
 *
 * Merge rather than replace, because a stroke has ten fields and an author
 * setting the width should not have to restate the cap, the join and the dash
 * array to avoid resetting them. `updateNodeStroke` exists for exactly this and
 * is not reused only because it would apply before validation finished.
 */
function stroke(v: unknown, at: string, nodeId: string): Stroke {
  const o = obj(v, at);
  const base = getNodeStroke(nodeId) ?? defaultStroke();
  return {
    ...base,
    enabled: o.enabled === undefined ? true : Boolean(o.enabled),
    color: o.color === undefined ? base.color : color(o.color, `${at}.color`),
    width: o.width === undefined ? base.width : numIn(o.width, `${at}.width`, 0, 10_000),
    opacity: o.opacity === undefined ? base.opacity : numIn(o.opacity, `${at}.opacity`, 0, 1),
    align: oneOf(o.align, `${at}.align`, STROKE_ALIGNS, base.align),
    cap: oneOf(o.cap, `${at}.cap`, STROKE_CAPS, base.cap),
    join: oneOf(o.join, `${at}.join`, STROKE_JOINS, base.join),
    dash: o.dash === undefined
      ? base.dash
      : arr(o.dash, `${at}.dash`, MAX_DASH_SEGMENTS).map((d, i) => numIn(d, `${at}.dash[${i}]`, 0, 100_000)),
    ...(o.dashOffset === undefined ? {} : { dashOffset: num(o.dashOffset, `${at}.dashOffset`) }),
    ...(o.paint === undefined ? {} : { paint: fillPaint(o.paint, `${at}.paint`) }),
  };
}

// ── The registry ────────────────────────────────────────────────────────────

/**
 * A layer's outline as engine commands (B5). A layer that HAS an outline
 * (a Geometry: `layer/path.points` is in its catalog) gets its Path's static
 * value — the Closed switch kept; one that has none gets one through
 * `setShapeOutline` (the engine gives a layer without Geometry one), which is
 * what makes a generator able to make a layer and then give it an outline —
 * the ceiling this module exists to remove.
 */
function outlineCommands(nodeId: string, runs: ReadonlyArray<{ points: BezierPoint[]; closed: boolean }>, single: boolean): Command[] {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) bad(`Layer "${nodeId}" no longer exists.`);
  let hasPath = false;
  try {
    hasPath = catalogFor(nodeId).byPath.has('layer/path.points');
  } catch {
    hasPath = false;
  }
  if (single && hasPath) {
    const run = runs[0]!;
    return [{ type: 'setProperty', prop: { layer: nodeId, path: 'layer/path.points' }, value: { kind: 'path', value: shapePathValue(run.points, shapeClosed(node!)) } } as Command];
  }
  return [{ type: 'setShapeOutline', layer: nodeId, runs: runs.map((r) => shapePathValue(r.points, r.closed)) } as Command];
}

/**
 * Every structured prop, and how to write it.
 *
 * `parse` runs FIRST and completely — including the bounds — and only then are
 * the engine commands built (`commands`). Splitting them is what lets
 * `scene.apply` keep its validate-all-then-apply-all promise for structured ops
 * too: a batch that would fail on op 40 must not have written op 39.
 */
interface StructuredProp {
  parse: (value: unknown, nodeId: string) => unknown;
  commands: (nodeId: string, parsed: unknown) => Command[];
}

const STRUCTURED: Readonly<Record<string, StructuredProp>> = Object.freeze({
  /** A single-subpath outline — the shorthand every simple generator wants. */
  points: {
    parse: (v) => points(v, 'points'),
    commands: (id, parsed) => outlineCommands(id, [{ points: parsed as BezierPoint[], closed: true }], true),
  },
  /** Several outlines on one layer: a donut, a letter with a counter. */
  subpaths: {
    parse: (v) => subpaths(v, 'subpaths'),
    commands: (id, parsed) => outlineCommands(id, (parsed as Array<{ points: BezierPoint[]; open: boolean }>).map((r) => ({ points: r.points, closed: !r.open })), false),
  },
  /** Solid or gradient fill: the layer's PRIMARY fill paint (`layer/fillPaint` — the fill stack's first entry). */
  fillPaint: {
    parse: (v) => fillPaint(v, 'fillPaint'),
    commands: (id, parsed) => [{ type: 'setProperty', prop: { layer: id, path: 'layer/fillPaint' }, value: { kind: 'json', value: JSON.stringify(parsed) } } as Command],
  },
  /** Outline paint. Patched onto the layer's existing stroke (`layer/strokes`: the stack with stroke 1 replaced). */
  stroke: {
    parse: (v, nodeId) => stroke(v, 'stroke', nodeId),
    commands: (id, parsed) => {
      const n = defaultSceneGraph.getNode(id);
      const rest = n ? readNodeStrokes(n).slice(1) : [];
      return [{ type: 'setProperty', prop: { layer: id, path: 'layer/strokes' }, value: { kind: 'json', value: JSON.stringify([parsed, ...rest]) } } as Command];
    },
  },
});

/** The props that accept a structured value, for error messages and docs. */
export const STRUCTURED_PROP_NAMES: readonly string[] = Object.freeze(Object.keys(STRUCTURED));

/**
 * `fill` is the name authors reach for; `fillPaint` is the one that takes paint.
 *
 * A plugin setting `fill` to a gradient object used to be refused ("does not
 * take a structured value"), and setting it to a hex string wrote the string
 * over the layer's fill RECORD with a raw `writeProp` — skipping the fill stack
 * and the repaint, which is the "it saved but nothing happened" bug the header
 * describes. So `fill` is routed: an object goes to `fillPaint` as-is, and a
 * hex colour becomes a solid `fillPaint`.
 *
 * The hex route is skipped when the layer stores `fill` as a plain STRING (a
 * text layer's colour), because there the raw write is the correct one and
 * always worked.
 *
 * A CSS gradient STRING is refused with the object form spelled out rather than
 * parsed. Returns null when the write is not a fill write at all.
 */
export function normaliseFillWrite(
  prop: string,
  value: unknown,
  layerStoresFillAsString: boolean,
): { ok: true; prop: string; value: unknown } | { ok: false; message: string } | null {
  if (prop !== 'fill' && prop !== 'fillPaint') return null;
  if (typeof value === 'string' && /gradient\s*\(/i.test(value)) {
    return {
      ok: false,
      message:
        `"${prop}" was given a CSS gradient string, which is not parsed. Pass a gradient object instead: `
        + "{ type: 'linear', angle: 45, stops: [{ offset: 0, color: '#ff0055' }, { offset: 1, color: '#0055ff' }] } "
        + "or { type: 'radial', cx: 0.5, cy: 0.5, radius: 0.5, stops: [...] }. "
        + "'linear-gradient' and 'radial-gradient' are accepted as the type name.",
    };
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return { ok: true, prop: 'fillPaint', value };
  }
  if (prop === 'fill' && typeof value === 'string' && !layerStoresFillAsString
    && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)) {
    return { ok: true, prop: 'fillPaint', value: { type: 'solid', color: value } };
  }
  if (prop === 'fillPaint') {
    return {
      ok: false,
      message:
        "\"fillPaint\" takes an object: { type: 'solid', color: '#rrggbb' }, or a 'linear' / 'radial' gradient with stops.",
    };
  }
  return null;
}

/** Does this prop name take a structured value? */
export function isStructuredProp(prop: string): boolean {
  return Object.prototype.hasOwnProperty.call(STRUCTURED, prop);
}

export type StructuredPlan =
  | { ok: true; commands: () => Command[] }
  | { ok: false; message: string };

/**
 * Validate a structured write and return its engine commands' builder,
 * WITHOUT touching the document.
 *
 * The two-phase shape is the point: callers that batch (`scene.apply`) plan
 * every op before applying any, and a caller that only ever does one still
 * gets its validation error before anything changed.
 */
export function planStructuredWrite(prop: string, value: unknown, nodeId: string): StructuredPlan {
  const entry = STRUCTURED[prop];
  if (!entry) {
    return {
      ok: false,
      message:
        `"${prop}" does not take a structured value. `
        + `Props that do: ${STRUCTURED_PROP_NAMES.join(', ')}. `
        + `Everything else takes a number, string or boolean.`,
    };
  }
  try {
    const parsed = entry.parse(value, nodeId);
    return { ok: true, commands: () => entry.commands(nodeId, parsed) };
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, message: e.message };
    throw e;
  }
}
