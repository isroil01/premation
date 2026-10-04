/**
 * Convert to Editable Shapes — and back.
 *
 * This is the ONLY entry point into the geometry parser. Import never calls it;
 * the user does, explicitly, from the Inspector or the layer's right-click
 * menu. That inversion is the whole point of the hybrid architecture: parsing
 * is an advanced editing operation, not a tax every import pays.
 *
 * Conversion is destructive in the sense that the SVG layer stops existing —
 * but not in the sense that anything is lost. The original markup rides along
 * on the resulting group, so Revert (`buildRevertedSvgLayerInto`) can put it back exactly,
 * and a future release with a better parser can re-run the conversion against
 * the untouched source (§13).
 */

import { useUIStore } from '@stores/uiStore';
import { documentMirror } from '@stores/documentMirror';
import {  measureSvgText, intersectSvgPaths } from '@core/scene/sceneInsert';
import { buildSvgIconGroup, buildSvgLayer } from '@core/scene/layerBuilders';
import { mirrorLabelColor } from '@core/mirror/layerLabels';
import { storedStaticNumber } from '@core/mirror/trackIndex';
import type { FragmentBuilder } from '@/engine-client/fragmentBuilder';
import type { InsertFrame } from '@/engine-client/insertFragment';
import { parseSvgToShapes } from '../../utils/svgParser';
import {
  SVG_COMPONENT,
  type SvgLayerData,
} from './svgLayer';
import { isAnimatedSvg } from './svgCapabilities';
import { getRetainOriginalSvg } from './svgPreferences';

/** The layer properties that must survive the swap in either direction. */
export interface CarriedTransform {
  x?: number;
  y?: number;
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
  opacity?: number;
  name?: string;
  visible?: boolean;
  locked?: boolean;
  color?: string;
}

/**
 * The transform / appearance a converted layer has to pass on, read off the
 * document MIRROR: its header (name, switches, label colour) and the STATIC
 * values its tree stores (keys aside, as the swap always took them). The tree
 * must be loaded (`documentMirror().loadTree`).
 */
