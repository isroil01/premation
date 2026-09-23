/** Properties, expressions and keyframes (ENGINE_API.md §4.6). */

import { defaultAnimation, type Keyframe as TsKeyframe, type DataKeyframe } from '@motion/animation';
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
  flicksToKeyTime,
  keyTimeToFlicks,
  type PropBinding,
  type KeyWrite,
  type Catalog,
} from '../props';
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
  for (const m of b.members) {
    const kfs = defaultAnimation.getTrackKeyframes(layer, m);
    if (!kfs) continue;
    defaultAnimation.setTrackKeyframes(layer, m, moveList(kfs as TsKeyframe[]));
  }
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

/** Expressions live per member track (a vector's source is set on each dimension; each picks its component). */
function exprMembers(b: PropBinding): string[] {
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
        if (value && !b.dataTrack && b.special !== 'maskPath') writeStatic(layer, b, value);
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
    const members = exprMembers(b);
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
        const err = defaultAnimation.getExpressionError(layer, members[0]!);
        if (err) {
          // AE: a failing expression is stored, disabled.
          for (const m of members) defaultAnimation.setExpressionEnabled(layer, m, false);
          return { ok: false, diagnostics: [{ message: err, line: 0, column: 0 }] };
        }
        return { ok: true, diagnostics: [] };
      },
    };
  },

  setExpressionEnabled: (cmd) => {
    if (cmd.props.length === 0) fail('invalidArgument', 'no properties given');
    const plans = cmd.props.map((p) => {
      const { b } = bind(p);
      const members = exprMembers(b);
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
    if (!b.members.some((m) => defaultAnimation.isExpressionEnabled(layer, m))) fail('invalidArgument', `'${b.path}' has no enabled expression`, { path: b.path });
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
    const ids = frames.map(() => ctx.mintKeyId());
    return {
      scope: propScope(newScope(), layer),
      label: 'Convert Expression to Keyframes',
      apply: () => {
        const samples = frames.map((f) => {
          const t = flicksToKeyTime(layer, b, framesToFlicks(f, fps));
          return { t, nums: b.members.map((m) => defaultAnimation.sample(layer, m, t) ?? 0) };
        });
        for (const m of b.members) defaultAnimation.setExpressionState(layer, m, null);
        b.members.forEach((m, i) => {
          defaultAnimation.setTrackKeyframes(layer, m, samples.map((s, j) => ({ id: ids[j]!, t: s.t, value: s.nums[i]!, easing: 'linear' as const })));
        });
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
        for (const g of groups.values()) {
          const times = g.keys.map((k) => keyTimeToFlicks(g.layer, g.b, k.t));
          const lo = Math.min(...times);
          const hi = Math.max(...times);
          const map = new Map<number, number>();
          g.keys.forEach((k, i) => map.set(k.t, flicksToKeyTime(g.layer, g.b, lo + hi - times[i]!)));
          retime(g.layer, g.b, map);
        }
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
          };
          if (l.b.special === 'maskPath' || l.b.dataTrack || l.b.members.length > 0) putKeys(l.layer, l.b, [w]);
          if (p.time !== undefined) retime(l.layer, l.b, new Map([[l.t, flicksToKeyTime(l.layer, l.b, p.time)]]));
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
      };
      return w;
    });
    return {
      scope: propScope(newScope(), layer),
      label: `Paste ${plural(writes.length, 'Keyframe')}`,
      apply: () => {
        putKeys(layer, b, writes);
        return { ids: writes.map((w) => w.id) };
      },
    };
  },
};

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
    return typeof v === 'string' ? { kind: 'string', value: v } : typeof v === 'number' ? { kind: 'scalar', value: v } : undefined;
  }
  if (b.members.length === 0) return readStatic(layer, b);
  const stat = readStatic(layer, b);
  const statNums = stat.kind === 'color' ? [stat.value.r, stat.value.g, stat.value.b, stat.value.a]
    : stat.kind === 'scalar' ? [stat.value] : stat.kind === 'vec2' ? [stat.value.x, stat.value.y] : stat.kind === 'vec3' ? [stat.value.x, stat.value.y, stat.value.z] : [];
  const nums = b.members.map((m, i) => {
    const kfs = defaultAnimation.getTrackKeyframes(layer, m);
    if (!kfs || kfs.length === 0) return statNums[i] ?? 0;
    return defaultAnimation.sample(layer, m, t) ?? statNums[i] ?? 0;
  });
  return vectorValue(b.valueType, nums);
}

