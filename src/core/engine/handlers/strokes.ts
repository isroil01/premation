/**
 * Stroke commands: the shape stroke stack (B3z, strokeStack.ts) — `removeStroke` —
 * and PAINT strokes (B3, paintStrokes.ts) — add / update / remove a stroke, its
 * Path and Path stopwatch, the layer's Paint on Transparent.
 */

import { defaultAnimation } from '@motion/animation';
import type { PaintStroke } from '@core/paint/paintStrokes';
import { normalizeStroke, readNodePaint } from '@core/paint/paintStrokes';
import { graph, requireLayer } from '../doc';
import { fail } from '../errors';
import { newScope, scopeLayer } from '../state';
import { planRemoveStroke } from '../strokeStack';
import { checkTime } from '../time';
import {
  checkPaintPoints,
  isPaintNumericParam,
  keyPaintPath,
  paintPathTrack,
  paintStrokeOrFail,
  parsePaintObject,
  parsePaintPoints,
  patchStroke,
  removeStrokes,
  storePaint,
} from '../paintStrokes';
import type { HandlerTable } from '../handler';

export const strokeHandlers: HandlerTable = {
  removeStroke: (cmd) => {
    requireLayer(cmd.layer);
    const apply = planRemoveStroke(cmd.layer, graph.getNode(cmd.layer)!, cmd.index);
    return {
      scope: scopeLayer(newScope(), cmd.layer),
      label: `Remove Stroke ${cmd.index + 1}`,
      apply: () => {
        apply();
        return {};
      },
    };
  },

  addPaintStroke: (cmd, ctx) => {
    const layer = cmd.layer;
    const node = requireLayer(layer);
    const raw = parsePaintObject(cmd.stroke, 'stroke', layer);
    if ('id' in raw) fail('invalidArgument', 'a new paint stroke takes no id (the engine mints it)', { layer });
    checkPaintPoints(raw.points, 'stroke.points', layer);
    for (const k of cmd.keys) {
      if (!isPaintNumericParam(k.param)) fail('invalidArgument', `'${k.param}' is not a paint stroke param`, { layer });
      if (!Number.isFinite(k.time) || !Number.isFinite(k.value)) fail('invalidArgument', `the '${k.param}' key must be finite`, { layer });
    }
    const cfg = readNodePaint(node);
    const existing = cfg?.strokes ?? [];
    const id = ctx.mintGroupId('pstroke_', (x) => existing.some((s) => s.id === x));
    return {
      scope: scopeLayer(newScope(), layer),
      label: 'Paint Stroke',
      apply: () => {
        storePaint(layer, [...existing, normalizeStroke(raw as unknown as PaintStroke, id)], cfg?.onTransparent);
        for (const k of cmd.keys) defaultAnimation.setKeyframe(layer, `paint.${id}.${k.param}`, k.time, k.value);
        return { stroke: id };
      },
    };
  },

  updatePaintStroke: (cmd) => {
    const layer = cmd.layer;
    const { cfg, index } = paintStrokeOrFail(layer, requireLayer(layer), cmd.stroke);
    const patch = parsePaintObject(cmd.patch, 'patch', layer);
    if ('id' in patch) fail('invalidArgument', 'a paint stroke\'s id cannot be patched', { layer, path: `paint/${cmd.stroke}` });
    if ('points' in patch) checkPaintPoints(patch.points, 'patch.points', layer);
    return {
      scope: scopeLayer(newScope(), layer),
      label: 'Edit Paint Stroke',
      apply: () => {
        patchStroke(layer, cfg, index, patch);
        return {};
      },
    };
  },

  removePaintStrokes: (cmd) => {
    const layer = cmd.layer;
    const node = requireLayer(layer);
    if (cmd.strokes.length === 0) fail('invalidArgument', 'no paint strokes given', { layer });
    const paint = cmd.strokes.map((id) => paintStrokeOrFail(layer, node, id))[0]!.cfg;
    const ids = new Set(cmd.strokes);
    return {
      scope: scopeLayer(newScope(), layer),
      label: ids.size === 1 ? 'Delete Paint Stroke' : `Delete ${ids.size} Paint Strokes`,
      apply: () => {
        removeStrokes(layer, paint, ids);
        return {};
      },
    };
  },

  setPaintOnTransparent: (cmd) => {
    const s = newScope();
    const plans = cmd.layers.map((layer) => {
      const cfg = readNodePaint(requireLayer(layer));
      if (!cfg) fail('notFound', `layer '${layer}' has no paint strokes`, { layer, path: 'paint' });
      scopeLayer(s, layer);
      return { layer, cfg };
    });
    return {
      scope: s,
      label: 'Paint on Transparent',
      apply: () => {
        for (const p of plans) storePaint(p.layer, p.cfg.strokes, cmd.on || undefined);
        return {};
      },
    };
  },

  setPaintStrokePath: (cmd) => {
    const layer = cmd.layer;
    const { cfg, index } = paintStrokeOrFail(layer, requireLayer(layer), cmd.stroke);
    const points = parsePaintPoints(cmd.points, layer);
    checkTime(cmd.time);
    return {
      scope: scopeLayer(newScope(), layer),
      label: 'Replace Paint Path',
      apply: () => {
        if (defaultAnimation.isDataAnimated(layer, paintPathTrack(cmd.stroke))) keyPaintPath(layer, cmd.stroke, cmd.time, points);
        // A new static path invalidates the per-point input recorded for the old one.
        else patchStroke(layer, cfg, index, { points, pressure: null, tiltX: null, tiltY: null });
        return {};
      },
    };
  },

  setPaintPathAnimated: (cmd) => {
    const layer = cmd.layer;
    const { cfg, index } = paintStrokeOrFail(layer, requireLayer(layer), cmd.stroke);
    checkTime(cmd.time);
    const prop = paintPathTrack(cmd.stroke);
    return {
      scope: scopeLayer(newScope(), layer),
      label: cmd.animated ? 'Enable Path Animation' : 'Disable Path Animation',
      apply: () => {
        const keyed = defaultAnimation.isDataAnimated(layer, prop);
        if (cmd.animated && !keyed) keyPaintPath(layer, cmd.stroke, cmd.time, [...cfg.strokes[index]!.points]);
        else if (!cmd.animated && defaultAnimation.getDataTrack(layer, prop)) defaultAnimation.setDataTrack(layer, prop, null);
        return {};
      },
    };
  },
};
