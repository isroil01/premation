/**
 * A layer's paint strokes over the document MIRROR (B4 round 6): the
 * `paint/<id>` groups of its property tree — the stroke's AE name ("Brush 1",
 * "Eraser 2"), its mode (`paint:<mode>` match name), its video switch
 * (`enabled`) — whether its Path is keyed, and Paint on Transparent
 * (`layer/paintOnTransparent`). Pure over a mirror reader.
 */

import type { Keyframe, PropertyInfo } from '@motion/engine-api';
import { plainValue, type MirrorTreeLike } from './trackIndex';

export interface MirrorPaintStroke {
  id: string;
  name: string;
  mode: string;
  visible: boolean;
  /** The Path has keyframes (the stopwatch is on). */
  pathKeyed: boolean;
}

export interface MirrorPaintRead {
  tree(layer: string): MirrorTreeLike | undefined;
  keyframes(layer: string, path: string): readonly Keyframe[];
}

/** The layer's strokes, stored order; [] when it has none (or the tree has not arrived). */
export function mirrorPaintStrokes(m: MirrorPaintRead, layer: string): MirrorPaintStroke[] {
  const tree = m.tree(layer);
  const root = tree?.nodes.get('paint');
  if (!tree || !root) return [];
  const out: MirrorPaintStroke[] = [];
  for (const path of root.children) {
    const g: PropertyInfo | undefined = tree.nodes.get(path);
    if (!g) continue;
    const id = path.slice('paint/'.length);
    out.push({
      id,
      name: g.name,
      mode: g.matchName.startsWith('paint:') ? g.matchName.slice('paint:'.length) : 'paint',
      visible: g.enabled,
      pathKeyed: tree.nodes.get(`${path}/path`)?.animated === true || m.keyframes(layer, `${path}/path`).length > 0,
    });
  }
  return out;
}

/** A stroke as the viewers draw and pick it: its points and its own Transform. */
export interface MirrorPaintStrokeShape extends MirrorPaintStroke {
  /** The un-keyed Path, in the layer's own centred pixels (before the stroke's Transform). */
  points: ReadonlyArray<{ x: number; y: number }>;
  /** Brush diameter, layer px. */
  diameter: number;
  anchorX: number;
  anchorY: number;
  positionX: number;
  positionY: number;
  /** %, 100 = as drawn. */
  scale: number;
  /** Degrees. */
  rotation: number;
}

/** A stroke point through the stroke's Transform (scale and rotation about its Anchor, then Position). */
export function strokePointAt(
  s: Pick<MirrorPaintStrokeShape, 'anchorX' | 'anchorY' | 'positionX' | 'positionY' | 'scale' | 'rotation'>,
  p: { x: number; y: number },
): { x: number; y: number } {
  const k = s.scale / 100;
  const r = (s.rotation * Math.PI) / 180;
  const x = (p.x - s.anchorX) * k;
  const y = (p.y - s.anchorY) * k;
  return { x: x * Math.cos(r) - y * Math.sin(r) + s.positionX, y: x * Math.sin(r) + y * Math.cos(r) + s.positionY };
}

/** The layer's strokes with their geometry, stored order; [] when it has none (or the tree has not arrived). */
export function mirrorPaintStrokeShapes(m: MirrorPaintRead, layer: string): MirrorPaintStrokeShape[] {
  const tree = m.tree(layer);
  if (!tree) return [];
  const num = (path: string, fallback: number): number => {
    const v = plainValue(tree.nodes.get(path)?.value);
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  };
  return mirrorPaintStrokes(m, layer).map((st) => {
    const base = `paint/${st.id}`;
    const value = tree.nodes.get(`${base}/path`)?.value;
    const flat = value?.kind === 'path' ? value.value.vertices : [];
    const points: { x: number; y: number }[] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) points.push({ x: flat[i]!, y: flat[i + 1]! });
    return {
      ...st,
      points,
      diameter: num(`${base}/diameter`, 1),
      anchorX: num(`${base}/anchorX`, 0),
      anchorY: num(`${base}/anchorY`, 0),
      positionX: num(`${base}/positionX`, 0),
      positionY: num(`${base}/positionY`, 0),
      scale: num(`${base}/scale`, 100),
      rotation: num(`${base}/rotation`, 0),
    };
  });
}

/** Paint on Transparent (`layer/paintOnTransparent`); false when the layer has no paint. */
export function mirrorPaintOnTransparent(tree: MirrorTreeLike | undefined): boolean {
  return plainValue(tree?.nodes.get('layer/paintOnTransparent')?.value) === true;
}
