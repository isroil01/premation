/**
 * A layer's MASKS over the document MIRROR (B4) — the twins of
 * `mask.readNodeMaskAt` / `hasMaskAnim`: each `masks/<id>` group of the
 * layer's property tree as the editor's `MaskPath` record (name, mode,
 * inverted, the shape at a time with its per-vertex feathers, feather /
 * opacity / expansion at that time). Pure: takes the mirror, never the engine.
 *
 * Numbers leave the API in stored units here (a mask's opacity is 0..1, its
 * feather and expansion px — none is scaled, ENGINE_API.md §3.5).
 */

import type { BezierPath, Value } from '@motion/engine-api';
import type { MaskMode, MaskPath, MaskPoint } from '@core/effects/mask';
import type { MirrorTreeLike } from './trackIndex';

/** What these readers need from the mirror. `DocumentMirror` is one. */
export interface MirrorMaskRead {
  tree(layer: string): MirrorTreeLike | undefined;
  valueAt(layer: string, path: string, time: number): Value | undefined;
  keyframes(layer: string, path: string): readonly unknown[];
}

const MODES: ReadonlySet<string> = new Set(['add', 'subtract', 'intersect', 'difference', 'lighten', 'darken', 'none']);

/** A path Value's vertices as the editor's points (absolute handles; a vertex's own feather). */
export function bezierToMaskPoints(b: BezierPath): MaskPoint[] {
  const n = Math.floor(b.vertices.length / 2);
  const feather = new Map<number, number>();
  for (const fp of b.featherPoints) if (fp.t === 0 && fp.radius >= 0 && fp.segment < n) feather.set(fp.segment, fp.radius);
  const out: MaskPoint[] = [];
  for (let i = 0; i < n; i++) {
    const x = b.vertices[2 * i]!;
    const y = b.vertices[2 * i + 1]!;
    const pt: MaskPoint = {
      x, y,
      inX: x + (b.inTangents[2 * i] ?? 0), inY: y + (b.inTangents[2 * i + 1] ?? 0),
      outX: x + (b.outTangents[2 * i] ?? 0), outY: y + (b.outTangents[2 * i + 1] ?? 0),
    };
    const f = feather.get(i);
    if (f !== undefined) pt.feather = f;
    out.push(pt);
  }
  return out;
}

/** The mask ids of a layer, in stack order. */
export function mirrorMaskIds(tree: MirrorTreeLike | undefined): string[] {
  return (tree?.nodes.get('masks')?.children ?? []).map((p) => p.slice(p.lastIndexOf('/') + 1));
}

/** Every mask of `layer` at comp time `time` (flicks), in stack order. Empty when the tree has not arrived. */
export function mirrorMasksAt(m: MirrorMaskRead, layer: string, time: number): MaskPath[] {
  const tree = m.tree(layer);
  if (!tree) return [];
  const num = (path: string, fallback: number): number => {
    const v = m.valueAt(layer, path, time);
    return v && (v.kind === 'scalar' || v.kind === 'int') ? v.value : fallback;
  };
  const out: MaskPath[] = [];
  mirrorMaskIds(tree).forEach((id, index) => {
    const base = `masks/${id}`;
    // The group reports "Mask N" for an unnamed mask: that is the list's own default label, not a name.
    const name = tree.nodes.get(base)?.name;
    const shape = m.valueAt(layer, `${base}/path`, time);
    const mode = tree.nodes.get(`${base}/mode`)?.value;
    const inverted = tree.nodes.get(`${base}/inverted`)?.value;
    out.push({
      id,
      ...(name && name !== `Mask ${index + 1}` ? { name } : {}),
      mode: (mode?.kind === 'choice' && MODES.has(mode.value) ? mode.value : 'add') as MaskMode,
      closed: shape?.kind === 'path' ? shape.value.closed : true,
      points: shape?.kind === 'path' ? bezierToMaskPoints(shape.value) : [],
      feather: num(`${base}/feather`, 0),
      opacity: num(`${base}/opacity`, 1),
      expansion: num(`${base}/expansion`, 0),
      inverted: inverted?.kind === 'bool' && inverted.value,
    });
  });
  return out;
}

/** Whether any mask SHAPE of the layer carries keyframes (`hasMaskAnim`). */
export function mirrorMaskShapeKeyed(m: MirrorMaskRead, layer: string): boolean {
  return mirrorMaskIds(m.tree(layer)).some((id) => m.keyframes(layer, `masks/${id}/path`).length > 0);
}

/** The mirror keys a mask list depends on (tree, and each mask property's info / keys / value). */
export function mirrorMaskWatchKeys(tree: MirrorTreeLike | undefined, layer: string): string[] {
  const out = [`tree:${layer}`, `layer:${layer}`];
  for (const id of mirrorMaskIds(tree)) {
    for (const k of ['path', 'feather', 'opacity', 'expansion', 'mode', 'inverted']) {
      const p = `masks/${id}/${k}`;
      out.push(`prop:${layer}|${p}`, `key:${layer}|${p}`, `value:${layer}|${p}`);
    }
  }
  return out;
}
