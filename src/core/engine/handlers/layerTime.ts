/**
 * Layer time — the timeline bars (ENGINE_API.md §4.5).
 *
 * Every bar edit reduces to writing clip geometry (start / duration / sourceIn,
 * in frames of the owning comp) through `applyClipGeometry`, which is exact and
 * silent; the engine's captured `clips:<comp>` part is the inverse. A legacy
 * node with several bars is treated as one layer spanning them: the in edge is
 * the first bar's, the out edge the last bar's, and a move moves them all.
 */

import { defaultAnimation } from '@motion/animation';
import type { ClipGeometry } from '@core/commands/snapshotSharing';
import { cloneLayerNode } from '@core/scene/cloneLayerNode';
import { deleteLayerNode } from '@core/scene/deleteLayerNode';
import { getNodeLayerTime, updateNodeLayerTime } from '@core/scene/layerTime';
import { setRetimeMode } from '@core/animation/retimeCommands';
import { readRetimeMode, SPEED_PROP, REMAP_PROP, clampSpeedPercent } from '@core/animation/retime';
import { compToKeyframeTime } from '@core/timeline/TimelineController';
import { getTimelineController } from '@core/timeline/TimelineController';
import { fail } from '../errors';
import { graph, compOfLayer, requireLayer, requireComp, layerIdsOfComp } from '../doc';
import { documentScope, type Scope } from '../state';
import { compFps, flicksToFrames, checkTime, flicksToSeconds } from '../time';
import { compDurationFrames } from '../model';
import type { HandlerTable, HandlerCtx } from '../handler';
import { ensureTimeline, geomsOf, writeGeoms, layersScope, requireLayersInOneComp, plural, remintKeyIds } from './common';

type Geo = ClipGeometry;

function span(g: Geo[]): { in: number; out: number } {
  return { in: g[0]!.start, out: g[g.length - 1]!.start + g[g.length - 1]!.duration };
}

function barsOrFail(layer: string, comp: string): Geo[] {
  const g = geomsOf(layer, comp);
  if (g.length === 0) fail('invalidArgument', `layer '${layer}' has no timeline bar (a group member follows its group's bar)`, { layer });
  return g;
}

function validBar(layer: string, g: Geo): void {
  if (g.duration < 1) fail('outOfRange', `layer '${layer}' would be shorter than one frame`, { layer });
  if (g.sourceIn < 0) fail('outOfRange', `layer '${layer}' would start before its source`, { layer });
  if (g.sourceDuration !== null && g.sourceIn + g.duration > g.sourceDuration) {
    fail('outOfRange', `layer '${layer}' would run past the end of its footage`, { layer });
  }
}

function shift(g: Geo[], delta: number): Geo[] {
  return g.map((b) => ({ ...b, start: b.start + delta }));
}

function trimIn(g: Geo[], to: number, keepPlace = false): Geo[] {
  const first = g[0]!;
  const d = to - first.start;
  const next = { ...first, sourceIn: first.sourceIn + d, duration: first.duration - d, start: keepPlace ? first.start : to };
  return [next, ...g.slice(1)];
}

function trimOut(g: Geo[], to: number): Geo[] {
  const last = g[g.length - 1]!;
  return [...g.slice(0, -1), { ...last, duration: to - last.start }];
}

/** Every other layer of the comp whose in point is at/after `from` (ripple set). */
function laterLayers(comp: string, from: number, exclude: Set<string>): string[] {
  return layerIdsOfComp(comp).filter((id) => {
    if (exclude.has(id)) return false;
    const g = geomsOf(id, comp);
    return g.length > 0 && g[0]!.start >= from;
  });
}

function compScope(comp: string, ids: string[]): Scope {
  ensureTimeline(comp);
  return layersScope(ids, comp);
}