export function mirrorCarry(layerId: string): CarriedTransform {
  const m = documentMirror();
  const layer = m.layer(layerId);
  if (!layer) return {};
  const tree = m.tree(layerId);
  const out: CarriedTransform = { name: layer.name, visible: layer.switches.visible, locked: layer.switches.locked };
  const color = mirrorLabelColor(layer);
  if (color !== undefined) out.color = color;
  for (const k of ['x', 'y', 'rotation', 'scaleX', 'scaleY', 'opacity'] as const) {
    const v = storedStaticNumber(tree, k);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Apply a carried transform onto a layer just laid into a fragment. */
function applyCarryTo(b: FragmentBuilder, id: string, carry: CarriedTransform): void {
  const row = b.row(id);
  if (carry.name) row.name = carry.name;
  if (carry.visible !== undefined) row.visible = carry.visible;
  if (carry.locked !== undefined) row.locked = carry.locked;
  if (carry.color !== undefined) row.color = carry.color;
  if (carry.rotation !== undefined) b.setProp(id, 'Transform', 'rotation', carry.rotation);
  if (carry.scaleX !== undefined) b.setProp(id, 'Transform', 'scaleX', carry.scaleX);
  if (carry.scaleY !== undefined) b.setProp(id, 'Transform', 'scaleY', carry.scaleY);
  if (carry.opacity !== undefined) b.setProp(id, 'Style', 'opacity', carry.opacity);
}

/**
 * What conversion will cost, in the user's words — derived from the capability
 * scan so the confirmation dialog, the Inspector badges and the import toast
 * cannot drift apart in what they claim.
 *
 * Returned rather than shown so the caller owns the dialog; this module stays
 * free of UI.
 */
export function describeConversion(data: SvgLayerData): string[] {
  const out: string[] = [];
  const caps = data.capabilities;
  if (caps.pathCount > 0) {
    out.push(`This SVG contains ${caps.pathCount} path${caps.pathCount === 1 ? '' : 's'} and will produce ${caps.pathCount} layer${caps.pathCount === 1 ? '' : 's'}.`);
  }
  if (caps.hasCSSAnimation) {
    out.push('This SVG contains CSS animations. Conversion will approximate them as keyframes.');
  }
  if (caps.hasSMIL) {
    out.push('This SVG contains SMIL animations. Conversion will approximate them as keyframes.');
  }
  if (caps.hasRasterImage) {
    out.push('Raster images become image layers rather than shapes.');
  }
  if (caps.hasText) {
    out.push('Text becomes text layers and may reflow.');
  }
  // Clip paths are CUT into the geometry now, not dropped — saying they are
  // "flattened to solid fills" described neither what used to happen (they were
  // ignored) nor what happens now.
  out.push('Masks and filters are flattened; clip paths are cut into the geometry, which turns curves into fine polygons. Gradients become editable FillPaint (angle/stops).');
  return out;
}

/**
 * Replace an SVG layer with real, editable shape layers.
 *
 * Parses the ORIGINAL markup rather than the sanitized copy: sanitizing scopes
 * every id, and the parser resolves `url(#grad)` references by name, so feeding
 * it the scoped copy would break exactly the fills the user converted in order
 * to edit.
 *
 * Returns the new group's id, or null when the file has no vector geometry the
 * parser can reach (an SVG that is just an embedded bitmap, for instance).
 */
/** What `buildSvgShapeGroup` produced. */
export interface BuiltSvgShapes {
  groupId: string;
  /** Parts converted (one layer each). */
  count: number;
  data: SvgLayerData;
}

/** The `svg` component a converted group keeps: the layer's document minus what only renders it (stripToRetainedSource's set). */
function retainedSvgProps(data: SvgLayerData): Record<string, unknown> {
  return {
    sourceMarkup: data.sourceMarkup,
    intrinsicWidth: data.intrinsicWidth,
    intrinsicHeight: data.intrinsicHeight,
    viewBox: data.viewBox,
    capabilities: data.capabilities,
    fileName: data.fileName,
    ...(data.livePlayback ? { livePlayback: true } : {}),
  };
}

/**
 * The BUILD half of the conversion: parse the SVG layer's original markup
 * (`data`, the engine's `getSvgDocument`) and lay the editable group —
 * carrying the layer's transform / appearance (`carry`, `mirrorCarry`) and
 * the retained source — into `b`. The caller pastes it in the SVG layer's
 * slot and deletes the layer, as ONE engine batch (B3z, svgLayerActions.ts).
 * Null when the document has no vector geometry the parser reaches.
 */
export function buildSvgShapeGroupInto(
  b: FragmentBuilder,
  frame: InsertFrame,
  data: SvgLayerData,
  carry: CarriedTransform,
): BuiltSvgShapes | null {
  const shapes = parseSvgToShapes(data.sourceMarkup, {
    maxDurationSeconds: frame.durationSeconds,
    measureText: measureSvgText,
    intersectPaths: intersectSvgPaths,
  });
  if (shapes.length === 0) return null;
  const groupId = buildSvgIconGroup(b, frame, data.sourceMarkup, data.fileName, {
    x: carry.x,
    y: carry.y,
    targetSize: Math.max(data.intrinsicWidth, data.intrinsicHeight),
    shapes,
  });
  if (!groupId) return null;
  applyCarryTo(b, groupId, carry);
  // Retain the original on the group so Revert works and a future parser can
  // re-run against untouched source. Opt-out honoured, though the cost is
  // negligible next to any raster asset.
  if (getRetainOriginalSvg()) {
    // The fragment's own row (plain data, not a scene-graph view): replaced whole.
    const row = b.row(groupId);
    row.components = [...row.components, { id: `${groupId}_svgsrc`, type: SVG_COMPONENT, props: retainedSvgProps(data) }];
  }
  return { groupId, count: shapes.length, data };
}

/** The user-facing notices of a conversion (no geometry / approximated animation). */
export function notifyNoSvgGeometry(fileName: string): void {
  useUIStore.getState().notify({
    level: 'warning',
    message: `“${fileName}” has no vector paths to convert — it stays an SVG layer.`,
    durationMs: 6000,
  });
}

export function notifySvgConverted(data: SvgLayerData, count: number): void {
  if (isAnimatedSvg(data.capabilities)) {
    useUIStore.getState().notify({
      level: 'info',
      message: `“${data.fileName}” converted to ${count} editable layers. Its animation was approximated as keyframes.`,
      durationMs: 6000,
    });
  }
}

/**
 * Revert to Original SVG, the BUILDER half: a converted group's retained
 * source (`source`, the engine's `getSvgDocument` of the group) laid into `b`
 * as an SVG layer carrying the group's transform (`carry`, `mirrorCarry`). The
 * caller pastes it with the group's removal as ONE engine batch
 * (svgLayerActions.ts `revertSvgToLayer`). Null when the sanitizer refused the
 * markup.
 *
 * Only possible when the source was retained (§13) — which is why retention
 * defaults on: without it this is a one-way door, and "convert" is exactly the
 * kind of operation a user tries in order to see what it does.
 */
export function buildRevertedSvgLayerInto(
  b: FragmentBuilder,
  frame: InsertFrame,
  source: { markup: string; fileName: string },
  carry: CarriedTransform,
): { id: string; warnings: string[] } | null {
  const made = buildSvgLayer(b, frame, source.markup, source.fileName, { x: carry.x, y: carry.y });
  if (!made) return null;
  applyCarryTo(b, made.id, carry);
  return made;
}
