/**
 * Property trees, values and keyframes.
 *
 * Everything a layer *is* — its transform, its masks, its effects, its text —
 * hangs off one recursive structure in the file, and this module decodes it.
 *
 * ## The shape of a property group
 *
 * A group is a `LIST` of type `tdgp` whose children alternate: a `tdmn` chunk
 * naming the next member, then the member itself. It ends at a `tdmn` reading
 * `ADBE Group End`.
 *
 *     LIST tdgp
 *       tdsb                         group flags
 *       tdsn → Utf8                  display name (or AE's "unnamed" sentinel)
 *       tdmn "ADBE Transform Group"
 *       LIST tdgp                      … a nested group
 *       tdmn "ADBE Opacity"
 *       LIST tdbs                      … a leaf property
 *       tdmn "ADBE Group End"
 *
 * A member is not always a `tdgp`/`tdbs`. Effects arrive as `sspc`, mask
 * outlines as `om-s`, 3-D orientation as `otst`, text as `btds`, and a member
 * can have a metadata chunk wedged between its name and its value (a mask's
 * `mkif`). So the walk pairs a name with *the next LIST*, collecting anything
 * in between, rather than with "the next chunk".
 *
 * ## Values
 *
 * A static property's value is a `cdat` chunk: N big-endian doubles, one per
 * dimension. An animated one instead carries `LIST list` → `lhd3` (how many
 * keyframes, how big each is) + `ldat` (the keyframes themselves). Both can be
 * present; AE keeps the last static value around, and it is the right fallback
 * when a keyframe list turns out to be unreadable.
 *
 * ## The keyframe layout is decided by SIZE, not by a type tag
 *
 * `lhd3` says the item type is `4` for every keyframe kind there is. What
 * distinguishes a 2-D position from a 2-D scale is the item size — 104 bytes
 * against 88 — because a spatial property carries tangents the other does not.
 * And 3-D position and 3-D scale are BOTH 128 bytes, so that pair is separated
 * by the `is_spatial` flag on the property's own `tdb4`. Getting this wrong
 * does not throw; it silently reads a tangent as a value, which is why the
 * table below is written out explicitly rather than computed.
 */

import {
  chunkText,
  findChunk,
  findList,
  readerFor,
  type AepChunk,
  type Reader,
} from './riff';
import { readTextDocument } from './aepText';
import type {
  AepInterpolation,
  AepKeyframe,
  AepProperty,
  AepPropertyGroup,
  AepPropertyNode,
  AepShape,
  AepShapeVertex,
} from './aepModel';

/** The `tdmn` value that closes a group. */
const GROUP_END = 'ADBE Group End';

/** AE's "this property was never renamed" display-name sentinel. */
const UNNAMED = '-_0_/-';

/** List types that hold a property or group rather than being plain data. */
const VALUE_LIST_TYPES = new Set(['tdbs', 'tdgp', 'sspc', 'om-s', 'otst', 'btds', 'omks']);

export interface PropertyContext {
  /**
   * The comp's `internalTimebase` — keyframe times are integer counts of it.
   * Zero would make every keyframe land at `Infinity`, so a missing value
   * falls back to AE's 24 fps default rather than poisoning the timeline.
   */
  timebase: number;
  /**
   * The owning layer's pixel size: its source's, or the comp's when it has no
   * source. Several properties are stored as fractions of it — mask vertices,
   * the anchor point, an effect's point parameters — so this has to be the
   * LAYER's size and not the comp's whenever the two differ.
   */
  layerWidth: number;
  layerHeight: number;
  /**
   * Whether the layer has a source item.
   *
   * It decides how to read the anchor point, which AE normalises against the
   * source on a footage or comp layer and stores in raw pixels on a shape,
   * text or null layer. Scaling the second kind moves the anchor by a factor of
   * the layer size, which reads as "my text is rotating around the wrong spot".
   */
  hasSource: boolean;
  warnings: string[];
}

