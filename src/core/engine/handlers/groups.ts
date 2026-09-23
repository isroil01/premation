/**
 * Property groups (ENGINE_API.md §4.7): effects, masks, text animators and
 * selectors, layer styles, shape contents (path operators). Groups are
 * addressed by their stable ids; a group's keyframe tracks and expressions go
 * wherever the group goes (removed with it, copied with a copy, re-keyed when
 * index-addressed text animators move).
 */

import { defaultAnimation, type NodeAnimSnapshot } from '@motion/animation';
import type { PropRef, BezierPath } from '@motion/engine-api';
import {
  getNodeEffects,
  writeNodeEffects,
  effectDefFor,
  newInstanceParamsOf,
  type Effect,
  type EffectType,
} from '@core/effects/effects';
import { readNodeMask, readNodeMaskAnim, type MaskPath, type LayerMask, type MaskMode } from '@core/effects/mask';
import {
  readAnimatorData,
  writeAnimatorData,
  defaultAnimator,
  rekeyTextAnimatorTracks,
  type TextAnimatorData,
} from '@core/text/textAnimators';
import { defaultSelector, type SelectorKind, type SelectorData } from '@core/text/textSelectors';
import {
  getNodeLayerStyles,
  setLayerStyles,
  defaultGlassStyle,
  DEFAULT_DROP_SHADOW,
  DEFAULT_OUTER_GLOW,
  DEFAULT_INNER_SHADOW,
  DEFAULT_INNER_GLOW,
  DEFAULT_SATIN,
  DEFAULT_BEVEL,
  DEFAULT_COLOR_OVERLAY,
  DEFAULT_GRADIENT_OVERLAY,
  DEFAULT_STROKE_STYLE,
  type LayerStyles,
} from '@core/effects/layerStyles';
import { readPathOps, setPathOps, defaultPathOpOf, type PathOp, type PathOpType } from '@core/scene/pathOps';
import { listPresets, applyPreset } from '@core/animation/animationPresets';
import type { SceneNode } from '@core/types';
import { fail } from '../errors';
import { graph, requireLayer } from '../doc';
import { newScope, scopeLayer, type Scope } from '../state';
import { catalogFor, requireBinding, writeStatic, bezierToPoints } from '../props';
import { flicksToSeconds } from '../time';
import { compToKeyframeTime } from '@core/timeline/TimelineController';
import type { HandlerTable, HandlerCtx } from '../handler';
import { plural } from './common';

const STYLE_DEFAULTS: Record<string, () => unknown> = {
  glass: defaultGlassStyle,
  dropShadow: () => ({ ...DEFAULT_DROP_SHADOW }),
  outerGlow: () => ({ ...DEFAULT_OUTER_GLOW }),
  innerShadow: () => ({ ...DEFAULT_INNER_SHADOW }),
  innerGlow: () => ({ ...DEFAULT_INNER_GLOW }),
  satin: () => ({ ...DEFAULT_SATIN }),
  bevel: () => ({ ...DEFAULT_BEVEL }),
  colorOverlay: () => ({ ...DEFAULT_COLOR_OVERLAY }),
  gradientOverlay: () => ({ ...DEFAULT_GRADIENT_OVERLAY }),
  stroke: () => ({ ...DEFAULT_STROKE_STYLE }),
};

export const GROUP_TYPES: Array<{ parent: string; matchName: string; displayName: string; category: string }> = [
  { parent: 'text/animators', matchName: 'ADBE Text Animator', displayName: 'Animator', category: 'text' },
  { parent: 'text/animators/*/selectors', matchName: 'ADBE Text Selector', displayName: 'Range Selector', category: 'text' },
  { parent: 'text/animators/*/selectors', matchName: 'ADBE Text Wiggly Selector', displayName: 'Wiggly Selector', category: 'text' },
  { parent: 'text/animators/*/selectors', matchName: 'ADBE Text Expressible Selector', displayName: 'Expression Selector', category: 'text' },
  ...Object.keys(STYLE_DEFAULTS).map((k) => ({ parent: 'styles', matchName: `style:${k}`, displayName: k, category: 'styles' })),
  ...(['zigzag', 'roundCorners', 'pucker', 'twist', 'offset', 'roughen', 'trim', 'repeater', 'wiggleTransform'] as const)
    .map((t) => ({ parent: 'contents', matchName: `pathop:${t}`, displayName: t, category: 'contents' })),
];

// ── Group addressing ─────────────────────────────────────────────────