export const layerTimeHandlers: HandlerTable = {
  setLayerTiming: (cmd) => {
    if (cmd.items.length === 0) fail('invalidArgument', 'no layers given');
    const comps = new Set<string>();
    const plans: Array<{ layer: string; comp: string; geo: Geo[] | null; stretch?: number }> = [];
    for (const it of cmd.items) {
      requireLayer(it.layer);
      const comp = compOfLayer(it.layer)!;
      comps.add(comp);
      ensureTimeline(comp);
      const fps = compFps(comp);
      for (const [v, n] of [[it.inPoint, 'inPoint'], [it.outPoint, 'outPoint'], [it.startTime, 'startTime']] as const) if (v !== undefined) checkTime(v, n);
      let geo: Geo[] | null = null;
      if (it.inPoint !== undefined || it.outPoint !== undefined || it.startTime !== undefined) {
        geo = barsOrFail(it.layer, comp);
        if (it.startTime !== undefined) {
          const cur = geo[0]!.start - geo[0]!.sourceIn;
          geo = shift(geo, flicksToFrames(it.startTime, fps) - cur);
        }
        if (it.inPoint !== undefined) geo = trimIn(geo, flicksToFrames(it.inPoint, fps));
        if (it.outPoint !== undefined) geo = trimOut(geo, flicksToFrames(it.outPoint, fps));
        for (const b of geo) validBar(it.layer, b);
      }
      if (it.stretch !== undefined) {
        const pct = Math.abs(it.stretch) * 100;
        if (!(pct >= 1 && pct <= 1000)) fail('outOfRange', 'stretch must be within ±0.01…±10 and not 0', { layer: it.layer });
      }
      plans.push({ layer: it.layer, comp, geo, ...(it.stretch !== undefined ? { stretch: it.stretch } : {}) });
    }
    const scope: Scope = { document: false, keys: new Set() };
    for (const c of comps) layersScope(plans.filter((p) => p.comp === c).map((p) => p.layer), c, scope);
    return {
      scope,
      label: 'Layer Timing',
      apply: () => {
        for (const p of plans) {
          if (p.geo) writeGeoms(p.comp, p.layer, p.geo);
          if (p.stretch !== undefined) updateNodeLayerTime(p.layer, { stretch: Math.abs(p.stretch) * 100, reverse: p.stretch < 0 });
        }
        return {};
      },
    };
  },

  moveLayersInTime: (cmd) => {
    const comp = requireLayersInOneComp(cmd.layers);
    checkTime(cmd.delta, 'delta');
    const d = flicksToFrames(cmd.delta, compFps(comp));
    ensureTimeline(comp);
    const moved = new Set(cmd.layers);
    const maxOut = Math.max(...cmd.layers.map((id) => span(barsOrFail(id, comp)).out));
    const ripple = cmd.ripple ? laterLayers(comp, maxOut, moved) : [];
    const all = [...cmd.layers, ...ripple];
    return {
      scope: compScope(comp, all),
      label: `Move ${plural(cmd.layers.length, 'Layer')}`,
      apply: () => {
        for (const id of all) writeGeoms(comp, id, shift(geomsOf(id, comp), d));
        return {};
      },
    };
  },

  trimLayers: (cmd) => {
    const comp = requireLayersInOneComp(cmd.layers);
    checkTime(cmd.time);
    const to = flicksToFrames(cmd.time, compFps(comp));
    ensureTimeline(comp);
    const next = new Map<string, Geo[]>();
    let rippleDelta = 0;
    let rippleFrom = Infinity;
    for (const id of cmd.layers) {
      const g = barsOrFail(id, comp);
      const s = span(g);
      let n: Geo[];
      if (cmd.edge === 'in') {
        n = trimIn(g, to, cmd.ripple);
        if (cmd.ripple) rippleDelta = -(to - s.in);
      } else {
        n = trimOut(g, to);
        if (cmd.ripple) rippleDelta = to - s.out;
      }
      rippleFrom = Math.min(rippleFrom, s.out);
      for (const b of n) validBar(id, b);
      next.set(id, n);
    }
    const ripple = cmd.ripple ? laterLayers(comp, rippleFrom, new Set(cmd.layers)) : [];
    return {
      scope: compScope(comp, [...cmd.layers, ...ripple]),
      label: cmd.edge === 'in' ? 'Trim In' : 'Trim Out',
      apply: () => {
        for (const [id, g] of next) writeGeoms(comp, id, g);
        for (const id of ripple) writeGeoms(comp, id, shift(geomsOf(id, comp), rippleDelta));
        return {};
      },
    };
  },

  slipLayers: (cmd) => {
    const comp = requireLayersInOneComp(cmd.layers);
    checkTime(cmd.delta, 'delta');
    const d = flicksToFrames(cmd.delta, compFps(comp));
    ensureTimeline(comp);
    const next = new Map<string, Geo[]>();
    for (const id of cmd.layers) {
      const g = barsOrFail(id, comp).map((b) => ({ ...b, sourceIn: b.sourceIn + d }));
      for (const b of g) validBar(id, b);
      next.set(id, g);
    }
    return {
      scope: compScope(comp, cmd.layers),
      label: 'Slip',
      apply: () => {
        for (const [id, g] of next) writeGeoms(comp, id, g);
        return {};
      },
    };
  },

  slideLayer: (cmd) => {
    requireLayer(cmd.layer);
    const comp = compOfLayer(cmd.layer)!;
    checkTime(cmd.delta, 'delta');
    const d = flicksToFrames(cmd.delta, compFps(comp));
    ensureTimeline(comp);
    const g = barsOrFail(cmd.layer, comp);
    const s = span(g);
    const others = layerIdsOfComp(comp).filter((id) => id !== cmd.layer);
    const before = others.find((id) => { const x = geomsOf(id, comp); return x.length > 0 && span(x).out === s.in; });
    const after = others.find((id) => { const x = geomsOf(id, comp); return x.length > 0 && span(x).in === s.out; });
    const moved = shift(g, d);
    const plan = new Map<string, Geo[]>([[cmd.layer, moved]]);
    if (before) plan.set(before, trimOut(geomsOf(before, comp), s.in + d));
    if (after) plan.set(after, trimIn(geomsOf(after, comp), s.out + d));
    for (const [id, x] of plan) for (const b of x) validBar(id, b);
    return {
      scope: compScope(comp, [...plan.keys()]),
      label: 'Slide',
      apply: () => {
        for (const [id, x] of plan) writeGeoms(comp, id, x);
        return {};
      },
    };
  },

  rollEdit: (cmd) => {
    const comp = requireLayersInOneComp([cmd.left, cmd.right]);
    checkTime(cmd.delta, 'delta');
    const d = flicksToFrames(cmd.delta, compFps(comp));
    ensureTimeline(comp);
    const l = barsOrFail(cmd.left, comp);
    const r = barsOrFail(cmd.right, comp);
    if (span(l).out !== span(r).in) fail('invalidArgument', 'roll needs two layers that share a cut (left out = right in)');
    const nl = trimOut(l, span(l).out + d);
    const nr = trimIn(r, span(r).in + d);
    for (const b of nl) validBar(cmd.left, b);
    for (const b of nr) validBar(cmd.right, b);
    return {
      scope: compScope(comp, [cmd.left, cmd.right]),
      label: 'Roll Edit',
      apply: () => {
        writeGeoms(comp, cmd.left, nl);
        writeGeoms(comp, cmd.right, nr);
        return {};
      },
    };
  },

  splitLayers: (cmd, ctx) => {
    const comp = requireLayersInOneComp(cmd.layers);
    checkTime(cmd.time);
    const t = flicksToFrames(cmd.time, compFps(comp));
    ensureTimeline(comp);
    const work: Array<{ id: string; newId: string; left: Geo[]; right: Geo[] }> = [];
    for (const id of cmd.layers) {
      const g = barsOrFail(id, comp);
      const i = g.findIndex((b) => b.start < t && t < b.start + b.duration);
      if (i < 0) continue; // AE: a layer the time does not cut is left alone
      const b = g[i]!;
      const leftBar = { ...b, duration: t - b.start };
      const rightBar = { ...b, start: t, sourceIn: b.sourceIn + (t - b.start), duration: b.start + b.duration - t };
      work.push({ id, newId: ctx.mintId('layer_'), left: [...g.slice(0, i), leftBar], right: [rightBar, ...g.slice(i + 1)] });
    }
    return {
      scope: documentScope(),
      label: 'Split Layer',
      apply: () => {
        for (const w of work) {
          if (!cloneLayerNode(w.id, w.newId)) fail('internal', `could not split '${w.id}'`, { layer: w.id });
          const src = graph.getNode(w.id)!;
          const copy = graph.getNode(w.newId)!;
          if (src.solo) copy.solo = true;
          if (src.shy) copy.shy = true;
          if (src.color) copy.color = src.color;
          remintKeyIds(w.newId, ctx);
          getTimelineController().syncFromScene(comp);
          writeGeoms(comp, w.id, w.left);
          writeGeoms(comp, w.newId, w.right);
        }
        return { layers: work.map((w) => w.newId) };
      },
    };
  },

  rippleDeleteLayers: (cmd) => {
    const comp = requireLayersInOneComp(cmd.layers);
    for (const id of cmd.layers) if (graph.getNode(id)?.locked) fail('locked', `layer '${id}' is locked`, { layer: id });
    ensureTimeline(comp);
    const gaps = cmd.layers.map((id) => geomsOf(id, comp)).filter((g) => g.length > 0).map(span).sort((a, b) => a.in - b.in);
    // Union of the deleted spans.
    const union: Array<{ in: number; out: number }> = [];
    for (const s of gaps) {
      const last = union[union.length - 1];
      if (last && s.in <= last.out) last.out = Math.max(last.out, s.out);
      else union.push({ ...s });
    }
    return {
      scope: documentScope(),
      label: `Ripple Delete ${plural(cmd.layers.length, 'Layer')}`,
      apply: () => {
        const doomed = new Set(cmd.layers);
        for (const id of cmd.layers) {
          const node = graph.getNode(id);
          if (!node) continue;
          const target = node.parent!;
          for (const c of [...graph.getChildOrder(id)]) if (!doomed.has(c)) graph.setParent(c, target, { preserveWorld: true });
          deleteLayerNode(id);
        }
        for (const id of layerIdsOfComp(comp)) {
          const g = geomsOf(id, comp);
          if (g.length === 0) continue;
          const at = g[0]!.start;
          let d = 0;
          for (const u of union) if (u.out <= at) d += u.out - u.in;
          if (d > 0) writeGeoms(comp, id, shift(g, -d));
        }
        return {};
      },
    };
  },

  editWorkArea: (cmd, ctx) => {
    requireComp(cmd.comp);
    ensureTimeline(cmd.comp);
    const reg = getTimelineController().peekTimeline(cmd.comp)!;
    const wa = reg.timeline.getRanges().workArea ?? { start: 0, duration: reg.timeline.duration };
    const s = wa.start;
    const e = wa.start + wa.duration;
    const ids = cmd.layers.length > 0 ? cmd.layers : layerIdsOfComp(cmd.comp).filter((id) => geomsOf(id, cmd.comp).length > 0);
    if (cmd.layers.length > 0 && requireLayersInOneComp(cmd.layers) !== cmd.comp) fail('invalidArgument', 'the layers are not in that composition');
    const extract = cmd.edit === 'extract';
    const newIds = new Map<string, string>();
    for (const id of ids) {
      const g = geomsOf(id, cmd.comp);
      if (g.length === 0) continue;
      const sp = span(g);
      if (sp.in < s && sp.out > e) newIds.set(id, ctx.mintId('layer_'));
    }
    return {
      scope: documentScope(),
      label: extract ? 'Extract Work Area' : 'Lift Work Area',
      apply: () => {
        const width = e - s;
        for (const id of ids) {
          const g = geomsOf(id, cmd.comp);
          if (g.length === 0) continue;
          const sp = span(g);
          if (sp.out <= s) continue;
          if (sp.in >= e) {
            if (extract) writeGeoms(cmd.comp, id, shift(g, -width));
            continue;
          }
          if (sp.in >= s && sp.out <= e) {
            deleteLayerNode(id);
            continue;
          }
          if (sp.in < s && sp.out > e) {
            const newId = newIds.get(id)!;
            cloneLayerNode(id, newId);
            remintKeyIds(newId, ctx);
            getTimelineController().syncFromScene(cmd.comp);
            const right = trimIn(g, e);
            writeGeoms(cmd.comp, id, trimOut(g, s));
            writeGeoms(cmd.comp, newId, extract ? shift(right, -width) : right);
            continue;
          }
          if (sp.in < s) writeGeoms(cmd.comp, id, trimOut(g, s));
          else {
            const r = trimIn(g, e);
            writeGeoms(cmd.comp, id, extract ? shift(r, -width) : r);
          }
        }
        return { layers: [...newIds.values()] };
      },
    };
  },

  insertGap: (cmd) => {
    requireComp(cmd.comp);
    checkTime(cmd.time);
    checkTime(cmd.duration, 'duration');
    if (cmd.duration <= 0) fail('outOfRange', 'the gap must be longer than zero');
    const fps = compFps(cmd.comp);
    const at = flicksToFrames(cmd.time, fps);
    const d = flicksToFrames(cmd.duration, fps);
    ensureTimeline(cmd.comp);
    const ids = laterLayers(cmd.comp, at, new Set());
    return {
      scope: compScope(cmd.comp, ids),
      label: 'Insert Gap',
      apply: () => {
        for (const id of ids) writeGeoms(cmd.comp, id, shift(geomsOf(id, cmd.comp), d));
        return {};
      },
    };
  },

  timeReverseLayers: (cmd) => {
    const comp = requireLayersInOneComp(cmd.layers);
    return {
      scope: compScope(comp, cmd.layers),
      label: 'Time-Reverse Layer',
      apply: () => {
        for (const id of cmd.layers) updateNodeLayerTime(id, { reverse: !getNodeLayerTime(id).reverse });
        return {};
      },
    };
  },

  setTimeRemap: (cmd) => {
    requireLayer(cmd.layer);
    const comp = compOfLayer(cmd.layer)!;
    return {
      scope: compScope(comp, [cmd.layer]),
      label: cmd.enabled ? 'Enable Time Remapping' : 'Disable Time Remapping',
      apply: () => {
        const mode = readRetimeMode(defaultAnimation, cmd.layer);
        if (cmd.enabled && mode !== 'frames') setRetimeMode([cmd.layer], 'frames');
        if (!cmd.enabled) {
          if (mode === 'frames') setRetimeMode([cmd.layer], 'normal');
          else defaultAnimation.removeTrack(cmd.layer, REMAP_PROP);
        }
        return {};
      },
    };
  },

  freezeFrame: (cmd) => {
    requireLayer(cmd.layer);
    const comp = compOfLayer(cmd.layer)!;
    if (cmd.time !== undefined) checkTime(cmd.time);
    ensureTimeline(comp);
    const fps = compFps(comp);
    let at: number;
    if (cmd.lastFrame || cmd.time === undefined) {
      const g = geomsOf(cmd.layer, comp);
      const outFrame = g.length > 0 ? span(g).out - 1 : compDurationFrames(comp) - 1;
      at = compToKeyframeTime(cmd.layer, outFrame / fps);
    } else {
      at = compToKeyframeTime(cmd.layer, flicksToSeconds(cmd.time));
    }
    return {
      scope: compScope(comp, [cmd.layer]),
      label: 'Freeze Frame',
      apply: () => {
        updateNodeLayerTime(cmd.layer, { freeze: true, freezeTime: at });
        return {};
      },
    };
  },

  setRetime: (cmd) => {
    requireLayer(cmd.layer);
    const comp = compOfLayer(cmd.layer)!;
    if (cmd.speed !== undefined && cmd.mode !== 'speed') fail('invalidArgument', 'speed is only valid with mode speed');
    if (cmd.speed !== undefined && !Number.isFinite(cmd.speed)) fail('invalidArgument', 'speed must be finite');
    ensureTimeline(comp);
    return {
      scope: compScope(comp, [cmd.layer]),
      label: 'Retime',
      apply: () => {
        setRetimeMode([cmd.layer], cmd.mode);
        if (cmd.mode === 'speed' && cmd.speed !== undefined) {
          const keys = defaultAnimation.getTrackKeyframes(cmd.layer, SPEED_PROP) ?? [];
          const first = keys[0];
          defaultAnimation.setKeyframes(cmd.layer, SPEED_PROP, [{ ...(first ?? { t: 0, easing: 'linear' as const }), value: clampSpeedPercent(cmd.speed) }]);
        }
        return {};
      },
    };
  },

  sequenceLayers: (cmd) => {
    const comp = requireLayersInOneComp(cmd.layers);
    checkTime(cmd.overlap, 'overlap');
    const fps = compFps(comp);
    const ov = flicksToFrames(cmd.overlap, fps);
    ensureTimeline(comp);
    for (const id of cmd.layers) barsOrFail(id, comp);
    return {
      scope: compScope(comp, cmd.layers),
      label: 'Sequence Layers',
      apply: () => {
        let prevOut: number | null = null;
        const pairs: Array<{ out: string; inn: string; start: number; end: number }> = [];
        cmd.layers.forEach((id, i) => {
          const g = geomsOf(id, comp);
          if (prevOut !== null) {
            const start = prevOut - ov;
            const moved = shift(g, start - g[0]!.start);
            writeGeoms(comp, id, moved);
            if (cmd.crossfade && ov > 0) pairs.push({ out: cmd.layers[i - 1]!, inn: id, start, end: prevOut });
            prevOut = span(moved).out;
          } else {
            prevOut = span(g).out;
          }
        });
        for (const p of pairs) {
          const t0 = (p.start) / fps;
          const t1 = (p.end) / fps;
          const o0 = compToKeyframeTime(p.out, t0);
          const o1 = compToKeyframeTime(p.out, t1);
          const i0 = compToKeyframeTime(p.inn, t0);
          const i1 = compToKeyframeTime(p.inn, t1);
          defaultAnimation.setKeyframe(p.out, 'opacity', o0, 100);
          defaultAnimation.setKeyframe(p.out, 'opacity', o1, 0);
          defaultAnimation.setKeyframe(p.inn, 'opacity', i0, 0);
          defaultAnimation.setKeyframe(p.inn, 'opacity', i1, 100);
        }
        return {};
      },
    };
  },
};

export type { HandlerCtx };
