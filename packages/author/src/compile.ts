/**
 * Scene script → `ToolCall[]`, deterministically.
 *
 * The compiler is a translator and nothing else. It may resolve a palette
 * reference, convert beat-local time to composition time, and spell a
 * property the way a tool takes it. It may NOT design: no colour, size,
 * position, font, ease or duration appears in the output that the script did
 * not state. Where a tool has a default of its own (a shape's size when the
 * script gives none), that is the TOOL's behaviour, reported by its reply —
 * the compiler does not pre-empt it with a value of its own.
 *
 * ## Shape of the output
 *
 * ```
 * head    update_composition { background }, then the back globals
 * beat i  create_layer beat_<i> (a null at the origin, timed to the beat)
 *         every layer created, back to front
 *         every layer parented (to its parent, else to beat_<i>), styled,
 *         given its effects, animators, operators and masks
 *         one set_keyframes per 200 keys, the expressions
 *         one set_layer_timing for the beat
 * tail    the front globals under TAIL_ROOT
 * ```
 *
 * Wiping a beat is `delete_layer { nodeIds: ['beat_<i>'] }` — every layer of
 * the beat is a descendant of its root. Replaying it is its range.
 */

import { CREATE_FIELDS } from './vocabulary';
import type {
  Beat,
  CallRange,
  CompiledScript,
  EffectSpec,
  Key,
  LayerSpec,
  SceneScript,
  ToolCall,
} from './types';

/** The root null of beat `i`. Also its alias. */
export const beatRootId = (i: number): string => `beat_${i}`;

/** The root null of the front globals. */
export const TAIL_ROOT = 'globals_front';

/** Keyframes per `set_keyframes` call (the schema's maxItems). */
const KEY_BATCH = 200;
/** Items per `set_layer_timing` call (the schema's maxItems). */
const TIMING_BATCH = 200;

/** Operator handles: stable, derived from the layer id, unique in the run. */
export const trimHandle = (layerId: string): string => `${layerId}__trim`;
export const repeaterHandle = (layerId: string, j: number): string => `${layerId}__rep${j}`;
export const pathOpHandle = (layerId: string, j: number): string => `${layerId}__op${j}`;

interface KeyItem {
  nodeId: string;
  prop: string;
  t: number;
  value: number;
  easing?: string;
  bezier?: number[];
}

class Emitter {
  readonly calls: ToolCall[] = [];
  readonly problems: string[] = [];
  constructor(private readonly palette: Readonly<Record<string, string>>) {}

  push(name: string, args: Record<string, unknown>): void {
    this.calls.push({ name, args });
  }

  /** A palette reference resolved; anything else returned as is. */
  colour(v: unknown): unknown {
    if (typeof v !== 'string' || !v.startsWith('$')) return v;
    return this.palette[v.slice(1)] ?? v;
  }
}

/** One layer's creation call. */
function createCall(e: Emitter, l: LayerSpec, props: Record<string, unknown>): void {
  const at = { ...(props.x !== undefined ? { x: props.x } : {}), ...(props.y !== undefined ? { y: props.y } : {}) };
  switch (l.kind) {
    case 'gradient': {
      const g = l.gradient!;
      e.push('create_gradient', {
        id: l.id,
        name: l.name,
        stops: g.stops.map((s) => e.colour(s)),
        ...(g.kind ? { kind: g.kind } : {}),
        ...(g.angle !== undefined ? { angle: g.angle } : {}),
        ...(g.centerX !== undefined ? { centerX: g.centerX } : {}),
        ...(g.centerY !== undefined ? { centerY: g.centerY } : {}),
        ...(g.radius !== undefined ? { radius: g.radius } : {}),
        // In list order, like every other layer: the stack is the script's.
        placement: 'top',
      });
      return;
    }
    case 'image':
      e.push('generate_image', { id: l.id, prompt: l.image!.prompt, ...(l.image!.aspect ? { aspect: l.image!.aspect } : {}), ...at });
      return;
    case 'svg':
      e.push('import_svg', { id: l.id, markup: l.svg!.markup, name: l.name, ...at });
      return;
    case 'video': {
      const v = l.video!;
      e.push('generate_video', {
        id: l.id,
        prompt: v.prompt,
        ...(v.durationSec !== undefined ? { durationSec: v.durationSec } : {}),
        ...(v.aspect ? { aspect: v.aspect } : {}),
        ...(v.model ? { model: v.model } : {}),
        ...(v.fit ? { fit: v.fit } : {}),
        ...at,
      });
      return;
    }
    default: {
      const args: Record<string, unknown> = { id: l.id, kind: l.kind, name: l.name };
      if (l.kind === 'shape' && l.shape) args.shape = l.shape;
      if (l.kind === 'text' && l.text !== undefined) args.text = l.text;
      for (const [k, v] of Object.entries(props)) if (CREATE_FIELDS.has(k)) args[k] = k === 'fill' ? e.colour(v) : v;
      e.push('create_layer', args);
    }
  }
}

