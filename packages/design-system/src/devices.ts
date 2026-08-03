/**
 * Graphic devices — the layer between "a backdrop" and "the content".
 *
 * ## Why this file exists
 *
 * Measured across the whole template library, forty layouts emitted exactly six
 * kinds of tool call: `create_layer` (always `shape: 'rect'`, or text),
 * `update_layer`, `create_gradient`, `add_surface_treatment`, `set_shadow_stack`
 * and `create_media`. The engine offers star, polygon, line and ellipse
 * primitives, an AE repeater, trim paths, masks, twenty-eight effects and
 * arbitrary inline SVG, and the design system reached for none of them.
 *
 * That is not a stylistic gap, it is a ceiling. A composition assembled only
 * from axis-aligned rectangles and typeset text has one available reading, and
 * no amount of palette, tracking or timing craft moves it: the shapes are the
 * shapes. The design linter has always said so — `PRIMITIVE_ONLY` names it — but
 * it could only point at the absence of imagery, and imagery is expensive and
 * needs a model decision. A drawn device is free, deterministic, and available
 * on every single run.
 *
 * ## What a device is, and is not
 *
 * A device is an **ambient graphic**: a halftone field, a drawn arc, a hatch, a
 * ring of marks. It sits above the backdrop and behind the content, and it is
 * never load-bearing — no device carries text, and removing one must never break
 * a layout. That constraint is what lets the caster attach one to any
 * composition without knowing which templates ran.
 *
 * It is also why devices are *pack-scoped* rather than universal. A starburst
 * belongs in broadcast sports and is absurd in luxury film; concentric hairlines
 * are luxury film and are invisible in broadcast sports. Selection is by shape
 * vocabulary, so a pack added later is covered without editing this file.
 *
 * ## Product packs get nothing, deliberately
 *
 * A dashboard does not have a halftone field behind it, so `deviceFor` returns
 * nothing for a pack whose MOTION vocabulary is `product` — the same separation
 * `LookPack.forbidCategories` enforces for techniques.
 *
 * That gate is on `vocabulary`, not on `shapeVocabulary`, and the distinction is
 * easy to get wrong: the two are orthogonal. `saas_product` is a `soft` shape
 * vocabulary and so is `saas_explainer`; `mobile_app` is `pill` and so is
 * nothing else. Selecting on shape alone put a halftone field and a light pool
 * behind a dashboard. Shape vocabulary chooses WHICH device; motion vocabulary
 * decides WHETHER.
 *
 * Pure.
 */

import type { ResolvedPack } from './packs';
import type { ShapeVocabulary } from './shape';
import { snapBaseline, spanCenterX, type GridSpec } from './grid';
import { mulberry32, pick, type ToolCall } from './toolcall';

export interface DeviceContext {
  pack: ResolvedPack;
  grid: GridSpec;
  width: number;
  height: number;
  /** Prefix for the layer ids this device creates. */
  idPrefix: string;
}

/**
 * Put a device on the grid.
 *
 * Devices are ambient, so it is tempting to exempt them from `OFF_GRID` the way
 * backdrops and treatment layers are exempt. That would be the wrong call: the
 * exemptions that exist are for elements with no meaningful position (a
 * full-frame backdrop is centred because it fills the frame), and a device very
 * much has one. "Nearly aligned" is the amateur signal the rule exists to catch,
 * and a graphic sitting four pixels off a column is exactly that — the fact that
 * it is soft and low-contrast makes it less visible, not less wrong.
 *
 * Snapping costs nothing here. These are large, soft graphics; moving one to the
 * nearest column centre and baseline is imperceptible and it means the device
 * shares the frame's structure instead of floating over it.
 */
function place(g: GridSpec, xFraction: number, yFraction: number): { x: number; y: number } {
  const targetX = g.width * xFraction;
  let bestX = spanCenterX(g, [0, g.columns - 1]);
  let bestD = Math.abs(bestX - targetX);
  for (let from = 0; from < g.columns; from++) {
    for (let to = from; to < g.columns; to++) {
      const c = spanCenterX(g, [from, to]);
      const d = Math.abs(c - targetX);
      if (d < bestD) { bestD = d; bestX = c; }
    }
  }
  return { x: Math.round(bestX), y: snapBaseline(g, g.height * yFraction) };
}

