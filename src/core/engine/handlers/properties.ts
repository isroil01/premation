/** Properties, expressions and keyframes (ENGINE_API.md §4.6). */

import { defaultAnimation, sampleTrack, type Keyframe as TsKeyframe, type DataKeyframe } from '@motion/animation';
import type { PropRef, Value, KeyframeInsert, KeyframePatch, Keyframe } from '@motion/engine-api';
import { readNodeMaskAnim } from '@core/effects/mask';
import type { MaskKeyframe } from '@core/effects/mask';
import { readStaticPropertyValue } from '@core/inspector/propertyValue';
import { fail } from '../errors';
import { graph, requireLayer, compOfLayer } from '../doc';
import { newScope, scopeLayer, type Scope } from '../state';
import {
  catalogFor,
  requireBinding,
  readStatic,
  writeStatic,
  isAnimated,
  readKeys,
  putKeys,
  dropKeys,
  numbersOf,
  vectorValue,
  apiUnitFactor,
  flicksToKeyTime,
  keyTimeToFlicks,
  normalizeKeysAt,
  type PropBinding,
  type KeyWrite,
  type Catalog,
} from '../props';
import { pinKeyToApi } from '../rigProps';
import { fillStopsKeyToApi } from '../fillStops';

/** The layer's primary fill is a gradient (Colors has a static home). */
function hasGradientFill(layer: string): boolean {
  const t = (graph.getNode(layer)?.components.find((c) => c.type === 'fx')?.props.fill as { type?: unknown } | undefined)?.type;
  return t === 'linear' || t === 'radial';
}
import { checkTime, compFps, framesToFlicks, flicksToFrames } from '../time';
import { compDurationFrames, layerTiming } from '../model';
import type { HandlerTable, HandlerCtx } from '../handler';
import type { KeyIndex } from '../keyIndex';
import { plural } from './common';

function bind(prop: PropRef): { cat: Catalog; b: PropBinding } {
  requireLayer(prop.layer);
  const cat = catalogFor(prop.layer);
  return { cat, b: requireBinding(cat, prop.path) };
}

function propScope(s: Scope, layer: string): Scope {
  return scopeLayer(s, layer);
}

/** Type-check a value for a binding WITHOUT writing it. */
function checkValue(b: PropBinding, v: Value): void {
  if (b.special === 'sourceText') {
    if (v.kind !== 'textDocument' && v.kind !== 'string') fail('typeMismatch', `'${b.path}' takes a textDocument`, { path: b.path });
    return;
  }
  if (b.special || b.dataTrack) {
    const want = b.valueType;
    const ok = v.kind === want || (want === 'path' && v.kind === 'path');
    if (!ok) fail('typeMismatch', `'${b.path}' takes a ${want}, got ${v.kind}`, { path: b.path, detail: JSON.stringify({ expected: want }) });
    return;
  }
  numbersOf(b, v);
}

/** One property write: static when not animated, a key at `time` when animated. */
function planWrite(layer: string, b: PropBinding, value: Value, time: number | undefined, ctx: HandlerCtx): () => string | undefined {
  checkValue(b, value);
  if (time !== undefined) checkTime(time);
  const animated = isAnimated(layer, b);
  if (!animated) {
    if (b.separated && b.members.some((m) => defaultAnimation.isAnimated(layer, m))) {
      fail('animated', `'${b.path}' has separated, animated dimensions; write them one by one`, { layer, path: b.path });
    }
    return () => {
      writeStatic(layer, b, value);
      return undefined;
    };
  }
  if (time === undefined) fail('animated', `'${b.path}' is animated: give a time to key it`, { layer, path: b.path });
  const t = flicksToKeyTime(layer, b, time);
  const existing = readKeys(layer, b).find((k) => k.t === t);
  const id = existing?.id.startsWith('@') || !existing ? newKeyId(b, ctx) : existing.id;
  return () => {
    putKeys(layer, b, [{ t, id, value }]);
    reroveKeys(layer, b);
    return id;
  };
}

/** A fresh API key id for this property (mask-shape keys are per-mask views of one entry: `<entry>@<mask>`). */
function newKeyId(b: PropBinding, ctx: HandlerCtx): string {
  const id = ctx.mintKeyId();
  return b.special === 'maskPath' ? `${id}@${b.maskId}` : id;
}

// ── Key retiming on raw tracks (keeps every per-dimension field and id) ──