/** Kinds whose creation call already carried the create-time props. */
const CREATED_WITH_PROPS = new Set(['shape', 'text', 'solid', 'null', 'camera', 'light', 'adjustment', 'particle']);

/** A layer's static props, with its type style folded in (explicit props win). */
function staticProps(script: SceneScript, l: LayerSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const ts = l.typeStyle ? script.type[l.typeStyle] : undefined;
  if (ts && l.kind === 'text') {
    if (ts.family !== undefined) out.fontFamily = ts.family;
    if (ts.weight !== undefined) out.fontWeight = ts.weight;
    if (ts.size !== undefined) out.fontSize = ts.size;
    if (ts.tracking !== undefined) out.letterSpacing = ts.tracking;
    if (ts.leading !== undefined) out.lineHeight = ts.leading;
  }
  return { ...out, ...(l.props ?? {}) };
}

/** Keyframe items for one property track. */
function keyItems(nodeId: string, prop: string, keys: readonly Key[], offset: number, out: KeyItem[]): void {
  for (const k of keys) {
    out.push({
      nodeId,
      prop,
      t: round(offset + k.t),
      value: k.v,
      ...(k.ease ? { easing: k.ease } : {}),
      ...(k.ease === 'bezier' && k.bezier ? { bezier: [...k.bezier] } : {}),
    });
  }
}

/** Times to the microsecond: float sums like 2.1 + 0.3 must not leak 2.4000000000000004 into a call. */
const round = (t: number): number => Math.round(t * 1e6) / 1e6;

/** The first value each keyed param holds — what a static field opens at when the script only keyed it. */
function openingValues(keys: Readonly<Record<string, readonly Key[]>> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, list] of Object.entries(keys ?? {})) if (list[0]) out[k] = list[0].v;
  return out;
}