export interface GraphicDevice {
  id: string;
  /** One line, for the record and for tests. */
  intent: string;
  /** Shape vocabularies this device suits. Product packs appear in none. */
  vocabularies: readonly ShapeVocabulary[];
  emit(ctx: DeviceContext, seed: number): ToolCall[];
}

/**
 * Opacity ceiling for anything a device draws.
 *
 * A device competing with the content is a device that has become the content.
 * Everything here is background texture — the test is whether you would notice
 * it was gone, not whether you notice it is there.
 */
const MAX_DEVICE_OPACITY = 22;

/** Scale a device to the frame, so it reads the same at 720p and 4K. */
const unit = (ctx: DeviceContext): number => Math.min(ctx.width, ctx.height) / 1080;

// ── The devices ───────────────────────────────────────────────────────

/**
 * A field of small marks on a diagonal — the print halftone.
 *
 * Two nested repeaters would be ideal; the engine's repeater is one-dimensional,
 * so this emits one row layer per band and repeats along it. Six bands is enough
 * to read as a field and few enough to stay cheap.
 */
const halftoneField: GraphicDevice = {
  id: 'device.halftone_field',
  intent: 'A drifting field of small dots, print-halftone density, cornered away from the type.',
  vocabularies: ['hard', 'soft', 'organic'],
  emit(ctx, seed) {
    const rng = mulberry32(seed);
    const u = unit(ctx);
    const calls: ToolCall[] = [];
    const dot = Math.round(pick(rng, [6, 8, 10]) * u);
    // A whole number of baselines, so every band lands on the grid without
    // needing to be snapped back and losing its even spacing.
    const gap = Math.max(1, Math.round((dot * pick(rng, [3, 4, 5])) / ctx.grid.baseline)) * ctx.grid.baseline;
    const bands = 6;
    const cols = Math.max(4, Math.round((ctx.width * 0.42) / gap));
    // Anchored to a corner, not centred. A field centred behind the type is a
    // texture the eye has to read through; one in a corner is a weight.
    const origin = place(ctx.grid, rng() > 0.5 ? 0.08 : 0.62, pick(rng, [0.12, 0.58, 0.66]));

    for (let b = 0; b < bands; b++) {
      const id = `${ctx.idPrefix}_halftone_${b}`;
      calls.push(
        { name: 'create_layer', args: { id, kind: 'shape', shape: 'ellipse', name: 'Halftone', x: origin.x, y: origin.y + b * gap, width: dot, height: dot } },
        { name: 'update_layer', args: { nodeId: id, fill: ctx.pack.palette.accent, opacity: Math.round(MAX_DEVICE_OPACITY * (1 - b / bands)) } },
        // Offset every other band by half a gap: a square lattice reads as a
        // screen artefact, a staggered one reads as a halftone.
        { name: 'add_repeater', args: { nodeId: id, copies: cols, positionX: gap + (b % 2 ? gap / 2 : 0), startOpacity: 100, endOpacity: 18 } },
      );
    }
    return calls;
  },
};

/**
 * A large drawn arc, trimmed so it is an open sweep rather than a closed ring.
 *
 * The trim is the point. A full ellipse outline is a circle; an arc from 12% to
 * 68% is a gesture, and it is the single cheapest way to put a curve in a frame
 * whose every other element is orthogonal.
 */