function retime(layer: string, b: PropBinding, map: Map<number, number>): void {
  if (map.size === 0) return;
  const moveList = <K extends { t: number }>(list: K[]): K[] => {
    const landing = new Set<number>();
    for (const [from, to] of map) if (list.some((k) => k.t === from)) landing.add(to);
    const kept = list.filter((k) => !map.has(k.t) && !landing.has(k.t));
    const moved = list.filter((k) => map.has(k.t)).map((k) => ({ ...k, t: map.get(k.t)! }));
    return [...kept, ...moved].sort((x, y) => x.t - y.t);
  };
  if (b.special === 'maskPath') {
    const anim = readNodeMaskAnim(graph.getNode(layer)!) as MaskKeyframe[];
    graph.setMaskAnim(layer, moveList(anim.map((k) => ({ ...k }))));
    return;
  }
  if (b.dataTrack) {
    const track = defaultAnimation.getDataTrack(layer, b.dataTrack);
    if (!track) return;
    defaultAnimation.setDataTrack(layer, b.dataTrack, { ...track, keyframes: moveList(track.keyframes as DataKeyframe[]) });
    return;
  }
  // The whole key moves: a lone member key gets its siblings first (§3.3).
  normalizeKeysAt(layer, b, [...map.keys()]);
  for (const m of b.members) {
    const kfs = defaultAnimation.getTrackKeyframes(layer, m);
    if (!kfs) continue;
    defaultAnimation.setTrackKeyframes(layer, m, moveList(kfs as TsKeyframe[]));
  }
}

/** Samples per segment when measuring a vector's path for roving (the legacy spatial rove's density). */
const ROVE_SAMPLES = 64;

/**
 * Rove Across Time (After Effects): each run of roving keys between two
 * non-roving keys is re-timed so the value travels at constant speed across
 * the run — each key sits at the fraction of the span equal to the distance
 * travelled to it. A scalar measures |Δvalue|; a vector the length of its path
 * through the dimensions (sampled, easing and spatial tangents included).
 * Values never change; the ends never rove. The C++ engine does the same
 * arithmetic in the same order (handlers_properties.cpp `rerove_keys`).
 */
export function reroveKeys(layer: string, b: PropBinding): void {
  if (b.members.length === 0 || b.special === 'maskPath' || b.dataTrack) return;
  const tracks = b.members.map((m) => defaultAnimation.getTrackKeyframes(layer, m) ?? []);
  if (!tracks.some((tr) => tr.some((k) => k.roving === true))) return;
  const times = [...new Set(tracks.flatMap((tr) => tr.map((k) => k.t)))].sort((x, y) => x - y);
  if (times.length < 3) return;
  const leadAt = (t: number): TsKeyframe => tracks.map((tr) => tr.find((k) => k.t === t)).find((k) => k !== undefined)!;
  const roving = times.map((t) => leadAt(t).roving === true);
  const at = (i: number, t: number): number => {
    const tr = tracks[i]!;
    if (tr.length === 0) return 0;
    return sampleTrack({ nodeId: layer, prop: b.members[i]!, keyframes: tr }, t) ?? 0;
  };
  const segLen = (k: number): number => {
    const t0 = times[k]!;
    const t1 = times[k + 1]!;
    if (b.members.length === 1) return Math.abs(at(0, t1) - at(0, t0));
    let len = 0;
    let prev: number[] = [];
    for (let s = 0; s <= ROVE_SAMPLES; s++) {
      const tt = t0 + ((t1 - t0) * s) / ROVE_SAMPLES;
      const cur = b.members.map((_m, i) => at(i, tt));
      if (s > 0) {
        let sq = 0;
        for (let i = 0; i < cur.length; i++) sq += (cur[i]! - prev[i]!) * (cur[i]! - prev[i]!);
        len += Math.sqrt(sq);
      }
      prev = cur;
    }
    return len;
  };
  const map = new Map<number, number>();
  let i = 0;
  while (i < times.length) {
    if (!roving[i]) { i++; continue; }
    const start = i - 1;
    let j = i;
    while (j < times.length && roving[j]) j++;
    if (start < 0 || j >= times.length) { i = j; continue; }
    let total = 0;
    const cum: number[] = [0];
    for (let k = start; k < j; k++) {
      total += segLen(k);
      cum.push(total);
    }
    const a = times[start]!;
    const span = times[j]! - a;
    const run = j - i;
    for (let k = 0; k < run; k++) {
      const frac = total > 0 ? cum[k + 1]! / total : (k + 1) / (run + 1);
      const nt = a + frac * span;
      if (nt !== times[i + k]) map.set(times[i + k]!, nt);
    }
    i = j;
  }
  if (map.size > 0) retime(layer, b, map);
}