/** Everything about one created layer except its keys, expressions and bar. */
function styleLayer(e: Emitter, script: SceneScript, l: LayerSpec, parentId: string | undefined, offset: number, keys: KeyItem[], expressions: ToolCall[]): void {
  const id = l.id;
  if (parentId) e.push('reparent_layer', { nodeId: id, parentId });

  const props = staticProps(script, l);
  const update: Record<string, unknown> = {};
  // A name the creation call could not carry.
  if (!CREATED_WITH_PROPS.has(l.kind) && l.kind !== 'svg' && l.kind !== 'gradient') update.name = l.name;
  for (const [k, v] of Object.entries(props)) {
    // Sent on create for the kinds whose create takes them.
    if (CREATE_FIELDS.has(k) && CREATED_WITH_PROPS.has(l.kind)) continue;
    // x / y went on the creation call of image, svg and video.
    if ((k === 'x' || k === 'y') && (l.kind === 'image' || l.kind === 'svg' || l.kind === 'video')) continue;
    if (k === 'scale') continue;
    if (k === 'fill' || k === 'stroke') update[k] = e.colour(v);
    else update[k] = v;
  }
  // A uniform scale is the two axes; an axis the script names wins.
  if (typeof props.scale === 'number') {
    if (update.scaleX === undefined) update.scaleX = props.scale;
    if (update.scaleY === undefined) update.scaleY = props.scale;
  }
  // A camera is 3D by nature, but `update_layer` gates z on the 3D switch, so
  // a camera's static depth rides as its opening key instead (the same value,
  // held), unless the script keys z itself.
  if (l.kind === 'camera' && typeof update.z === 'number') {
    if (!l.keys?.z) keyItems(id, 'z', [{ t: 0, v: update.z }], offset, keys);
    delete update.z;
  }
  if (l.matte) update.matte = { mode: l.matte.mode, sourceId: l.matte.source };
  if (Object.keys(update).length) e.push('update_layer', { nodeId: id, ...update });

  if (l.light && Object.keys(l.light).length) {
    e.push('set_light', { nodeId: id, ...l.light, ...(l.light.color ? { color: e.colour(l.light.color) } : {}) });
  }

  for (const fx of l.effects ?? []) effectCalls(e, id, fx, offset, keys);

  l.textAnimators?.forEach((a, index) => {
    const { keys: aKeys, sweep, ...fields } = a;
    const args: Record<string, unknown> = { nodeId: id, ...fields };
    if (fields.color) args.color = e.colour(fields.color);
    if (sweep) {
      args.sweep = {
        fromSec: round(offset + sweep.from),
        toSec: round(offset + sweep.to),
        ...(sweep.fromOffset !== undefined ? { fromOffset: sweep.fromOffset } : {}),
        ...(sweep.toOffset !== undefined ? { toOffset: sweep.toOffset } : {}),
        ...(sweep.ease ? { easing: sweep.ease } : {}),
        ...(sweep.bezier ? { bezier: [...sweep.bezier] } : {}),
      };
    }
    e.push('text_animator', args);
    // Animators are appended in order on a fresh layer, so the index is the list position.
    for (const [param, list] of Object.entries(aKeys ?? {})) keyItems(id, `ta.${index}.${param}`, list, offset, keys);
  });

  if (l.trim) {
    const h = trimHandle(id);
    const statics = { ...openingValues(l.trim.keys), ...pick(l.trim, ['start', 'end', 'offset']) };
    e.push('set_trim_path', { nodeId: id, id: h, ...statics });
    for (const [param, list] of Object.entries(l.trim.keys ?? {})) keyItems(id, `pathop.${h}.${param}`, list, offset, keys);
  }
  l.repeaters?.forEach((r, j) => {
    const h = repeaterHandle(id, j);
    const { keys: rKeys, ...fields } = r;
    e.push('add_repeater', { nodeId: id, id: h, ...fields });
    for (const [param, list] of Object.entries(rKeys ?? {})) keyItems(id, `pathop.${h}.${param}`, list, offset, keys);
  });
  l.pathOps?.forEach((p, j) => {
    const h = pathOpHandle(id, j);
    const { keys: pKeys, ...fields } = p;
    e.push('add_path_operator', { nodeId: id, id: h, ...fields });
    for (const [param, list] of Object.entries(pKeys ?? {})) keyItems(id, `pathop.${h}.${param}`, list, offset, keys);
  });
  for (const m of l.masks ?? []) e.push('create_mask', { nodeId: id, ...m });

  for (const [prop, list] of Object.entries(l.keys ?? {})) keyItems(id, prop, list, offset, keys);
  for (const [prop, expression] of Object.entries(l.expressions ?? {})) {
    expressions.push({ name: 'set_expression', args: { nodeId: id, prop, expression } });
  }
}

function effectCalls(e: Emitter, nodeId: string, fx: EffectSpec, offset: number, keys: KeyItem[]): void {
  const effectId = fx.id ?? fx.type;
  e.push('add_effect', { nodeId, type: fx.type, id: effectId });
  for (const [key, value] of Object.entries(fx.params ?? {})) {
    e.push('update_effect_param', { nodeId, effectId, key, value: e.colour(value) });
  }
  for (const [param, list] of Object.entries(fx.keys ?? {})) keyItems(nodeId, `effect.${effectId}.${param}`, list, offset, keys);
}

function pick<T extends object, K extends keyof T>(o: T, ks: readonly K[]): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  for (const k of ks) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

function flushKeys(e: Emitter, keys: KeyItem[]): void {
  for (let i = 0; i < keys.length; i += KEY_BATCH) e.push('set_keyframes', { keyframes: keys.slice(i, i + KEY_BATCH) });
}

function flushTiming(e: Emitter, items: Array<Record<string, unknown>>): void {
  for (let i = 0; i < items.length; i += TIMING_BATCH) e.push('set_layer_timing', { items: items.slice(i, i + TIMING_BATCH) });
}

/** A bar item for one layer: beat-local bounds → composition seconds. */
function barItem(l: LayerSpec, offset: number, span: number): Record<string, unknown> {
  const inSec = round(offset + (l.inSec ?? 0));
  const outSec = round(offset + (l.outSec ?? span));
  // A clip's first frame plays at its in point.
  return { nodeId: l.id, inSec, outSec, ...(l.kind === 'video' ? { startSec: inSec } : {}) };
}

/**
 * A list of layers under one root: create back to front, then style, then
 * keys, expressions and bars. `root` null = top level (back globals).
 */