const drawnArc: GraphicDevice = {
  id: 'device.drawn_arc',
  intent: 'One oversized open arc, hairline weight, sweeping off the frame edge.',
  vocabularies: ['hard', 'soft', 'organic', 'pill'],
  emit(ctx, seed) {
    const rng = mulberry32(seed);
    const u = unit(ctx);
    const id = `${ctx.idPrefix}_arc`;
    // Bigger than the frame, so it reads as part of something larger rather than
    // as a circle someone put on the slide.
    const size = Math.round(Math.max(ctx.width, ctx.height) * pick(rng, [1.15, 1.4, 1.7]));
    const start = pick(rng, [4, 10, 16]);
    const end = start + pick(rng, [34, 48, 62]);
    const at = place(ctx.grid, pick(rng, [0.14, 0.82]), pick(rng, [0.2, 0.78]));
    return [
      { name: 'create_layer', args: { id, kind: 'shape', shape: 'ellipse', name: 'Arc', x: at.x, y: at.y, width: size, height: size } },
      // No fill: an unfilled ellipse plus a stroke effect is an outline. A filled
      // one at this size is a wash across the whole frame.
      { name: 'update_layer', args: { nodeId: id, fill: 'transparent', opacity: MAX_DEVICE_OPACITY, cornerRadius: 0 } },
      { name: 'add_effect', args: { nodeId: id, type: 'stroke', amount: Math.max(1, Math.round(u * pick(rng, [2, 3, 6]))) } },
      { name: 'set_trim_path', args: { nodeId: id, start, end, offset: Math.round(rng() * 360) } },
    ];
  },
};

/**
 * Concentric hairline rings, drawn with a scaling repeater.
 *
 * The restraint device. One ellipse outline plus a repeater that scales each
 * copy up and fades it is nine layers' worth of structure from one layer, and it
 * is the shape of a ripple, a topographic contour and a lens diagram at once.
 */
const contourRings: GraphicDevice = {
  id: 'device.contour_rings',
  intent: 'Concentric hairline rings expanding from a point, fading outward.',
  vocabularies: ['hard', 'organic', 'soft'],
  emit(ctx, seed) {
    const rng = mulberry32(seed);
    const u = unit(ctx);
    const id = `${ctx.idPrefix}_rings`;
    const base = Math.round(Math.min(ctx.width, ctx.height) * pick(rng, [0.16, 0.22]));
    const at = place(ctx.grid, pick(rng, [0.2, 0.78, 0.5]), pick(rng, [0.24, 0.72]));
    return [
      { name: 'create_layer', args: { id, kind: 'shape', shape: 'ellipse', name: 'Rings', x: at.x, y: at.y, width: base, height: base } },
      { name: 'update_layer', args: { nodeId: id, fill: 'transparent', opacity: MAX_DEVICE_OPACITY } },
      { name: 'add_effect', args: { nodeId: id, type: 'stroke', amount: Math.max(1, Math.round(u)) } },
      { name: 'add_repeater', args: { nodeId: id, copies: pick(rng, [5, 7, 9]), scaleX: 1.34, scaleY: 1.34, startOpacity: 100, endOpacity: 0 } },
    ];
  },
};

/**
 * A rotating fan of thin spokes — the broadcast/HUD burst.
 *
 * Loud on purpose, and confined to the vocabularies that want loud. The rotation
 * offset per copy is what makes one layer a radial burst.
 */
const radialFan: GraphicDevice = {
  id: 'device.radial_fan',
  intent: 'A fan of angular spokes radiating from a corner. Fast, loud, broadcast.',
  vocabularies: ['clipped', 'pill'],
  emit(ctx, seed) {
    const rng = mulberry32(seed);
    const u = unit(ctx);
    const id = `${ctx.idPrefix}_fan`;
    const spokes = pick(rng, [9, 12, 16]);
    const len = Math.round(Math.max(ctx.width, ctx.height) * 0.6);
    const at = place(ctx.grid, pick(rng, [0.06, 0.94]), pick(rng, [0.1, 0.9]));
    return [
      { name: 'create_layer', args: { id, kind: 'shape', shape: 'rect', name: 'Fan', x: at.x, y: at.y, width: len, height: Math.max(2, Math.round(u * 3)) } },
      { name: 'update_layer', args: { nodeId: id, fill: ctx.pack.palette.accent, opacity: MAX_DEVICE_OPACITY, cornerRadius: 0 } },
      { name: 'add_repeater', args: { nodeId: id, copies: spokes, rotation: Math.round(360 / spokes), startOpacity: 100, endOpacity: 10 } },
    ];
  },
};