// ── Stored units vs AE's units ──────────────────────────────────────
//
// Several properties are not stored in the units AE shows. Converting here
// rather than in the planner means the model always reads the way AE's own
// scripting API reads, which is what the mapping tables are written against.

/** Stored as a 0–1 fraction, shown as a percentage. */
const PERCENT_PROPERTIES = new Set(['ADBE Opacity', 'ADBE Scale', 'ADBE Mask Opacity']);

/** Stored normalised against the layer's source, on layers that have one. */
const ANCHOR_POINT = 'ADBE Anchor Point';

/** `PF_ParamType` values that carry a point normalised to the layer's size. */
const CONTROL_TYPE_2D_POINT = 6;

/**
 * How to rescale each dimension of a property's value, or null for "as stored".
 *
 * Returned as a factor array rather than applied inline because the keyframe
 * SPEEDS have to move with the values — a speed is value-units per second, so
 * a value scaled by 100 with an unscaled speed produces an ease a hundred times
 * too flat.
 */
function unitScale(matchName: string, ctx: PropertyContext): number[] | null {
  if (PERCENT_PROPERTIES.has(matchName)) return [100, 100, 100, 100];
  if (matchName === ANCHOR_POINT && ctx.hasSource) {
    return [ctx.layerWidth, ctx.layerHeight, ctx.layerWidth];
  }
  return null;
}

const applyScale = (values: number[], scale: number[]): number[] =>
  values.map((v, i) => v * (scale[i] ?? scale[scale.length - 1] ?? 1));

/**
 * A colour, as AE stores it: four doubles, alpha first, each 0–255.
 *
 * The model exposes `[r, g, b, a]` in 0–1 — which is both what every other
 * colour in this editor looks like and what AE's own scripting reports, so the
 * swap happens once, here.
 */
const toRgba = (argb: number[]): number[] =>
  argb.length === 4 ? [argb[1]! / 255, argb[2]! / 255, argb[3]! / 255, argb[0]! / 255] : argb;

// ── tdb4: what kind of property is this ─────────────────────────────

interface Tdb4 {
  dimensions: number;
  isSpatial: boolean;
  isColor: boolean;
  isInteger: boolean;
  animated: boolean;
  hasExpression: boolean;
  expressionDisabled: boolean;
}

function readTdb4(chunk: AepChunk | undefined): Tdb4 {
  const r = readerFor(chunk);
  return {
    dimensions: Math.max(1, Math.min(16, r.u16(2))),
    isSpatial: r.bit(5, 3),
    isColor: r.bit(59, 0),
    isInteger: r.bit(59, 2),
    animated: r.u8(68) !== 0,
    // AE sets this marker whenever an expression string is present, enabled or
    // not, and refuses to open a file where the two disagree.
    hasExpression: r.bit(120, 0),
    expressionDisabled: r.bit(119, 0),
  };
}

// ── Keyframes ───────────────────────────────────────────────────────

type KeyframeShape =
  | { kind: 'scalar'; dims: number }
  | { kind: 'spatial'; dims: number }
  | { kind: 'color' }
  | { kind: 'no-value' }
  | { kind: 'shape' }
  | { kind: 'other' };

/**
 * The per-item layout, from `lhd3`'s item size plus the property's spatial flag.
 *
 * Sizes are AE's and are listed rather than derived: the arithmetic that
 * "explains" 104 = 8 + 8 + 5×8 + 3×2×8 is right, but a table is what survives
 * AE adding a field to one of them.
 */
function keyframeShape(itemSize: number, isSpatial: boolean): KeyframeShape {
  switch (itemSize) {
    case 152:
      return { kind: 'color' };
    case 128:
      // The collision: 3-D spatial and 3-D scalar are the same size.
      return isSpatial ? { kind: 'spatial', dims: 3 } : { kind: 'scalar', dims: 3 };
    case 104:
      return { kind: 'spatial', dims: 2 };
    case 88:
      return { kind: 'scalar', dims: 2 };
    case 80:
      // Orientation: one value plus a trailing block this reader does not need.
      return { kind: 'scalar', dims: 1 };
    case 64:
      return { kind: 'no-value' };
    case 48:
      return { kind: 'scalar', dims: 1 };
    case 8:
      return { kind: 'shape' };
    default:
      return { kind: 'other' };
  }
}