interface Located {
  layer: string;
  b: PropBinding;
  t: number;
  id: string;
}

function locate(id: string, keys: KeyIndex): Located {
  const loc = keys.resolve(id);
  if (!loc) fail('notFound', `no keyframe '${id}'`, { detail: JSON.stringify({ keyframe: id }) });
  const cat = catalogFor(loc.layer);
  let b: PropBinding | undefined;
  if (loc.kind === 'mask') b = cat.byPath.get(`masks/${loc.maskId}/path`);
  else b = cat.byMember.get(loc.member);
  if (!b) fail('notFound', `keyframe '${id}' belongs to no property of layer '${loc.layer}'`, { layer: loc.layer });
  return { layer: loc.layer, b, t: loc.t, id };
}

/** Group located keys by (layer, property). */
function groupKeys(ids: readonly string[], keys: KeyIndex): Map<string, { layer: string; b: PropBinding; keys: Located[] }> {
  const out = new Map<string, { layer: string; b: PropBinding; keys: Located[] }>();
  for (const id of ids) {
    const l = locate(id, keys);
    const key = `${l.layer}|${l.b.path}`;
    const g = out.get(key) ?? { layer: l.layer, b: l.b, keys: [] };
    if (!g.keys.some((k) => k.t === l.t)) g.keys.push(l);
    out.set(key, g);
  }
  return out;
}

function keysScope(groups: Iterable<{ layer: string }>): Scope {
  const s = newScope();
  for (const g of groups) propScope(s, g.layer);
  return s;
}

function toBezier(b: { x1: number; y1: number; x2: number; y2: number } | undefined): [number, number, number, number] | undefined {
  return b ? [b.x1, b.y1, b.x2, b.y2] : undefined;
}

/**
 * Expressions live per member track (a vector's source is set on each dimension;
 * each picks its component). `member` (setExpression / setExpressionEnabled):
 * just that dimension of an unseparated vector.
 */
function exprMembers(b: PropBinding, member?: number): string[] {
  if (member !== undefined) {
    if (b.members.length < 2 || member >= b.members.length) {
      fail('outOfRange', `'${b.path}' has no dimension ${member}`, { path: b.path });
    }
    return [b.members[member]!];
  }
  if (b.members.length > 0) return b.members;
  if (b.dataTrack) return [b.dataTrack];
  return fail('notAnimatable', `'${b.path}' cannot carry an expression`, { path: b.path });
}