type GroupRef =
  | { kind: 'effect'; layer: string; id: string }
  | { kind: 'mask'; layer: string; id: string }
  | { kind: 'animator'; layer: string; id: string; index: number }
  | { kind: 'selector'; layer: string; animator: string; animIndex: number; id: string; index: number }
  | { kind: 'style'; layer: string; id: string }
  | { kind: 'pathop'; layer: string; id: string };

function resolveGroup(ref: PropRef): GroupRef {
  const node = requireLayer(ref.layer);
  const seg = ref.path.split('/');
  const nf = (): never => fail('notFound', `layer '${ref.layer}' has no group '${ref.path}'`, { layer: ref.layer, path: ref.path });
  if (seg[0] === 'effects' && seg.length === 2) {
    if (!getNodeEffects(ref.layer).some((e) => e.id === seg[1])) nf();
    return { kind: 'effect', layer: ref.layer, id: seg[1]! };
  }
  if (seg[0] === 'masks' && seg.length === 2) {
    if (!readNodeMask(node)?.paths.some((p) => p.id === seg[1])) nf();
    return { kind: 'mask', layer: ref.layer, id: seg[1]! };
  }
  if (seg[0] === 'text' && seg[1] === 'animators' && seg.length === 3) {
    const index = readAnimatorData(node).findIndex((a) => a.id === seg[2]);
    if (index < 0) nf();
    return { kind: 'animator', layer: ref.layer, id: seg[2]!, index };
  }
  if (seg[0] === 'text' && seg[1] === 'animators' && seg[3] === 'selectors' && seg.length === 5) {
    const data = readAnimatorData(node);
    const animIndex = data.findIndex((a) => a.id === seg[2]);
    const index = animIndex < 0 ? -1 : (data[animIndex]!.selectors ?? []).findIndex((s) => s.id === seg[4]);
    if (index < 0) nf();
    return { kind: 'selector', layer: ref.layer, animator: seg[2]!, animIndex, id: seg[4]!, index };
  }
  if (seg[0] === 'styles' && seg.length === 2) {
    if (!(getNodeLayerStyles(ref.layer) as Record<string, unknown>)[seg[1]!]) nf();
    return { kind: 'style', layer: ref.layer, id: seg[1]! };
  }
  if (seg[0] === 'contents' && seg.length === 2) {
    if (!readPathOps(node).some((o) => o.id === seg[1])) nf();
    return { kind: 'pathop', layer: ref.layer, id: seg[1]! };
  }
  return nf();
}

function groupPath(g: GroupRef): string {
  switch (g.kind) {
    case 'effect': return `effects/${g.id}`;
    case 'mask': return `masks/${g.id}`;
    case 'animator': return `text/animators/${g.id}`;
    case 'selector': return `text/animators/${g.animator}/selectors/${g.id}`;
    case 'style': return `styles/${g.id}`;
    case 'pathop': return `contents/${g.id}`;
  }
}

/** Track-name prefix a group's scalar tracks live under (null = index-addressed text animators). */
function trackPrefix(g: GroupRef): string | null {
  switch (g.kind) {
    case 'effect': return `effect.${g.id}`;
    case 'mask': return `mask.${g.id}.`;
    case 'style': return `effect.layerstyle:${g.id}.`;
    case 'pathop': return `pathop.${g.id}.`;
    default: return null;
  }
}

function matchesPrefix(prop: string, prefix: string): boolean {
  // `effect.<id>` alone is a legacy primary-param track; `effect.<id>.<p>` the rest.
  if (prefix.endsWith('.')) return prop.startsWith(prefix);
  return prop === prefix || prop.startsWith(`${prefix}.`);
}

/** Drop (or rename onto `to`) a group's tracks and expressions on a layer. */
function moveGroupTracks(layer: string, prefix: string, to: string | null): void {
  const snap = defaultAnimation.snapshotNode(layer);
  if (!snap) return;
  const pick = <V>(section: Record<string, V>): { keep: Record<string, V>; moved: Record<string, V> } => {
    const keep: Record<string, V> = {};
    const moved: Record<string, V> = {};
    for (const [k, v] of Object.entries(section)) {
      if (matchesPrefix(k, prefix)) {
        if (to !== null) moved[to + k.slice(prefix.length)] = v;
      } else keep[k] = v;
    }
    return { keep, moved };
  };
  const t = pick(snap.tracks);
  const e = pick(snap.expressions);
  const d = pick(snap.data);
  defaultAnimation.restoreNode(layer, {
    tracks: { ...t.keep, ...t.moved },
    expressions: { ...e.keep, ...e.moved },
    data: { ...d.keep, ...Object.fromEntries(Object.entries(d.moved).map(([k, v]) => [k, { ...v, prop: k }])) },
  });
}

