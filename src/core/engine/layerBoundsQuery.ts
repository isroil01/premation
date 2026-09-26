/**
 * `getLayerBounds` (ENGINE_API.md §7, §15.12) — the TypeScript engine's
 * answer: `readGeometry`'s box (src/core/workspace/geometry.ts — the box the
 * viewport selects, hit-tests and snaps with) at the query's time, a GROUP's
 * box being the union of its children at that same time, in the layer's own
 * space or through its 2D world chain. The C++ twin is
 * native/engine/src/core/layer_geometry.cpp.
 */

import type { GetLayerBounds, LayerBounds } from '@motion/engine-api';
import { defaultAnimation } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import { world2DAt } from '@core/scene/layerSpace';
import { getRemappedTime } from '@core/timeline/TimelineController';
import { readGeometry, type NodeGeometry } from '@core/workspace/geometry';
import { fail } from './errors';
import { requireLayer } from './doc';
import { checkTime, flicksToSeconds } from './time';

/** The node's animated values at comp time `seconds` (its keyframe axis), or undefined when it has none. */
function animatedAt(id: string, seconds: number): Record<string, unknown> | undefined {
  if (!defaultAnimation.hasAnimation(id)) return undefined;
  const av = defaultAnimation.evaluateNode(id, getRemappedTime(id, seconds));
  const out: Record<string, unknown> = {};
  for (const [k, v] of av.entries()) out[k] = v;
  return out;
}

/**
 * `readGeometry` at `seconds`. readGeometry's live group union reads the
 * PLAYHEAD; a query names its time, so a group's union is taken here, child by
 * child, at `seconds`.
 */
export function layerGeometryAt(id: string, seconds: number, depth = 0): NodeGeometry | null {
  const node = defaultSceneGraph.getNode(id);
  if (!node) return null;
  const g = readGeometry(node, animatedAt(id, seconds));
  if (!g || readNodeKind(node) !== 'group' || depth > 16) return g;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const child of defaultSceneGraph.getChildren(id)) {
    const c = layerGeometryAt(child.id, seconds, depth + 1);
    if (!c) continue;
    const halfW = Math.abs(c.width * c.scaleX) / 2;
    const halfH = Math.abs(c.height * c.scaleY) / 2;
    const cx = c.x + c.offsetX * c.scaleX;
    const cy = c.y + c.offsetY * c.scaleY;
    minX = Math.min(minX, cx - halfW);
    minY = Math.min(minY, cy - halfH);
    maxX = Math.max(maxX, cx + halfW);
    maxY = Math.max(maxY, cy + halfH);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return g;
  return { ...g, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY), offsetX: (minX + maxX) / 2, offsetY: (minY + maxY) / 2 };
}

export function layerBoundsAnswer(q: GetLayerBounds): LayerBounds[] {
  checkTime(q.time);
  if (q.space === 'viewport') fail('unsupported', 'viewport-space bounds need the viewport\'s camera: the overlay geometry push (setOverlayGeometry) carries them');
  if (q.includeEffects) fail('unsupported', 'effect growth is not in layer bounds yet (includeEffects)');
  const seconds = flicksToSeconds(q.time);
  const out: LayerBounds[] = [];
  for (const id of q.layers) {
    requireLayer(id);
    const g = layerGeometryAt(id, seconds);
    if (!g) continue; // no canvas box (audio, adjustment)
    const l = g.offsetX - g.width / 2;
    const t = g.offsetY - g.height / 2;
    const r = l + g.width;
    const b = t + g.height;
    let corners = [l, t, r, t, r, b, l, b];
    if (q.space === 'comp') {
      const m = world2DAt(id, seconds);
      corners = corners.map((v, i) => (i % 2 === 0 ? m.a * v + m.c * corners[i + 1]! + m.e : m.b * corners[i - 1]! + m.d * v + m.f));
    }
    const xs = corners.filter((_, i) => i % 2 === 0);
    const ys = corners.filter((_, i) => i % 2 === 1);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    out.push({ layer: id, bounds: { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY }, corners });
  }
  return out;
}