export const propertyHandlers: HandlerTable = {
  setProperty: (cmd, ctx) => {
    const { b } = bind(cmd.prop);
    const run = planWrite(cmd.prop.layer, b, cmd.value, cmd.time, ctx);
    return {
      scope: propScope(newScope(), cmd.prop.layer),
      label: `Set ${b.name}`,
      apply: () => {
        const id = run();
        return id ? { keyframe: id } : {};
      },
    };
  },

  setProperties: (cmd, ctx) => {
    if (cmd.writes.length === 0) fail('invalidArgument', 'no writes given');
    const runs = cmd.writes.map((w) => planWrite(w.prop.layer, bind(w.prop).b, w.value, w.time, ctx));
    const s = newScope();
    for (const w of cmd.writes) propScope(s, w.prop.layer);
    return {
      scope: s,
      label: `Set ${plural(cmd.writes.length, 'Property')}`,
      apply: () => {
        for (const r of runs) r();
        return {};
      },
    };
  },

  resetProperty: (cmd, ctx) => {
    const { b } = bind(cmd.prop);
    if (!b.defaultValue) fail('unsupported', `'${b.path}' has no default value in this engine`, { path: b.path });
    const run = planWrite(cmd.prop.layer, b, b.defaultValue, cmd.time, ctx);
    return { scope: propScope(newScope(), cmd.prop.layer), label: `Reset ${b.name}`, apply: () => { run(); return {}; } };
  },

  setAnimated: (cmd, ctx) => {
    const { b } = bind(cmd.prop);
    checkTime(cmd.time);
    if (!b.animatable) fail('notAnimatable', `'${b.path}' cannot be animated`, { path: b.path });
    const layer = cmd.prop.layer;
    const animated = isAnimated(layer, b);
    const t = flicksToKeyTime(layer, b, cmd.time);
    const id = newKeyId(b, ctx);
    return {
      scope: propScope(newScope(), layer),
      label: cmd.animated ? `Animate ${b.name}` : `Stop Animating ${b.name}`,
      apply: () => {
        if (cmd.animated) {
          if (animated) return {};
          putKeys(layer, b, [{ t, id, value: readStatic(layer, b).kind === 'none' ? undefined : readStatic(layer, b) }]);
          return { keyframe: id };
        }
        if (!animated) return {};
        const value = valueAt(layer, b, t);
        const times = readKeys(layer, b).map((k) => k.t);
        dropKeys(layer, b, times);
        if (value && ((!b.dataTrack && b.special !== 'maskPath') || b.special === 'rig' || (b.special === 'fillStops' && hasGradientFill(layer)))) writeStatic(layer, b, value);
        return {};
      },
    };
  },

  setDimensionsSeparated: (cmd) => {
    requireLayer(cmd.layer);
    if (cmd.path !== 'transform/position') fail('unsupported', 'only Position can be separated in this engine', { path: cmd.path });
    const node = graph.getNode(cmd.layer)!;
    const t = node.components.find((c) => typeof (c.props as Record<string, unknown>).x === 'number');
    if (!t) fail('notFound', 'this layer has no position', { layer: cmd.layer });
    return {
      scope: propScope(newScope(), cmd.layer),
      label: cmd.separated ? 'Separate Dimensions' : 'Merge Dimensions',
      apply: () => {
        graph.setSeparateDimensions(cmd.layer, cmd.separated);
        if (!cmd.separated) {
          // AE: merging keys every dimension at the union of the dimensions' key times.
          const dims = ['x', 'y', 'z'].filter((m) => defaultAnimation.getTrackKeyframes(cmd.layer, m) !== null || m !== 'z');
          const tracks = dims.map((m) => defaultAnimation.getTrackKeyframes(cmd.layer, m) ?? []);
          const times = new Set<number>();
          for (const tr of tracks) for (const k of tr) times.add(k.t);
          if (times.size > 0) {
            dims.forEach((m, i) => {
              const list = tracks[i]!.map((k) => ({ ...k }));
              const base = readStaticPropertyValue(cmd.layer, m) ?? 0;
              for (const tt of times) {
                if (list.some((k) => k.t === tt)) continue;
                const v = list.length > 0 ? defaultAnimation.sample(cmd.layer, m, tt) ?? base : base;
                list.push({ t: tt, value: v });
              }
              list.sort((x, y) => x.t - y.t);
              defaultAnimation.setTrackKeyframes(cmd.layer, m, list);
            });
          }
        }
        return {};
      },
    };
  },

  setExpression: (cmd) => {
    const { b } = bind(cmd.prop);
    const members = exprMembers(b, cmd.member);
    return {
      scope: propScope(newScope(), cmd.prop.layer),
      label: cmd.source.trim() === '' ? 'Remove Expression' : 'Set Expression',
      apply: () => {
        const layer = cmd.prop.layer;
        if (cmd.source.trim() === '') {
          for (const m of members) defaultAnimation.setExpressionState(layer, m, null);
          return { ok: true, diagnostics: [] };
        }
        for (const m of members) defaultAnimation.setExpressionState(layer, m, { src: cmd.source, enabled: cmd.enabled });
        // After Effects (since CC 2019): a failing expression is stored as given
        // and stays on — the property shows its pre-expression value — and the
        // error is reported, not acted on.
        const err = defaultAnimation.getExpressionError(layer, members[0]!);
        if (err) return { ok: false, diagnostics: [{ message: err, line: 0, column: 0 }] };
        return { ok: true, diagnostics: [] };
      },
    };
  },

  setExpressionEnabled: (cmd) => {
    if (cmd.props.length === 0) fail('invalidArgument', 'no properties given');
    const plans = cmd.props.map((p) => {
      const { b } = bind(p);
      const members = exprMembers(b, cmd.member);
      if (!members.some((m) => defaultAnimation.hasExpression(p.layer, m))) fail('notFound', `'${b.path}' has no expression`, { layer: p.layer, path: b.path });
      return { layer: p.layer, members };
    });
    const s = newScope();
    for (const p of cmd.props) propScope(s, p.layer);
    return {
      scope: s,
      label: cmd.enabled ? 'Enable Expression' : 'Disable Expression',
      apply: () => {
        for (const p of plans) for (const m of p.members) defaultAnimation.setExpressionEnabled(p.layer, m, cmd.enabled);
        return {};
      },
    };
  },

  convertExpressionToKeyframes: (cmd, ctx) => {
    const { b } = bind(cmd.prop);
    const layer = cmd.prop.layer;
    if (b.members.length === 0) fail('unsupported', `'${b.path}' cannot be baked in this engine`, { path: b.path });
    // `member`: one dimension of an unseparated vector (its own expression); the others are untouched.
    const members = cmd.member !== undefined ? exprMembers(b, cmd.member) : b.members;
    if (!members.some((m) => defaultAnimation.isExpressionEnabled(layer, m))) fail('invalidArgument', `'${b.path}' has no enabled expression`, { path: b.path });
    checkTime(cmd.step, 'step');
    const comp = compOfLayer(layer)!;
    const fps = compFps(comp);
    const timing = layerTiming(layer);
    const range = cmd.range ?? { start: timing.inPoint, duration: timing.outPoint - timing.inPoint };
    const stepFrames = cmd.step > 0 ? Math.max(1, flicksToFrames(cmd.step, fps)) : 1;
    const f0 = flicksToFrames(range.start, fps);
    const f1 = Math.min(flicksToFrames(range.start + range.duration, fps), compDurationFrames(comp));
    if (f1 <= f0) fail('outOfRange', 'the bake range is empty');
    const frames: number[] = [];
    for (let f = f0; f < f1; f += stepFrames) frames.push(f);
    // Composition frames that map to ONE layer time (a hold, a freeze, a
    // stretch below 100 %) keep the first — the earliest frame that reaches it.
    const times: number[] = [];
    for (const f of frames) {
      const t = flicksToKeyTime(layer, b, framesToFlicks(f, fps));
      if (!times.includes(t)) times.push(t);
    }
    const ids = times.map(() => ctx.mintKeyId());
    return {
      scope: propScope(newScope(), layer),
      label: 'Convert Expression to Keyframes',
      apply: () => {
        // Sample everything first: the expression may read its own keys.
        const samples = times.map((t) => ({ t, nums: members.map((m) => defaultAnimation.sample(layer, m, t) ?? 0) }));
        members.forEach((m, i) => {
          defaultAnimation.setTrackKeyframes(layer, m, samples.map((s, j) => ({ id: ids[j]!, t: s.t, value: s.nums[i]!, easing: 'linear' as const })));
        });
        // After Effects: the expression is DISABLED, not removed.
        for (const m of members) if (defaultAnimation.hasExpression(layer, m)) defaultAnimation.setExpressionEnabled(layer, m, false);
        return { ids };
      },
    };
  },

  linkProperty: (cmd) => {
    const { b } = bind(cmd.prop);
    const { b: target } = bind(cmd.target);
    if (b.members.length === 0 || target.members.length === 0) fail('unsupported', 'only numeric properties can be pick-whipped in this engine', { path: b.path });
    if (target.members.length < b.members.length) fail('typeMismatch', `'${target.path}' has fewer dimensions than '${b.path}'`, { path: b.path });
    return {
      scope: propScope(newScope(), cmd.prop.layer),
      label: 'Link Property',
      apply: () => {
        b.members.forEach((m, i) => {
          const src = `layer('#${cmd.target.layer}', '${target.members[i]!}')`;
          defaultAnimation.setExpressionState(cmd.prop.layer, m, { src, enabled: true });
        });
        return {};
      },
    };
  },

  // ── Keyframes ──────────────────────────────────────────────────────

  addKeyframes: (cmd, ctx) => {
    if (cmd.keys.length === 0) fail('invalidArgument', 'no keyframes given');
    const plans = cmd.keys.map((k: KeyframeInsert) => {
      const { b } = bind(k.prop);
      if (!b.animatable) fail('notAnimatable', `'${b.path}' cannot take keyframes`, { layer: k.prop.layer, path: b.path });
      checkTime(k.time);
      if (k.value) checkValue(b, k.value);
      const t = flicksToKeyTime(k.prop.layer, b, k.time);
      const existing = readKeys(k.prop.layer, b).find((x) => x.t === t);
      const id = existing && !existing.id.startsWith('@') ? existing.id : newKeyId(b, ctx);
      const w: KeyWrite = {
        t, id,
        ...(k.value ? { value: k.value } : {}),
        ...(k.easing ? { easing: k.easing } : {}),
        ...(k.bezier ? { bezier: toBezier(k.bezier)! } : {}),
        ...(k.roving !== undefined ? { roving: k.roving } : {}),
        ...(k.spatialInterp ? { spatialInterp: k.spatialInterp } : {}),
        ...(k.spatialIn.length > 0 ? { spatialIn: k.spatialIn } : {}),
        ...(k.spatialOut.length > 0 ? { spatialOut: k.spatialOut } : {}),
      };
      return { layer: k.prop.layer, b, w };
    });
    const s = newScope();
    for (const p of plans) propScope(s, p.layer);
    return {
      scope: s,
      label: `Add ${plural(plans.length, 'Keyframe')}`,
      apply: () => {
        for (const p of plans) {
          if (!p.w.value) {
            // Absent value: the property's evaluated value at that time.
            const v = valueAt(p.layer, p.b, p.w.t);
            if (v) p.w.value = v;
          }
          putKeys(p.layer, p.b, [p.w]);
        }
        for (const p of plans) reroveKeys(p.layer, p.b);
        return { ids: plans.map((p) => p.w.id) };
      },
    };
  },

  deleteKeyframes: (cmd, ctx) => {
    if (cmd.ids.length === 0) fail('invalidArgument', 'no keyframes given');
    const groups = groupKeys(cmd.ids, ctx.keys);
    return {
      scope: keysScope(groups.values()),
      label: `Delete ${plural(cmd.ids.length, 'Keyframe')}`,
      apply: () => {
        for (const g of groups.values()) dropKeys(g.layer, g.b, g.keys.map((k) => k.t));
        for (const g of groups.values()) reroveKeys(g.layer, g.b);
        return {};
      },
    };
  },

  moveKeyframes: (cmd, ctx) => {
    checkTime(cmd.delta, 'delta');
    const groups = groupKeys(cmd.ids, ctx.keys);
    return {
      scope: keysScope(groups.values()),
      label: `Move ${plural(cmd.ids.length, 'Keyframe')}`,
      apply: () => {
        for (const g of groups.values()) {
          const map = new Map<number, number>();
          for (const k of g.keys) map.set(k.t, flicksToKeyTime(g.layer, g.b, keyTimeToFlicks(g.layer, g.b, k.t) + cmd.delta));
          retime(g.layer, g.b, map);
        }
        for (const g of groups.values()) reroveKeys(g.layer, g.b);
        return {};
      },
    };
  },

  scaleKeyframes: (cmd, ctx) => {
    checkTime(cmd.pivot, 'pivot');
    if (!(cmd.factor > 0) || !Number.isFinite(cmd.factor)) fail('outOfRange', 'factor must be positive');
    const groups = groupKeys(cmd.ids, ctx.keys);
    return {
      scope: keysScope(groups.values()),
      label: 'Scale Keyframes',
      apply: () => {
        for (const g of groups.values()) {
          const map = new Map<number, number>();
          for (const k of g.keys) {
            const ct = keyTimeToFlicks(g.layer, g.b, k.t);
            map.set(k.t, flicksToKeyTime(g.layer, g.b, Math.round(cmd.pivot + (ct - cmd.pivot) * cmd.factor)));
          }
          retime(g.layer, g.b, map);
        }
        for (const g of groups.values()) reroveKeys(g.layer, g.b);
        return {};
      },
    };
  },

  reverseKeyframes: (cmd, ctx) => {
    const groups = groupKeys(cmd.ids, ctx.keys);
    return {
      scope: keysScope(groups.values()),
      label: 'Time-Reverse Keyframes',
      apply: () => {
        // After Effects: the keys are ONE block, mirrored within the span of the
        // whole selection (keys of different properties keep their arrangement).
        const list = [...groups.values()];
        const all = list.map((g) => g.keys.map((k) => keyTimeToFlicks(g.layer, g.b, k.t)));
        const flat = all.flat();
        const lo = Math.min(...flat);
        const hi = Math.max(...flat);
        list.forEach((g, gi) => {
          const map = new Map<number, number>();
          g.keys.forEach((k, i) => map.set(k.t, flicksToKeyTime(g.layer, g.b, lo + hi - all[gi]![i]!)));
          retime(g.layer, g.b, map);
        });
        for (const g of list) reroveKeys(g.layer, g.b);
        return {};
      },
    };
  },

  updateKeyframes: (cmd, ctx) => {
    if (cmd.patches.length === 0) fail('invalidArgument', 'no patches given');
    const plans = cmd.patches.map((p: KeyframePatch) => {
      const l = locate(p.id, ctx.keys);
      if (p.value) checkValue(l.b, p.value);
      if (p.time !== undefined) checkTime(p.time);
      if (p.dim !== undefined && p.dim >= Math.max(1, l.b.members.length)) {
        fail('outOfRange', `'${l.b.path}' has no dimension ${p.dim}`, { layer: l.layer, path: l.b.path });
      }
      return { l, p };
    });
    return {
      scope: keysScope(plans.map((x) => x.l)),
      label: `Edit ${plural(plans.length, 'Keyframe')}`,
      apply: () => {
        for (const { l, p } of plans) {
          const keepId = l.id.startsWith('@') ? undefined : l.id;
          const w: KeyWrite = {
            t: l.t,
            id: keepId ?? l.id,
            ...(p.value ? { value: p.value } : {}),
            ...(p.easing ? { easing: p.easing } : {}),
            ...(p.clearBezier ? { bezier: null } : p.bezier ? { bezier: toBezier(p.bezier)! } : {}),
            ...(p.continuous !== undefined ? { continuous: p.continuous } : {}),
            ...(p.roving !== undefined ? { roving: p.roving } : {}),
            ...(p.spatialInterp ? { spatialInterp: p.spatialInterp } : {}),
            ...(p.clearSpatial ? { spatialIn: null, spatialOut: null } : {}),
            ...(p.spatialIn.length > 0 ? { spatialIn: p.spatialIn } : {}),
            ...(p.spatialOut.length > 0 ? { spatialOut: p.spatialOut } : {}),
            ...(p.label !== undefined ? { label: p.label } : {}),
            ...(p.dim !== undefined && l.b.members.length > 1 ? { dim: p.dim } : {}),
          };
          if (l.b.special === 'maskPath' || l.b.dataTrack || l.b.members.length > 0) putKeys(l.layer, l.b, [w]);
          if (p.time !== undefined) retime(l.layer, l.b, new Map([[l.t, flicksToKeyTime(l.layer, l.b, p.time)]]));
        }
        const seen = new Set<string>();
        for (const { l } of plans) {
          if (seen.has(`${l.layer}|${l.b.path}`)) continue;
          seen.add(`${l.layer}|${l.b.path}`);
          reroveKeys(l.layer, l.b);
        }
        return {};
      },
    };
  },

  pasteKeyframes: (cmd, ctx) => {
    const { b } = bind(cmd.prop);
    if (!b.animatable) fail('notAnimatable', `'${b.path}' cannot take keyframes`, { path: b.path });
    checkTime(cmd.time);
    if (cmd.keys.length === 0) fail('invalidArgument', 'no keyframes given');
    for (const k of cmd.keys) checkValue(b, k.value);
    const t0 = Math.min(...cmd.keys.map((k) => k.time));
    const layer = cmd.prop.layer;
    const writes = cmd.keys.map((k: Keyframe) => {
      const t = flicksToKeyTime(layer, b, cmd.time + (k.time - t0));
      const existing = readKeys(layer, b).find((x) => x.t === t);
      const id = existing && !existing.id.startsWith('@') ? existing.id : newKeyId(b, ctx);
      const w: KeyWrite = {
        t, id, value: k.value, easing: k.easing, bezier: toBezier(k.bezier) ?? null,
        continuous: k.continuous, roving: k.roving, spatialInterp: k.spatialInterp,
        spatialIn: k.spatialIn.length > 0 ? k.spatialIn : null, spatialOut: k.spatialOut.length > 0 ? k.spatialOut : null,
        label: k.label,
        ...dimsWrite(k),
      };
      return w;
    });
    return {
      scope: propScope(newScope(), layer),
      label: `Paste ${plural(writes.length, 'Keyframe')}`,
      apply: () => {
        putKeys(layer, b, writes);
        reroveKeys(layer, b);
        return { ids: writes.map((w) => w.id) };
      },
    };
  },

  setKeyframes: (cmd, ctx) => {
    const { b } = bind(cmd.prop);
    if (!b.animatable) fail('notAnimatable', `'${b.path}' cannot take keyframes`, { path: b.path });
    if (cmd.keys.length === 0) fail('invalidArgument', 'no keyframes given (setAnimated removes them all)', { path: b.path });
    const layer = cmd.prop.layer;
    const known = new Set(readKeys(layer, b).map((k) => k.id).filter((id) => !id.startsWith('@')));
    const used = new Set<string>();
    const times = new Set<number>();
    const writes = cmd.keys.map((k: Keyframe) => {
      checkTime(k.time);
      checkValue(b, k.value);
      const t = flicksToKeyTime(layer, b, k.time);
      if (times.has(t)) fail('invalidArgument', `two keyframes of '${b.path}' land on one time`, { path: b.path });
      times.add(t);
      const id = known.has(k.id) && !used.has(k.id) ? k.id : newKeyId(b, ctx);
      used.add(id);
      const w: KeyWrite = {
        t, id, value: k.value, easing: k.easing, bezier: toBezier(k.bezier) ?? null,
        continuous: k.continuous, roving: k.roving, spatialInterp: k.spatialInterp,
        spatialIn: k.spatialIn.length > 0 ? k.spatialIn : null, spatialOut: k.spatialOut.length > 0 ? k.spatialOut : null,
        label: k.label,
        ...dimsWrite(k),
      };
      return w;
    });
    return {
      scope: propScope(newScope(), layer),
      label: `Set ${b.name} Keyframes`,
      apply: () => {
        clearKeys(layer, b);
        putKeys(layer, b, writes);
        reroveKeys(layer, b);
        return { ids: writes.map((w) => w.id) };
      },
    };
  },
};