/** Copy a group's tracks (renamed onto `to`) onto `toLayer`, keyframe ids re-minted. */
function copyGroupTracks(layer: string, prefix: string, to: string, toLayer: string, ctx: HandlerCtx): void {
  const snap = defaultAnimation.snapshotNode(layer);
  if (!snap) return;
  const target: NodeAnimSnapshot = defaultAnimation.snapshotNode(toLayer) ?? { tracks: {}, expressions: {}, data: {} };
  const byOld = new Map<string, string>();
  const remint = (id: string | undefined): string | undefined => {
    if (!id) return undefined;
    const f = byOld.get(id) ?? ctx.mintKeyId();
    byOld.set(id, f);
    return f;
  };
  for (const [k, kfs] of Object.entries(snap.tracks)) {
    if (!matchesPrefix(k, prefix)) continue;
    target.tracks[to + k.slice(prefix.length)] = kfs.map((kf) => ({ ...kf, ...(kf.id ? { id: remint(kf.id)! } : {}) }));
  }
  for (const [k, ex] of Object.entries(snap.expressions)) {
    if (matchesPrefix(k, prefix)) target.expressions[to + k.slice(prefix.length)] = { ...ex };
  }
  for (const [k, dt] of Object.entries(snap.data)) {
    if (!matchesPrefix(k, prefix)) continue;
    const nk = to + k.slice(prefix.length);
    target.data[nk] = { ...dt, nodeId: toLayer, prop: nk, keyframes: dt.keyframes.map((kf) => ({ ...kf, ...(kf.id ? { id: remint(kf.id)! } : {}) })) };
  }
  defaultAnimation.restoreNode(toLayer, target);
}

function writeMasks(layer: string, fn: (paths: MaskPath[]) => MaskPath[]): void {
  const node = graph.getNode(layer)!;
  const m: LayerMask = readNodeMask(node) ?? { paths: [] };
  const paths = fn(m.paths.map((p) => ({ ...p })));
  graph.setMask(layer, paths.length > 0 ? { paths } : undefined);
  const anim = readNodeMaskAnim(node);
  if (anim.length > 0) graph.setMaskAnim(layer, anim.map((k) => ({ ...k, mask: { paths: fn(k.mask.paths.map((p) => ({ ...p }))) } })));
}

function withAnimators(layer: string, fn: (a: TextAnimatorData[]) => TextAnimatorData[]): void {
  const node = graph.getNode(layer)!;
  writeAnimatorData(layer, fn(readAnimatorData(node).map((a) => ({ ...a }))));
}

function move<T>(list: T[], from: number, to: number): T[] {
  const out = list.slice();
  const [x] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(to, out.length)), 0, x!);
  return out;
}

function layerScopeOf(ids: Iterable<string>): Scope {
  const s = newScope();
  for (const id of ids) scopeLayer(s, id);
  return s;
}

function textNodeOrFail(layer: string): SceneNode {
  const node = requireLayer(layer);
  if (!node.components.some((c) => c.type === 'Text')) fail('invalidArgument', `layer '${layer}' is not a text layer`, { layer });
  return node;
}

const SELECTOR_KIND: Record<string, SelectorKind> = {
  'ADBE Text Selector': 'range',
  'ADBE Text Wiggly Selector': 'wiggly',
  'ADBE Text Expressible Selector': 'expression',
};