const INTERPOLATION: Record<number, AepInterpolation> = { 1: 'linear', 2: 'bezier', 3: 'hold' };

const interpolationOf = (raw: number): AepInterpolation => INTERPOLATION[raw] ?? 'linear';

/** One keyframe from the `ldat` payload at `at`. */
function readKeyframe(r: Reader, at: number, shape: KeyframeShape, timebase: number): AepKeyframe | null {
  const timeUnits = r.i32(at);
  const inInterpolation = interpolationOf(r.u8(at + 4));
  const outInterpolation = interpolationOf(r.u8(at + 5));
  const flags = r.u8(at + 7);
  const base: Omit<AepKeyframe, 'value' | 'inSpeed' | 'inInfluence' | 'outSpeed' | 'outInfluence'> = {
    time: timeUnits / timebase,
    inInterpolation,
    outInterpolation,
    temporalContinuous: (flags & (1 << 3)) !== 0,
    temporalAutoBezier: (flags & (1 << 4)) !== 0,
    roving: (flags & (1 << 5)) !== 0,
    spatialAutoBezier: false,
    spatialContinuous: false,
  };
  const payload = at + 8;

  if (shape.kind === 'color') {
    // 18 doubles: two AE keeps to itself, the four eases, then RGBA, then a
    // per-channel block this reader does not use.
    const d = r.f64s(payload, 18);
    return {
      ...base,
      value: [d[6]!, d[7]!, d[8]!, d[9]!],
      inSpeed: [d[2]!],
      inInfluence: [d[3]!],
      outSpeed: [d[4]!],
      outInfluence: [d[5]!],
    };
  }

  if (shape.kind === 'no-value') {
    const d = r.f64s(payload, 6);
    return { ...base, value: [], inSpeed: [d[2]!], inInfluence: [d[3]!], outSpeed: [d[4]!], outInfluence: [d[5]!] };
  }

  if (shape.kind === 'spatial') {
    const n = shape.dims;
    // A spatial keyframe opens with its own flag byte, then five shared
    // doubles, then value / in-tangent / out-tangent arrays.
    const spatialFlags = r.u8(payload + 3);
    const d = r.f64s(payload + 8, 5 + 3 * n);
    return {
      ...base,
      spatialAutoBezier: (spatialFlags & (1 << 1)) !== 0,
      spatialContinuous: (spatialFlags & 1) !== 0,
      value: d.slice(5, 5 + n),
      // AE stores ONE ease for the whole spatial property, not one per axis:
      // a motion path has a single speed graph. Repeating it per dimension
      // keeps every consumer able to index by axis without special-casing.
      inSpeed: Array(n).fill(d[1]!),
      inInfluence: Array(n).fill(d[2]!),
      outSpeed: Array(n).fill(d[3]!),
      outInfluence: Array(n).fill(d[4]!),
      inTangent: d.slice(5 + n, 5 + 2 * n),
      outTangent: d.slice(5 + 2 * n, 5 + 3 * n),
    };
  }

  if (shape.kind === 'scalar') {
    const n = shape.dims;
    const d = r.f64s(payload, 5 * n);
    return {
      ...base,
      value: d.slice(0, n),
      inSpeed: d.slice(n, 2 * n),
      inInfluence: d.slice(2 * n, 3 * n),
      outSpeed: d.slice(3 * n, 4 * n),
      outInfluence: d.slice(4 * n, 5 * n),
    };
  }

  return null;
}

interface KeyframeList {
  count: number;
  itemSize: number;
  itemTypeRaw: number;
  data: AepChunk | undefined;
}