function emitLayers(
  e: Emitter,
  script: SceneScript,
  ls: readonly LayerSpec[],
  root: string | null,
  offset: number,
  span: number | null,
): void {
  for (const l of ls) createCall(e, l, staticProps(script, l));
  const keys: KeyItem[] = [];
  const expressions: ToolCall[] = [];
  for (const l of ls) styleLayer(e, script, l, l.parent ?? root ?? undefined, offset, keys, expressions);
  flushKeys(e, keys);
  for (const c of expressions) e.push(c.name, c.args);
  const bars = ls
    .filter((l) => span !== null || l.inSec !== undefined || l.outSec !== undefined)
    .map((l) => barItem(l, offset, span ?? script.durationSec));
  if (bars.length) flushTiming(e, bars);
}

export interface CompileOptions {
  /** Emit `update_composition { background }` in the head. Default true. */
  setBackground?: boolean;
}

/** Compile a (coerced) script. Same script in, same calls out. */
export function compileScript(script: SceneScript, opts: CompileOptions = {}): CompiledScript {
  const e = new Emitter(script.palette);
  const beatOfLayer = new Map<string, number>();

  // ── head: the composition and the back globals ──
  const headStart = e.calls.length;
  if (opts.setBackground !== false && script.background) {
    e.push('update_composition', { background: e.colour(script.background) });
  }
  const back = script.globals.filter((g) => g.stack !== 'front');
  const front = script.globals.filter((g) => g.stack === 'front');
  for (const g of script.globals) beatOfLayer.set(g.id, -1);
  emitLayers(e, script, back, null, 0, null);
  const head: CallRange = { start: headStart, end: e.calls.length };

  // ── beats ──
  const byBeat: CompiledScript['byBeat'] = [];
  script.beats.forEach((b, i) => {
    const start = e.calls.length;
    emitBeat(e, script, b, i);
    for (const l of b.layers) beatOfLayer.set(l.id, i);
    byBeat.push({ beatIndex: i, rootId: beatRootId(i), start, end: e.calls.length });
  });

  // ── tail: the front globals, under their own root so a rebuild can redo them ──
  const tailStart = e.calls.length;
  if (front.length) {
    e.push('create_layer', { id: TAIL_ROOT, kind: 'null', name: 'Front globals', x: 0, y: 0 });
    emitLayers(e, script, front, TAIL_ROOT, 0, null);
  }
  const tail: CallRange = { start: tailStart, end: e.calls.length };

  return { calls: e.calls, head, tail, byBeat, beatOfLayer, problems: e.problems };
}

function emitBeat(e: Emitter, script: SceneScript, b: Beat, i: number): void {
  const root = beatRootId(i);
  const span = round(b.endSec - b.startSec);
  // The root sits at the origin so a child's world position is its local one.
  e.push('create_layer', { id: root, kind: 'null', name: `Beat ${i + 1} — ${b.name}`, x: 0, y: 0 });
  emitLayers(e, script, b.layers, root, b.startSec, span);
  // The root's own bar, appended to the beat's last timing call when it has room.
  const last = e.calls[e.calls.length - 1];
  const item = { nodeId: root, inSec: round(b.startSec), outSec: round(b.endSec) };
  if (last?.name === 'set_layer_timing' && (last.args.items as unknown[]).length < TIMING_BATCH) {
    (last.args.items as unknown[]).unshift(item);
  } else {
    e.push('set_layer_timing', { items: [item] });
  }
}

/**
 * The calls that rebuild `beatIndices` of an already-built script from a
 * fresh compile of the REVISED script: wipe each beat's root (and the tail),
 * replay their ranges, replay the tail. Untouched beats are not sent at all.
 */
export function rebuildCalls(compiled: CompiledScript, beatIndices: readonly number[]): ToolCall[] {
  const wanted = [...new Set(beatIndices)].sort((a, b) => a - b);
  const ranges = compiled.byBeat.filter((r) => wanted.includes(r.beatIndex));
  if (!ranges.length) return [];
  const hasTail = compiled.tail.end > compiled.tail.start;
  const out: ToolCall[] = [
    { name: 'delete_layer', args: { nodeIds: [...ranges.map((r) => r.rootId), ...(hasTail ? [TAIL_ROOT] : [])] } },
  ];
  for (const r of ranges) out.push(...compiled.calls.slice(r.start, r.end));
  if (hasTail) out.push(...compiled.calls.slice(compiled.tail.start, compiled.tail.end));
  return out;
}