export const groupHandlers: HandlerTable = {
  addEffect: (cmd, ctx) => {
    if (cmd.layers.length === 0) fail('invalidArgument', 'no layers given');
    const def = effectDefFor(cmd.effect);
    if (!def) fail('notFound', `no effect '${cmd.effect}'`, { detail: JSON.stringify({ effect: cmd.effect }) });
    const ids = cmd.layers.map((layer) => {
      requireLayer(layer);
      const count = getNodeEffects(layer).length;
      if (cmd.index !== undefined && cmd.index > count) fail('outOfRange', `index ${cmd.index} is past the ${count} effects of '${layer}'`, { layer });
      return ctx.mintGroupId('fx_', (id) => getNodeEffects(layer).some((e) => e.id === id));
    });
    return {
      scope: layerScopeOf(cmd.layers),
      label: def.label,
      apply: () => {
        cmd.layers.forEach((layer, i) => {
          const effects = getNodeEffects(layer);
          const at = cmd.index ?? effects.length;
          const next = effects.slice();
          next.splice(at, 0, { id: ids[i]!, type: cmd.effect as EffectType, params: newInstanceParamsOf(def) });
          writeNodeEffects(layer, next);
          if (cmd.params.length > 0) {
            const cat = catalogFor(layer);
            for (const p of cmd.params) writeStatic(layer, requireBinding(cat, `effects/${ids[i]}/${p.path}`), p.value);
          }
        });
        return { groups: ids.map((id) => `effects/${id}`) };
      },
    };
  },

  addMask: (cmd, ctx) => {
    const node = requireLayer(cmd.layer);
    const count = readNodeMask(node)?.paths.length ?? 0;
    if (cmd.index !== undefined && cmd.index > count) fail('outOfRange', `index ${cmd.index} is past the ${count} masks`);
    const points = bezierToPoints(cmd.path);
    const id = ctx.mintGroupId('mask_', (x) => !!readNodeMask(node)?.paths.some((p) => p.id === x));
    const mask: MaskPath = {
      id, mode: cmd.mode as MaskMode, closed: cmd.path.closed, points, feather: 0, opacity: 1, expansion: 0, inverted: cmd.inverted,
      ...(cmd.name ? { name: cmd.name } : {}),
    };
    return {
      scope: layerScopeOf([cmd.layer]),
      label: 'New Mask',
      apply: () => {
        writeMasks(cmd.layer, (paths) => {
          const next = paths.slice();
          next.splice(cmd.index ?? next.length, 0, { ...mask, points: mask.points.map((p) => ({ ...p })) });
          return next;
        });
        return { groups: [`masks/${id}`] };
      },
    };
  },

  addPropertyGroup: (cmd, ctx) => {
    const node = requireLayer(cmd.layer);
    const layer = cmd.layer;
    let run: () => string;
    const parent = cmd.parent;
    if (parent === 'text/animators' && cmd.matchName === 'ADBE Text Animator') {
      textNodeOrFail(layer);
      const count = readAnimatorData(node).length;
      const at = cmd.index ?? count;
      if (at > count) fail('outOfRange', `index ${at} is past the ${count} animators`);
      const id = ctx.mintGroupId('anim_', (x) => readAnimatorData(node).some((a) => a.id === x));
      const selId = ctx.mintGroupId('sel_', () => false);
      run = () => {
        const a = defaultAnimator();
        a.id = id;
        a.selectors = (a.selectors ?? []).map((s: SelectorData) => ({ ...s, id: selId }));
        if (cmd.name) a.name = cmd.name;
        // Animators after the insert point move up one slot, and their tracks with them.
        rekeyTextAnimatorTracks(layer, (i) => (i >= at ? i + 1 : i));
        withAnimators(layer, (list) => { const n = list.slice(); n.splice(at, 0, a); return n; });
        return `text/animators/${id}`;
      };
    } else if (/^text\/animators\/[^/]+\/selectors$/.test(parent) && SELECTOR_KIND[cmd.matchName]) {
      textNodeOrFail(layer);
      const aid = parent.split('/')[2]!;
      const data = readAnimatorData(node);
      const ai = data.findIndex((a) => a.id === aid);
      if (ai < 0) fail('notFound', `no animator '${aid}'`, { layer, path: parent });
      const count = data[ai]!.selectors?.length ?? 0;
      const at = cmd.index ?? count;
      if (at > count) fail('outOfRange', `index ${at} is past the ${count} selectors`);
      const id = ctx.mintGroupId('sel_', () => false);
      run = () => {
        const s = { ...defaultSelector(SELECTOR_KIND[cmd.matchName]!), id } as SelectorData;
        rekeyTextAnimatorTracks(layer, (i) => i, (a, j) => (a === ai && j >= at ? j + 1 : j));
        withAnimators(layer, (list) => list.map((a, i) => {
          if (i !== ai) return a;
          const sels = [...(a.selectors ?? [])];
          sels.splice(at, 0, s);
          return { ...a, selectors: sels };
        }));
        return `text/animators/${aid}/selectors/${id}`;
      };
    } else if (parent === 'styles' && cmd.matchName.startsWith('style:')) {
      const key = cmd.matchName.slice(6);
      const make = STYLE_DEFAULTS[key];
      if (!make) fail('notFound', `no layer style '${key}'`);
      if ((getNodeLayerStyles(layer) as Record<string, unknown>)[key]) fail('conflict', `layer '${layer}' already has a ${key} style`, { layer });
      run = () => {
        const styles = getNodeLayerStyles(layer);
        setLayerStyles(layer, { ...styles, [key]: { ...(make() as object), enabled: true } } as LayerStyles);
        return `styles/${key}`;
      };
    } else if (parent === 'contents' && cmd.matchName.startsWith('pathop:')) {
      const type = cmd.matchName.slice(7) as PathOpType;
      const ops = readPathOps(node);
      const at = cmd.index ?? ops.length;
      if (at > ops.length) fail('outOfRange', `index ${at} is past the ${ops.length} operators`);
      let proto: PathOp;
      try {
        proto = defaultPathOpOf(type);
      } catch {
        fail('notFound', `no shape operator '${type}'`);
      }
      const id = ctx.mintGroupId('op_', (x) => ops.some((o) => o.id === x));
      run = () => {
        const next = readPathOps(graph.getNode(layer)!).slice();
        next.splice(at, 0, { ...proto, id });
        setPathOps(layer, next);
        return `contents/${id}`;
      };
    } else {
      fail('unsupported', `'${cmd.matchName}' under '${parent}' is not a group this engine can add (listGroupTypes lists what it can)`, { path: parent });
    }
    return {
      scope: layerScopeOf([layer]),
      label: `Add ${cmd.matchName}`,
      apply: () => {
        const path = run();
        if (cmd.init.length > 0) {
          const cat = catalogFor(layer);
          for (const init of cmd.init) writeStatic(layer, requireBinding(cat, `${path}/${init.path}`), init.value);
        }
        return { groups: [path] };
      },
    };
  },

  removePropertyGroups: (cmd) => {
    if (cmd.groups.length === 0) fail('invalidArgument', 'no groups given');
    const refs = cmd.groups.map(resolveGroup);
    // Remove text animators/selectors highest index first so earlier indices stay valid.
    refs.sort((a, b) => ('index' in b ? b.index : 0) - ('index' in a ? a.index : 0));
    return {
      scope: layerScopeOf(refs.map((r) => r.layer)),
      label: `Remove ${plural(refs.length, 'Group')}`,
      apply: () => {
        for (const r of refs) removeGroup(r);
        return {};
      },
    };
  },

  movePropertyGroup: (cmd) => {
    const r = resolveGroup(cmd.group);
    return {
      scope: layerScopeOf([r.layer]),
      label: 'Move Group',
      apply: () => {
        const node = graph.getNode(r.layer)!;
        switch (r.kind) {
          case 'effect': {
            const list = getNodeEffects(r.layer);
            if (cmd.toIndex >= list.length) fail('outOfRange', 'toIndex past the end');
            writeNodeEffects(r.layer, move(list, list.findIndex((e) => e.id === r.id), cmd.toIndex));
            break;
          }
          case 'mask': {
            const n = readNodeMask(node)?.paths.length ?? 0;
            if (cmd.toIndex >= n) fail('outOfRange', 'toIndex past the end');
            writeMasks(r.layer, (paths) => move(paths, paths.findIndex((p) => p.id === r.id), cmd.toIndex));
            break;
          }
          case 'pathop': {
            const ops = readPathOps(node);
            if (cmd.toIndex >= ops.length) fail('outOfRange', 'toIndex past the end');
            setPathOps(r.layer, move(ops, ops.findIndex((o) => o.id === r.id), cmd.toIndex));
            break;
          }
          case 'animator': {
            const n = readAnimatorData(node).length;
            if (cmd.toIndex >= n) fail('outOfRange', 'toIndex past the end');
            const order = move([...Array(n).keys()], r.index, cmd.toIndex);
            rekeyTextAnimatorTracks(r.layer, (i) => order.indexOf(i));
            withAnimators(r.layer, (list) => move(list, r.index, cmd.toIndex));
            break;
          }
          case 'selector': {
            const n = readAnimatorData(node)[r.animIndex]!.selectors?.length ?? 0;
            if (cmd.toIndex >= n) fail('outOfRange', 'toIndex past the end');
            const order = move([...Array(n).keys()], r.index, cmd.toIndex);
            rekeyTextAnimatorTracks(r.layer, (i) => i, (a, j) => (a === r.animIndex ? order.indexOf(j) : j));
            withAnimators(r.layer, (list) => list.map((a, i) => (i === r.animIndex ? { ...a, selectors: move(a.selectors ?? [], r.index, cmd.toIndex) } : a)));
            break;
          }
          case 'style':
            fail('unsupported', 'layer styles have a fixed order');
        }
        return {};
      },
    };
  },

  duplicatePropertyGroups: (cmd, ctx) => {
    if (cmd.groups.length === 0) fail('invalidArgument', 'no groups given');
    const refs = cmd.groups.map(resolveGroup);
    for (const r of refs) if (r.kind === 'style') fail('unsupported', 'a layer has at most one style of each kind');
    const plans = refs.map((r) => ({ r, newId: mintFor(r, r.layer, ctx) }));
    return {
      scope: layerScopeOf(refs.map((r) => r.layer)),
      label: `Duplicate ${plural(refs.length, 'Group')}`,
      apply: () => ({ groups: plans.map((p) => copyGroup(p.r, p.r.layer, p.newId, ctx, true)) }),
    };
  },

  copyPropertyGroups: (cmd, ctx) => {
    if (cmd.groups.length === 0 || cmd.toLayers.length === 0) fail('invalidArgument', 'groups and target layers are required');
    const refs = cmd.groups.map(resolveGroup);
    for (const r of refs) if (r.kind === 'animator' || r.kind === 'selector') fail('unsupported', 'text animators are copied with their layer in this engine');
    for (const l of cmd.toLayers) requireLayer(l);
    const plans: Array<{ r: GroupRef; to: string; newId: string }> = [];
    for (const to of cmd.toLayers) for (const r of refs) {
      if (r.kind === 'style' && (getNodeLayerStyles(to) as Record<string, unknown>)[r.id]) fail('conflict', `layer '${to}' already has a ${r.id} style`, { layer: to });
      plans.push({ r, to, newId: mintFor(r, to, ctx) });
    }
    return {
      scope: layerScopeOf([...refs.map((r) => r.layer), ...cmd.toLayers]),
      label: `Paste ${plural(plans.length, 'Group')}`,
      apply: () => ({ groups: plans.map((p) => copyGroup(p.r, p.to, p.newId, ctx, false)) }),
    };
  },

  setGroupEnabled: (cmd) => {
    if (cmd.groups.length === 0) fail('invalidArgument', 'no groups given');
    const refs = cmd.groups.map(resolveGroup);
    return {
      scope: layerScopeOf(refs.map((r) => r.layer)),
      label: cmd.enabled ? 'Enable' : 'Disable',
      apply: () => {
        for (const r of refs) setEnabled(r, cmd.enabled);
        return {};
      },
    };
  },

  renamePropertyGroup: (cmd) => {
    const r = resolveGroup(cmd.group);
    if (r.kind === 'style' || r.kind === 'pathop') fail('unsupported', `'${groupPath(r)}' cannot be renamed in this engine`);
    return {
      scope: layerScopeOf([r.layer]),
      label: 'Rename Group',
      apply: () => {
        const name = cmd.name.trim() === '' ? undefined : cmd.name;
        if (r.kind === 'effect') writeNodeEffects(r.layer, getNodeEffects(r.layer).map((e) => (e.id === r.id ? withName(e, name) : e)));
        else if (r.kind === 'mask') writeMasks(r.layer, (paths) => paths.map((p) => (p.id === r.id ? withName(p, name) : p)));
        else if (r.kind === 'animator') withAnimators(r.layer, (list) => list.map((a) => (a.id === r.id ? withName(a, name) : a)));
        else withAnimators(r.layer, (list) => list.map((a, i) => (i === r.animIndex ? { ...a, selectors: (a.selectors ?? []).map((s) => (s.id === r.id ? withName(s, name) : s)) } : a)));
        return {};
      },
    };
  },

  applyPreset: (cmd, ctx) => {
    if (cmd.layers.length === 0) fail('invalidArgument', 'no layers given');
    const preset = listPresets().find((p) => p.name === cmd.preset || (p as { id?: string }).id === cmd.preset);
    if (!preset) fail('notFound', `no preset '${cmd.preset}'`);
    for (const l of cmd.layers) requireLayer(l);
    return {
      scope: layerScopeOf(cmd.layers),
      label: `Apply ${preset.name}`,
      apply: () => {
        const added: string[] = [];
        for (const layer of cmd.layers) {
          const beforeFx = new Set(getNodeEffects(layer).map((e) => e.id));
          const beforeAnim = new Set(readAnimatorData(graph.getNode(layer)!).map((a) => a.id));
          // `time` is composition time (the API's axis); the preset's keys are
          // written on the layer's keyframe axis (start offset, stretch, remap),
          // like AE placing a preset's first key at the CTI on any layer.
          const at = compToKeyframeTime(layer, flicksToSeconds(cmd.time));
          if (!applyPreset(preset, layer, at)) fail('invalidArgument', `preset '${preset.name}' does not apply to layer '${layer}'`, { layer });
          // The preset code mints clock-based ids; replace them with engine ids so replay is exact.
          for (const e of getNodeEffects(layer)) {
            if (beforeFx.has(e.id)) continue;
            const id = ctx.mintGroupId('fx_', (x) => getNodeEffects(layer).some((y) => y.id === x));
            moveGroupTracks(layer, `effect.${e.id}`, `effect.${id}`);
            writeNodeEffects(layer, getNodeEffects(layer).map((y) => (y.id === e.id ? { ...y, id } : y)));
            added.push(`effects/${id}`);
          }
          withAnimators(layer, (list) => list.map((a) => {
            if (beforeAnim.has(a.id)) return a;
            const id = ctx.mintGroupId('anim_', () => false);
            added.push(`text/animators/${id}`);
            return { ...a, id, selectors: (a.selectors ?? []).map((s) => ({ ...s, id: ctx.mintGroupId('sel_', () => false) })) };
          }));
        }
        return { groups: added };
      },
    };
  },

  invokeEffectAction: (cmd) => {
    resolveGroup(cmd.group);
    return fail('unsupported', 'effect action buttons belong to native SDK plugins (G1); the JavaScript plugin system is not ported (plan §5 G2)');
  },
};