/** The `lhd3` header and the `ldat` body of a `LIST list`. */
function readKeyframeList(list: AepChunk | undefined): KeyframeList | null {
  const header = findChunk(list, 'lhd3');
  if (!header) return null;
  const r = readerFor(header);
  return {
    count: r.u16(10),
    itemSize: r.u16(18),
    itemTypeRaw: r.u8(23),
    data: findChunk(list, 'ldat'),
  };
}

function readKeyframes(list: AepChunk | undefined, isSpatial: boolean, ctx: PropertyContext): AepKeyframe[] {
  const meta = readKeyframeList(list);
  if (!meta || !meta.data || meta.count === 0 || meta.itemSize === 0) return [];
  const shape = keyframeShape(meta.itemSize, isSpatial);
  if (shape.kind === 'other' || shape.kind === 'shape') return [];

  const r = readerFor(meta.data);
  const timebase = ctx.timebase > 0 ? ctx.timebase : 24576;
  const out: AepKeyframe[] = [];
  for (let i = 0; i < meta.count; i++) {
    const at = i * meta.itemSize;
    if (!r.has(at, meta.itemSize)) break; // truncated tail — keep what is whole
    const kf = readKeyframe(r, at, shape, timebase);
    if (kf) out.push(kf);
  }
  // AE writes them in order, but a hand-edited file need not, and every
  // consumer downstream assumes ascending time.
  out.sort((a, b) => a.time - b.time);
  return out;
}

// ── Shapes ──────────────────────────────────────────────────────────

/**
 * A mask/path outline.
 *
 * AE stores the vertices NORMALISED to the bounding box in `shph`, and the box
 * itself as a fraction of the layer's size. So a mask on a 100×100 layer
 * running from (0.1, 0.1) to (0.5, 0.5) is the rectangle (10, 10)–(50, 50) —
 * which is exactly what AE's own scripting API reports for that file.
 *
 * The point list is a bezier polyline in `[vertex, outControl, inControl]`
 * triples: three points per segment, with a closed path wrapping the last
 * in-control back onto the first vertex. Controls are absolute; this converts
 * them to the vertex-relative offsets the rest of the editor speaks.
 */
function readShape(shap: AepChunk | undefined, ctx: PropertyContext): AepShape | undefined {
  if (!shap) return undefined;
  const header = readerFor(findChunk(shap, 'shph'));
  const meta = readKeyframeList(findList(shap, 'list'));
  if (!meta?.data) return undefined;

  const flags = header.u8(3);
  const normalised = (flags & 1) !== 0;
  const closed = (flags & (1 << 3)) === 0;
  const left = header.f32(4);
  const top = header.f32(8);
  const right = header.f32(12);
  const bottom = header.f32(16);

  const r = readerFor(meta.data);
  const raw: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < meta.count; i++) {
    const at = i * 8;
    if (!r.has(at, 8)) break;
    raw.push({ x: r.f32(at), y: r.f32(at + 4) });
  }
  if (raw.length < 3) return undefined;

  const sx = ctx.layerWidth || 1;
  const sy = ctx.layerHeight || 1;
  const toPixels = (p: { x: number; y: number }) =>
    normalised
      ? { x: (left + p.x * (right - left)) * sx, y: (top + p.y * (bottom - top)) * sy }
      : { x: p.x * sx, y: p.y * sy };

  const points = raw.map(toPixels);
  const count = closed ? Math.floor(points.length / 3) : Math.floor((points.length + 2) / 3);
  const vertices: AepShapeVertex[] = [];
  for (let k = 0; k < count; k++) {
    const vertex = points[k * 3];
    if (!vertex) break;
    const out = points[k * 3 + 1] ?? vertex;
    // The in-control of vertex k was written as the third point of the
    // PREVIOUS triple; for the first vertex of a closed path that is the very
    // last point in the list.
    const inIndex = k === 0 ? (closed ? points.length - 1 : -1) : k * 3 - 1;
    const incoming = inIndex >= 0 ? (points[inIndex] ?? vertex) : vertex;
    vertices.push({
      x: vertex.x,
      y: vertex.y,
      inX: incoming.x - vertex.x,
      inY: incoming.y - vertex.y,
      outX: out.x - vertex.x,
      outY: out.y - vertex.y,
    });
  }
  return { closed, vertices };
}

