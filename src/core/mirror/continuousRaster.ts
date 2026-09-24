/**
 * Whether a layer's collapse switch means CONTINUOUS RASTERIZATION, read from
 * the document MIRROR (B4) — the twin of `continuousRaster.supportsContinuousRaster`
 * for the Inspector's Pre-composition section. Pure: takes a mirror reader and
 * never touches the engine.
 *
 * The switch itself is `LayerSwitches.collapse` (Collapse Transformations on a
 * placed composition, Continuous Rasterize on a vector layer — one column, one
 * meaning per layer type, `layerFlags.collapseSwitchKind`). It is offered where
 * re-rasterizing can sharpen something: text, SVG, and shapes with real vector
 * geometry. A flat solid rectangle (no path, no stroke, no corner radius) is
 * already crisp at any scale, so it has no CR switch.
 */

import type { LayerInfo } from '@motion/engine-api';
import { uiKindOf } from './layerKinds';
import { jsonField, type MirrorFieldRead } from './layerFields';
import { numbersOfValue, trackRefIn } from './trackIndex';

/** Shape layer kinds whose outline is not a plain rectangle (`shapeType` other than rect, or a drawn path). */
const VECTOR_OUTLINE: ReadonlySet<LayerInfo['kind']> = new Set(['ellipse', 'polygon', 'path']);

/** A positive stroke width or (linked) corner radius gives the outline an edge worth re-rasterizing — `isFlatSolid`'s two numbers. */
const RASTER_TRACKS = ['strokeWidth', 'cornerRadius'] as const;

/** A shape with no path, no stroke and no corner radius — a flat rectangle of colour (the twin of `isFlatSolid`). */
function isFlatSolidLayer(m: Pick<MirrorFieldRead, 'layer' | 'property' | 'tree'>, layer: LayerInfo): boolean {
  if (VECTOR_OUTLINE.has(layer.kind)) return false;
  const strokes = jsonField<unknown>(m, layer.id, 'layer/strokes');
  if (Array.isArray(strokes) && strokes.length > 0) return false;
  const tree = m.tree(layer.id);
  for (const t of RASTER_TRACKS) {
    const ref = trackRefIn(tree, t);
    const v = ref ? numbersOfValue(ref.info.value)[ref.member] : undefined;
    if (typeof v === 'number' && v > 0) return false;
  }
  return true;
}

/** Whether the layer's collapse switch is Continuous Rasterize (text, SVG, a shape with vector geometry). */
export function mirrorSupportsContinuousRaster(m: Pick<MirrorFieldRead, 'layer' | 'property' | 'tree'>, id: string): boolean {
  const layer = m.layer(id);
  const kind = uiKindOf(layer);
  if (!layer) return false;
  if (kind === 'text' || kind === 'svg') return true;
  if (kind === 'shape') return !isFlatSolidLayer(m, layer);
  return false;
}