/**
 * A diagonal hatch of thin rules.
 *
 * The Swiss device. Rules are already this vocabulary's structural element, so a
 * hatch is the same idea at texture scale — and a repeater on one rotated rule
 * costs a single layer.
 */
const diagonalHatch: GraphicDevice = {
  id: 'device.diagonal_hatch',
  intent: 'A band of thin diagonal rules, printed-overlay density.',
  vocabularies: ['hard', 'clipped'],
  emit(ctx, seed) {
    const rng = mulberry32(seed);
    const u = unit(ctx);
    const id = `${ctx.idPrefix}_hatch`;
    const gap = Math.round(pick(rng, [22, 30, 44]) * u);
    const count = Math.max(6, Math.round((ctx.width * 0.5) / gap));
    const at = place(ctx.grid, pick(rng, [0.18, 0.8]), pick(rng, [0.3, 0.7]));
    return [
      { name: 'create_layer', args: { id, kind: 'shape', shape: 'rect', name: 'Hatch', x: at.x, y: at.y, width: Math.max(2, Math.round(u * 2)), height: Math.round(ctx.height * 0.42) } },
      { name: 'update_layer', args: { nodeId: id, fill: ctx.pack.palette.line, opacity: MAX_DEVICE_OPACITY, rotation: pick(rng, [-38, -22, 22, 38]), cornerRadius: 0 } },
      { name: 'add_repeater', args: { nodeId: id, copies: count, positionX: gap, startOpacity: 100, endOpacity: 12 } },
    ];
  },
};

/**
 * A corner registration mark, written as inline SVG.
 *
 * The one device that is a real vector rather than a repeated primitive, and the
 * reason `import_svg` is worth reaching for: crop marks are three strokes and a
 * gap, which is one path and would be four layers built out of rectangles.
 */
const registrationMark: GraphicDevice = {
  id: 'device.registration_mark',
  intent: 'A small crop/registration mark in one corner. Print-shop provenance.',
  vocabularies: ['hard', 'clipped'],
  emit(ctx, seed) {
    const rng = mulberry32(seed);
    const u = unit(ctx);
    const size = Math.round(64 * u);
    const stroke = ctx.pack.palette.line;
    const corner = pick(rng, [
      { x: 0.07, y: 0.1 }, { x: 0.93, y: 0.1 }, { x: 0.07, y: 0.9 }, { x: 0.93, y: 0.9 },
    ]);
    const markup =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">` +
      `<g fill="none" stroke="${stroke}" stroke-width="2">` +
      `<path d="M32 4 V26 M32 38 V60 M4 32 H26 M38 32 H60"/>` +
      `<circle cx="32" cy="32" r="14"/>` +
      `</g></svg>`;
    return [
      { name: 'import_svg', args: { id: `${ctx.idPrefix}_regmark`, markup, name: 'Registration', x: place(ctx.grid, corner.x, corner.y).x, y: place(ctx.grid, corner.x, corner.y).y } },
      { name: 'update_layer', args: { nodeId: `${ctx.idPrefix}_regmark`, width: size, height: size, opacity: MAX_DEVICE_OPACITY + 8 } },
    ];
  },
};

/**
 * A soft pool of accent light.
 *
 * The only device that is a fill rather than a line, and the only one that suits
 * `organic`/`soft` at low energy without adding a single hard edge.
 */
const lightPool: GraphicDevice = {
  id: 'device.light_pool',
  intent: 'A wide soft pool of accent light, bloomed, low in the frame.',
  vocabularies: ['soft', 'organic', 'pill'],
  emit(ctx, seed) {
    const rng = mulberry32(seed);
    const id = `${ctx.idPrefix}_pool`;
    const w = Math.round(ctx.width * pick(rng, [0.5, 0.7, 0.9]));
    const at = place(ctx.grid, pick(rng, [0.3, 0.5, 0.7]), pick(rng, [0.18, 0.86]));
    return [
      { name: 'create_layer', args: { id, kind: 'shape', shape: 'ellipse', name: 'Light pool', x: at.x, y: at.y, width: w, height: Math.round(w * 0.42) } },
      { name: 'update_layer', args: { nodeId: id, fill: ctx.pack.palette.accent, opacity: Math.round(MAX_DEVICE_OPACITY * 0.7), blendMode: 'screen' } },
      { name: 'add_effect', args: { nodeId: id, type: 'blur', amount: Math.round(Math.min(ctx.width, ctx.height) * 0.09) } },
    ];
  },
};