// ── Leaves ──────────────────────────────────────────────────────────

/** The display name in a `tdsn`, or undefined when AE left it unnamed. */
function displayName(parent: AepChunk | undefined): string | undefined {
  const tdsn = findChunk(parent, 'tdsn');
  const text = chunkText(findChunk(tdsn, 'Utf8'));
  return text && text !== UNNAMED ? text : undefined;
}

function readLeaf(matchName: string, tdbs: AepChunk, ctx: PropertyContext): AepProperty {
  const meta = readTdb4(findChunk(tdbs, 'tdb4'));
  const cdat = findChunk(tdbs, 'cdat');
  const r = readerFor(cdat);
  const raw = r.f64s(0, Math.min(meta.dimensions, Math.floor(r.length / 8)));
  const keyframes = readKeyframes(findList(tdbs, 'list'), meta.isSpatial, ctx);
  const expression = meta.hasExpression ? chunkText(findChunk(tdbs, 'Utf8')) : '';

  const scale = unitScale(matchName, ctx);
  const convert = (values: number[]): number[] => {
    const scaled = scale ? applyScale(values, scale) : values;
    return meta.isColor ? toRgba(scaled) : scaled;
  };
  const value = convert(raw);
  if (scale) {
    for (const kf of keyframes) {
      kf.value = convert(kf.value);
      // A speed is value-units per second; scaling the value without scaling
      // the speed silently flattens every ease on the property.
      kf.inSpeed = applyScale(kf.inSpeed, scale);
      kf.outSpeed = applyScale(kf.outSpeed, scale);
    }
  } else if (meta.isColor) {
    for (const kf of keyframes) kf.value = toRgba(kf.value);
  }

  return {
    node: 'property',
    matchName,
    ...(displayName(tdbs) ? { name: displayName(tdbs) } : {}),
    dimensions: meta.dimensions,
    isColor: meta.isColor,
    isSpatial: meta.isSpatial,
    isInteger: meta.isInteger,
    animated: meta.animated || keyframes.length > 0,
    // A keyframed property's `cdat` holds the value at the current time, which
    // is a fine still-frame fallback but is NOT the property's value at t=0 —
    // so consumers that see keyframes must use them.
    value: value.length > 0 ? value : keyframes[0]?.value ?? [],
    keyframes,
    ...(expression ? { expression } : {}),
    expressionEnabled: meta.hasExpression && !meta.expressionDisabled,
  };
}

/**
 * A mask/path property: `om-s` wraps the usual `tdbs` metadata alongside an
 * `omks` list of `shap` outlines — one per keyframe, or just one when static.
 */
function readOutline(matchName: string, oms: AepChunk, ctx: PropertyContext): AepProperty {
  const tdbs = findList(oms, 'tdbs');
  const base: AepProperty = tdbs
    ? readLeaf(matchName, tdbs, ctx)
    : {
        node: 'property',
        matchName,
        dimensions: 1,
        isColor: false,
        isSpatial: false,
        isInteger: false,
        animated: false,
        value: [],
        keyframes: [],
        expressionEnabled: false,
      };

  const omks = findList(oms, 'omks');
  const shapes = (omks?.children ?? []).filter((c) => c.listType === 'shap');
  const shape = readShape(shapes[0], ctx);
  if (shapes.length > 1) {
    // An animated outline. The editor imports the first shape and keys nothing,
    // because an animated mask needs the path-data track this planner does not
    // build yet — saying so beats a mask that silently stops moving.
    ctx.warnings.push(`"${matchName}" has an animated outline; the first shape was imported and the rest dropped`);
  }
  return { ...base, ...(shape ? { shape } : {}) };
}