function withName<T extends object>(o: T, name: string | undefined): T {
  const out = { ...o } as T & { name?: string };
  if (name === undefined) delete out.name;
  else out.name = name;
  return out;
}

function mintFor(r: GroupRef, layer: string, ctx: HandlerCtx): string {
  switch (r.kind) {
    case 'effect': return ctx.mintGroupId('fx_', (x) => getNodeEffects(layer).some((e) => e.id === x));
    case 'mask': return ctx.mintGroupId('mask_', (x) => !!readNodeMask(graph.getNode(layer)!)?.paths.some((p) => p.id === x));
    case 'pathop': return ctx.mintGroupId('op_', (x) => readPathOps(graph.getNode(layer)!).some((o) => o.id === x));
    case 'animator': return ctx.mintGroupId('anim_', () => false);
    case 'selector': return ctx.mintGroupId('sel_', () => false);
    case 'style': return r.id;
  }
}

function removeGroup(r: GroupRef): void {
  switch (r.kind) {
    case 'effect':
      writeNodeEffects(r.layer, getNodeEffects(r.layer).filter((e) => e.id !== r.id));
      moveGroupTracks(r.layer, trackPrefix(r)!, null);
      return;
    case 'mask':
      writeMasks(r.layer, (paths) => paths.filter((p) => p.id !== r.id));
      moveGroupTracks(r.layer, trackPrefix(r)!, null);
      return;
    case 'style': {
      const styles = { ...(getNodeLayerStyles(r.layer) as Record<string, unknown>) };
      delete styles[r.id];
      setLayerStyles(r.layer, styles as LayerStyles);
      moveGroupTracks(r.layer, trackPrefix(r)!, null);
      return;
    }
    case 'pathop':
      setPathOps(r.layer, readPathOps(graph.getNode(r.layer)!).filter((o) => o.id !== r.id));
      moveGroupTracks(r.layer, trackPrefix(r)!, null);
      return;
    case 'animator': {
      const idx = readAnimatorData(graph.getNode(r.layer)!).findIndex((a) => a.id === r.id);
      rekeyTextAnimatorTracks(r.layer, (i) => (i === idx ? null : i > idx ? i - 1 : i));
      withAnimators(r.layer, (list) => list.filter((a) => a.id !== r.id));
      return;
    }
    case 'selector': {
      const data = readAnimatorData(graph.getNode(r.layer)!);
      const ai = data.findIndex((a) => a.id === r.animator);
      const si = (data[ai]?.selectors ?? []).findIndex((s) => s.id === r.id);
      if ((data[ai]?.selectors?.length ?? 0) <= 1) fail('invalidArgument', 'an animator keeps at least one selector');
      rekeyTextAnimatorTracks(r.layer, (i) => i, (a, j) => (a !== ai ? j : j === si ? null : j > si ? j - 1 : j));
      withAnimators(r.layer, (list) => list.map((a, i) => (i === ai ? { ...a, selectors: (a.selectors ?? []).filter((s) => s.id !== r.id) } : a)));
      return;
    }
  }
}