/** A pasted / set key's per-dimension temporal fields as a KeyWrite's `dims`. */
function dimsWrite(k: Keyframe): Pick<KeyWrite, 'dims'> {
  if (k.dims.length === 0) return {};
  return { dims: k.dims.map((d) => ({ easing: d.easing, ...(d.bezier ? { bezier: toBezier(d.bezier)! } : {}), continuous: d.continuous })) };
}

/** Every keyframe of a property gone, nothing else touched (setKeyframes writes the new list next). */
function clearKeys(layer: string, b: PropBinding): void {
  if (b.special === 'maskPath') {
    graph.setMaskAnim(layer, undefined);
    return;
  }
  if (b.dataTrack) {
    defaultAnimation.setDataTrack(layer, b.dataTrack, null);
    return;
  }
  for (const m of b.members) defaultAnimation.setTrackKeyframes(layer, m, null);
}

/** A property's value at stored time `t` (keys sampled, else static). */
export function valueAt(layer: string, b: PropBinding, t: number): Value | undefined {
  if (b.special === 'maskPath') {
    const keys = readKeys(layer, b);
    const k = [...keys].filter((x) => x.t <= t).pop() ?? keys[0];
    return k?.value ?? readStatic(layer, b);
  }
  if (b.dataTrack) {
    const v = defaultAnimation.sampleData(layer, b.dataTrack, t);
    if (v === undefined) return readStatic(layer, b).kind === 'none' ? undefined : readStatic(layer, b);
    if (b.special === 'sourceText') return { kind: 'textDocument', value: { text: String(v), runs: [], paragraphs: [], orientation: 'horizontal', kerning: 'metrics' } };
    if (b.special === 'rig') return pinKeyToApi(v);
    if (b.special === 'fillStops') return fillStopsKeyToApi(graph.getNode(layer)!, v);
    return typeof v === 'string' ? { kind: 'string', value: v } : typeof v === 'number' ? { kind: 'scalar', value: v } : undefined;
  }
  if (b.members.length === 0) return readStatic(layer, b);
  const stat = readStatic(layer, b);
  const statNums = stat.kind === 'color' ? [stat.value.r, stat.value.g, stat.value.b, stat.value.a]
    : stat.kind === 'scalar' ? [stat.value] : stat.kind === 'vec2' ? [stat.value.x, stat.value.y] : stat.kind === 'vec3' ? [stat.value.x, stat.value.y, stat.value.z] : [];
  // statNums are API units (readStatic); samples are stored units → scaled per member.
  const nums = b.members.map((m, i) => {
    const kfs = defaultAnimation.getTrackKeyframes(layer, m);
    if (!kfs || kfs.length === 0) return statNums[i] ?? 0;
    const s = defaultAnimation.sample(layer, m, t);
    return s !== undefined && s !== null ? s * (b.colorBase ? 1 : apiUnitFactor(m)) : statNums[i] ?? 0;
  });
  return vectorValue(b.valueType, nums);
}