/**
 * 3-D orientation: `otst` keeps the property metadata in a nested `tdbs` and
 * its animated values in `otky`/`otda` blocks, which are little-endian doubles
 * rather than the big-endian everything else uses.
 */
function readOrientation(matchName: string, otst: AepChunk, ctx: PropertyContext): AepProperty {
  const tdbs = findList(otst, 'tdbs');
  const base = tdbs
    ? readLeaf(matchName, tdbs, ctx)
    : ({
        node: 'property',
        matchName,
        dimensions: 3,
        isColor: false,
        isSpatial: false,
        isInteger: false,
        animated: false,
        value: [],
        keyframes: [],
        expressionEnabled: false,
      } satisfies AepProperty);

  if (base.value.length === 0) {
    const otda = findChunk(findList(otst, 'otky'), 'otda');
    if (otda) base.value = readerFor(otda).f64s(0, 3);
  }
  return { ...base, dimensions: 3 };
}

/** A text property: `btds` holds the usual metadata plus the COS document. */
function readTextProperty(matchName: string, btds: AepChunk, ctx: PropertyContext): AepProperty {
  const tdbs = findList(btds, 'tdbs');
  const base: AepProperty = tdbs
    ? readLeaf(matchName, tdbs, ctx)
    : {
        node: 'property',
        matchName,
        dimensions: 1,
        isColor: false,
        isSpatial: false,
        isInteger: false,
        animated: false,
        value: [],
        keyframes: [],
        expressionEnabled: false,
      };

  const btdk = findList(btds, 'btdk');
  if (btdk?.body) {
    try {
      const doc = readTextDocument(btdk.body);
      if (doc) return { ...base, text: doc };
      ctx.warnings.push(`the text of "${matchName}" could not be read`);
    } catch {
      ctx.warnings.push(`the text of "${matchName}" could not be read`);
    }
  }
  return base;
}

/**
 * An effect: `sspc` carries the effect's display name in `fnam` and its
 * parameters in a nested `tdgp`.
 *
 * The parameter DEFINITIONS in the sibling `parT` list are read too, because a
 * plug-in effect's parameters are named `"CC Sphere-0007"` and nothing else in
 * the file says that 0007 is "Radius". Those names are what makes the report
 * on an unmapped effect worth reading.
 */
function readEffect(matchName: string, sspc: AepChunk, ctx: PropertyContext): AepPropertyGroup {
  const inner = findList(sspc, 'tdgp');
  const group = inner
    ? readGroup(inner, ctx, matchName)
    : { node: 'group' as const, matchName, children: [] };

  const name = chunkText(findChunk(findChunk(sspc, 'fnam'), 'Utf8'));
  const defs = readParamDefinitions(findList(sspc, 'parT'));
  for (const child of group.children) {
    const def = defs.get(child.matchName);
    if (!def) continue;
    if (def.label && !child.name) child.name = def.label;
    if (child.node !== 'property') continue;
    child.controlType = def.controlType;
    // A point parameter is a fraction of the layer, not a pixel coordinate —
    // an effect centred on a 1920-wide layer stores 0.5, and a reader that
    // takes that literally puts every effect's centre in the top-left corner.
    if (def.controlType === CONTROL_TYPE_2D_POINT) {
      const scale = [ctx.layerWidth, ctx.layerHeight];
      child.value = applyScale(child.value, scale);
      for (const kf of child.keyframes) {
        kf.value = applyScale(kf.value, scale);
        kf.inSpeed = applyScale(kf.inSpeed, scale);
        kf.outSpeed = applyScale(kf.outSpeed, scale);
        if (kf.inTangent) kf.inTangent = applyScale(kf.inTangent, scale);
        if (kf.outTangent) kf.outTangent = applyScale(kf.outTangent, scale);
      }
    }
  }
  return { ...group, matchName, ...(name ? { name } : {}) };
}