function setEnabled(r: GroupRef, on: boolean): void {
  switch (r.kind) {
    case 'effect':
      writeNodeEffects(r.layer, getNodeEffects(r.layer).map((e) => {
        if (e.id !== r.id) return e;
        const { enabled: _drop, ...rest } = e;
        return on ? rest : { ...rest, enabled: false };
      }));
      return;
    case 'mask':
      // A mask has no enable bit of its own: off is mode None, remembering the mode it had.
      writeMasks(r.layer, (paths) => paths.map((p) => {
        if (p.id !== r.id) return p;
        const q = p as MaskPath & { __prevMode?: MaskMode };
        if (!on && q.mode !== 'none') return { ...q, __prevMode: q.mode, mode: 'none' as MaskMode };
        if (on && q.mode === 'none') {
          const { __prevMode, ...rest } = q;
          return { ...rest, mode: __prevMode ?? 'add' };
        }
        return p;
      }));
      return;
    case 'style': {
      const styles = getNodeLayerStyles(r.layer) as Record<string, Record<string, unknown> | undefined>;
      setLayerStyles(r.layer, { ...styles, [r.id]: { ...styles[r.id], enabled: on } } as LayerStyles);
      return;
    }
    case 'pathop':
      setPathOps(r.layer, readPathOps(graph.getNode(r.layer)!).map((o) => (o.id === r.id ? ({ ...o, enabled: on } as PathOp) : o)));
      return;
    case 'animator':
      withAnimators(r.layer, (list) => list.map((a) => (a.id === r.id ? { ...a, enabled: on } : a)));
      return;
    case 'selector':
      withAnimators(r.layer, (list) => list.map((a, i) => (i === r.animIndex ? { ...a, selectors: (a.selectors ?? []).map((s) => (s.id === r.id ? { ...s, enabled: on } as SelectorData : s)) } : a)));
      return;
  }
}