/**
 * A starburst of radiating strokes — broadcast / sports energy without imagery.
 *
 * Built as one thin rect + a rotational repeater so it stays cheap and editable.
 */
const starburst: GraphicDevice = {
  id: 'device.starburst',
  intent: 'Radiating hairline rays from a corner or mid-frame anchor.',
  vocabularies: ['hard', 'soft'],
  emit(ctx, seed) {
    const rng = mulberry32(seed);
    const u = unit(ctx);
    const id = `${ctx.idPrefix}_starburst`;
    const len = Math.round(Math.min(ctx.width, ctx.height) * pick(rng, [0.28, 0.38, 0.48]));
    const copies = pick(rng, [10, 14, 18]);
    const at = place(ctx.grid, pick(rng, [0.12, 0.5, 0.88]), pick(rng, [0.14, 0.5, 0.86]));
    return [
      { name: 'create_layer', args: { id, kind: 'shape', shape: 'rect', name: 'Starburst', x: at.x, y: at.y, width: Math.max(2, Math.round(u * 1.5)), height: len } },
      { name: 'update_layer', args: { nodeId: id, fill: ctx.pack.palette.line, opacity: MAX_DEVICE_OPACITY, cornerRadius: 0, anchorY: -50 } },
      { name: 'add_repeater', args: { nodeId: id, copies, rotation: 360 / copies, startOpacity: 100, endOpacity: 100 } },
    ];
  },
};

/**
 * One decisive diagonal slash across the frame — editorial punctuation.
 */
const diagonalSlash: GraphicDevice = {
  id: 'device.diagonal_slash',
  intent: 'A single thick diagonal bar cutting the frame, low opacity.',
  vocabularies: ['hard', 'clipped', 'soft'],
  emit(ctx, seed) {
    const rng = mulberry32(seed);
    const u = unit(ctx);
    const id = `${ctx.idPrefix}_slash`;
    const thick = Math.round(pick(rng, [18, 28, 42]) * u);
    const at = place(ctx.grid, 0.5, 0.5);
    return [
      { name: 'create_layer', args: { id, kind: 'shape', shape: 'rect', name: 'Slash', x: at.x, y: at.y, width: Math.round(ctx.width * 1.4), height: thick } },
      { name: 'update_layer', args: { nodeId: id, fill: ctx.pack.palette.accent, opacity: Math.round(MAX_DEVICE_OPACITY * 0.85), rotation: pick(rng, [-28, -18, 18, 28]), cornerRadius: 0 } },
    ];
  },
};

export const GRAPHIC_DEVICES: readonly GraphicDevice[] = [
  halftoneField,
  drawnArc,
  contourRings,
  radialFan,
  diagonalHatch,
  registrationMark,
  lightPool,
  starburst,
  diagonalSlash,
];

/**
 * The device a composition gets, or `undefined` for none.
 *
 * Deterministic from the pack and the seed, so a re-emit during the repair pass
 * cannot swap the device out from under a linter finding.
 *
 * Returns `undefined` for a vocabulary no device declares — which is how the two
 * product packs get nothing without this having to name them.
 */
export function deviceFor(pack: ResolvedPack, seed: number): GraphicDevice | undefined {
  const eligible = devicesForPack(pack);
  if (!eligible.length) return undefined;
  return eligible[Math.abs(Math.trunc(seed)) % eligible.length];
}

/** Every device a pack could be given — for coverage tests. */
export function devicesForPack(pack: ResolvedPack): readonly GraphicDevice[] {
  // Motion vocabulary gates, shape vocabulary selects. See the file docstring:
  // these are orthogonal, and filtering on shape alone put a halftone field
  // behind a dashboard.
  if (pack.pack.vocabulary === 'product') return [];
  return GRAPHIC_DEVICES.filter((d) => d.vocabularies.includes(pack.pack.shapeVocabulary));
}