/**
 * `parT` → match name ▸ the parameter's label and control type.
 *
 * A `pard` is the serialised `PF_ParamDef` from the AE SDK: fifteen bytes of
 * flags, the `PF_ParamType` at byte 15, then a 32-byte UTF-8 name.
 */
function readParamDefinitions(parT: AepChunk | undefined): Map<string, { label: string; controlType: number }> {
  const out = new Map<string, { label: string; controlType: number }>();
  let pending: string | null = null;
  for (const child of parT?.children ?? []) {
    if (child.id === 'tdmn') {
      pending = chunkText(child);
      continue;
    }
    if (child.id === 'pard' && pending) {
      const r = readerFor(child);
      out.set(pending, { label: r.str(16, 32), controlType: r.u8(15) });
      pending = null;
    }
  }
  return out;
}

// ── Groups ──────────────────────────────────────────────────────────

/**
 * Read one member's value chunk into a property node.
 *
 * Returns null for a member whose value is a form this reader does not decode.
 * That is not a failure: AE stores a lot of view state and per-panel junk in
 * the same trees, and importing none of it is correct.
 */
function readMember(matchName: string, value: AepChunk, ctx: PropertyContext): AepPropertyNode | null {
  switch (value.listType) {
    case 'tdbs':
      return readLeaf(matchName, value, ctx);
    case 'tdgp':
      return readGroup(value, ctx, matchName);
    case 'sspc':
      return readEffect(matchName, value, ctx);
    case 'om-s':
      return readOutline(matchName, value, ctx);
    case 'otst':
      return readOrientation(matchName, value, ctx);
    case 'btds':
      return readTextProperty(matchName, value, ctx);
    default:
      return null;
  }
}

/**
 * Read a `tdgp` (or an effect's parameter group) into a property group.
 *
 * `matchName` is supplied by the caller because a group does not carry its own
 * name — the `tdmn` that introduced it does.
 */
export function readGroup(list: AepChunk, ctx: PropertyContext, matchName: string): AepPropertyGroup {
  const children: AepPropertyNode[] = [];
  let pending: string | null = null;

  for (const child of list.children ?? []) {
    if (child.id === 'tdmn') {
      const name = chunkText(child);
      if (name === GROUP_END) break;
      pending = name;
      continue;
    }
    if (pending === null) continue;
    // Not every chunk between a name and its value is the value — a mask's
    // `mkif` sits in that gap. Anything that is not one of the value list
    // types is skipped, and the pending name waits for the real one.
    if (!child.listType || !VALUE_LIST_TYPES.has(child.listType)) continue;
    const node = readMember(pending, child, ctx);
    if (node) children.push(node);
    pending = null;
  }

  return {
    node: 'group',
    matchName,
    ...(displayName(list) ? { name: displayName(list) } : {}),
    children,
  };
}

/**
 * The raw members of a group, name and value chunk, without decoding.
 *
 * Masks need this: a mask atom's `mkif` is metadata the property model has no
 * room for, and the mask reader wants the pairing logic without the decoding.
 */
export function groupMembers(list: AepChunk): Array<{ matchName: string; between: AepChunk[]; value: AepChunk }> {
  const out: Array<{ matchName: string; between: AepChunk[]; value: AepChunk }> = [];
  let pending: string | null = null;
  let between: AepChunk[] = [];
  for (const child of list.children ?? []) {
    if (child.id === 'tdmn') {
      const name = chunkText(child);
      if (name === GROUP_END) break;
      pending = name;
      between = [];
      continue;
    }
    if (pending === null) continue;
    if (!child.listType || !VALUE_LIST_TYPES.has(child.listType)) {
      between.push(child);
      continue;
    }
    out.push({ matchName: pending, between, value: child });
    pending = null;
    between = [];
  }
  return out;
}