/** Copy one group onto `to` (same layer = duplicate right after the original). Returns the new path. */
function copyGroup(r: GroupRef, to: string, newId: string, ctx: HandlerCtx, afterOriginal: boolean): string {
  switch (r.kind) {
    case 'effect': {
      const src = getNodeEffects(r.layer).find((e) => e.id === r.id)!;
      const list = getNodeEffects(to);
      const at = afterOriginal ? list.findIndex((e) => e.id === r.id) + 1 : list.length;
      const next = list.slice();
      next.splice(at, 0, { ...structuredClone(src), id: newId } as Effect);
      writeNodeEffects(to, next);
      copyGroupTracks(r.layer, `effect.${r.id}`, `effect.${newId}`, to, ctx);
      return `effects/${newId}`;
    }
    case 'mask': {
      const src = readNodeMask(graph.getNode(r.layer)!)!.paths.find((p) => p.id === r.id)!;
      writeMasks(to, (paths) => {
        const at = afterOriginal ? paths.findIndex((p) => p.id === r.id) + 1 : paths.length;
        const next = paths.slice();
        next.splice(at, 0, { ...structuredClone(src), id: newId });
        return next;
      });
      copyGroupTracks(r.layer, `mask.${r.id}.`, `mask.${newId}.`, to, ctx);
      return `masks/${newId}`;
    }
    case 'style': {
      const src = (getNodeLayerStyles(r.layer) as Record<string, unknown>)[r.id];
      setLayerStyles(to, { ...getNodeLayerStyles(to), [r.id]: structuredClone(src) } as LayerStyles);
      copyGroupTracks(r.layer, `effect.layerstyle:${r.id}.`, `effect.layerstyle:${r.id}.`, to, ctx);
      return `styles/${r.id}`;
    }
    case 'pathop': {
      const src = readPathOps(graph.getNode(r.layer)!).find((o) => o.id === r.id)!;
      const ops = readPathOps(graph.getNode(to)!);
      const at = afterOriginal ? ops.findIndex((o) => o.id === r.id) + 1 : ops.length;
      const next = ops.slice();
      next.splice(at, 0, { ...structuredClone(src), id: newId });
      setPathOps(to, next);
      copyGroupTracks(r.layer, `pathop.${r.id}.`, `pathop.${newId}.`, to, ctx);
      return `contents/${newId}`;
    }
    case 'animator': {
      const data = readAnimatorData(graph.getNode(r.layer)!);
      const idx = data.findIndex((a) => a.id === r.id);
      const at = idx + 1;
      const copy = { ...structuredClone(data[idx]!), id: newId, selectors: (data[idx]!.selectors ?? []).map((s) => ({ ...structuredClone(s), id: ctx.mintGroupId('sel_', () => false) })) };
      rekeyTextAnimatorTracks(r.layer, (i) => (i >= at ? i + 1 : i));
      // Copy the original's tracks into the new slot.
      const snap = defaultAnimation.snapshotNode(r.layer);
      if (snap) {
        const add = (section: Record<string, unknown>): void => {
          for (const [k, v] of Object.entries({ ...section })) {
            const m = /^ta\.(\d+)\.(.+)$/.exec(k);
            if (m && Number(m[1]) === idx) section[`ta.${at}.${m[2]}`] = structuredClone(v);
          }
        };
        add(snap.tracks as Record<string, unknown>);
        add(snap.expressions as Record<string, unknown>);
        defaultAnimation.restoreNode(r.layer, snap);
      }
      withAnimators(r.layer, (list) => { const n = list.slice(); n.splice(at, 0, copy); return n; });
      return `text/animators/${newId}`;
    }
    case 'selector':
      return fail('unsupported', 'duplicate the animator to copy its selectors');
  }
}

export type { BezierPath };
