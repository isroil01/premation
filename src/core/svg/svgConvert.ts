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
 * on the resulting group, so `revertSvgGroupToLayer` can put it back exactly,
 * and a future release with a better parser can re-run the conversion against
 * the untouched source (§13).
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { bumpScene } from '@stores/sceneStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useUIStore } from '@stores/uiStore';
import { runDocumentEdit } from '@core/commands/documentEdit';
import { insertSvgShapeGroup, insertSvgLayer, measureSvgText, intersectSvgPaths } from '@core/scene/sceneInsert';
import { parseSvgToShapes } from '../../utils/svgParser';
import {
  readSvgLayer,
  readRetainedSvgSource,
  forgetSvgLayerSrc,
  stripToRetainedSource,
  SVG_COMPONENT,
  type SvgLayerData,
} from './svgLayer';
import { isAnimatedSvg } from './svgCapabilities';
import { getRetainOriginalSvg } from './svgPreferences';

/** The layer properties that must survive the swap in either direction. */
interface CarriedTransform {
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

/** Read the transform/appearance a converted node has to inherit. */
function carryFrom(nodeId: string): CarriedTransform {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return {};
  const out: CarriedTransform = {
    name: node.name,
    visible: node.visible,
    locked: node.locked,
    color: node.color,
  };
  for (const c of node.components) {
    const p = c.props as Record<string, unknown>;
    if (typeof p.x === 'number') out.x = p.x;
    if (typeof p.y === 'number') out.y = p.y;
    if (typeof p.rotation === 'number') out.rotation = p.rotation;
    if (typeof p.scaleX === 'number') out.scaleX = p.scaleX;
    if (typeof p.scaleY === 'number') out.scaleY = p.scaleY;
    if (typeof p.opacity === 'number') out.opacity = p.opacity;
  }
  return out;
}

/**
 * Apply a carried transform onto a freshly created node.
 *
 * Every component write goes through `writeProp`: `node.components` is a live
 * view rebuilt from the engine on each read, and its `props` are copies, so
 * assigning to them mutates a throwaway object and is silently lost. The node's
 * own fields (name / visible / locked / color) DO proxy back, so those are
 * assigned directly.
 */
function applyCarry(nodeId: string, carry: CarriedTransform): void {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;
  if (carry.name) node.name = carry.name;
  if (carry.visible !== undefined) node.visible = carry.visible;
  if (carry.locked !== undefined) node.locked = carry.locked;
  if (carry.color !== undefined) node.color = carry.color;

  const write = (type: string, prop: string, value: unknown): void => {
    const c = node.components.find((k) => k.type === type);
    if (c) defaultSceneGraph.writeProp(nodeId, c.id, prop, value);
  };
  if (carry.rotation !== undefined) write('Transform', 'rotation', carry.rotation);
  if (carry.scaleX !== undefined) write('Transform', 'scaleX', carry.scaleX);
  if (carry.scaleY !== undefined) write('Transform', 'scaleY', carry.scaleY);
  if (carry.opacity !== undefined) write('Style', 'opacity', carry.opacity);
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
export function convertSvgLayerToShapes(nodeId: string): string | null {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return null;
  const data = readSvgLayer(node);
  if (!data) return null;

  const carry = carryFrom(nodeId);

  return runDocumentEdit('Convert SVG to Editable Shapes', () => {
    const shapes = parseSvgToShapes(data.sourceMarkup, {
      maxDurationSeconds: useCompositionStore.getState().durationSeconds,
      measureText: measureSvgText,
      intersectPaths: intersectSvgPaths,
    });
    if (shapes.length === 0) {
      useUIStore.getState().notify({
        level: 'warning',
        message: `“${data.fileName}” has no vector paths to convert — it stays an SVG layer.`,
        durationMs: 6000,
      });
      return null;
    }

    const groupId = insertSvgShapeGroup(data.sourceMarkup, data.fileName, {
      x: carry.x,
      y: carry.y,
      targetSize: Math.max(data.intrinsicWidth, data.intrinsicHeight),
      shapes,
    });
    if (!groupId) return null;

    applyCarry(groupId, carry);

    // Retain the original on the group so Revert works and a future parser can
    // re-run against untouched source. Opt-out honoured, though the cost is
    // negligible next to any raster asset.
    if (getRetainOriginalSvg()) {
      const src = node.components.find((c) => c.type === SVG_COMPONENT);
      if (src) {
        defaultSceneGraph.addComponent(groupId, {
          id: `${groupId}_svgsrc`,
          type: SVG_COMPONENT,
          props: stripToRetainedSource({ ...(src.props as Record<string, unknown>) }),
        });
      }
    }

    forgetSvgLayerSrc(nodeId);
    defaultSceneGraph.removeNode(nodeId);
    useSelectionStore.getState().set([groupId]);
    bumpScene();

    if (isAnimatedSvg(data.capabilities)) {
      useUIStore.getState().notify({
        level: 'info',
        message: `“${data.fileName}” converted to ${shapes.length} editable layers. Its animation was approximated as keyframes.`,
        durationMs: 6000,
      });
    }
    return groupId;
  });
}

/**
 * Put a converted group back to the original SVG layer.
 *
 * Only possible when the source was retained (§13) — which is why retention
 * defaults on: without it this is a one-way door, and "convert" is exactly the
 * kind of operation a user tries in order to see what it does.
 */
export function revertSvgGroupToLayer(nodeId: string): string | null {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return null;
  const retained = readRetainedSvgSource(node);
  if (!retained) return null;

  const carry = carryFrom(nodeId);

  return runDocumentEdit('Revert to Original SVG', () => {
    const id = insertSvgLayer(retained.markup, retained.fileName, { x: carry.x, y: carry.y });
    if (!id) return null;
    applyCarry(id, carry);
    defaultSceneGraph.removeNode(nodeId);
    useSelectionStore.getState().set([id]);
    bumpScene();
    return id;
  });
}

/** True when this node keeps an original SVG it could be reverted to. */
export function canRevertToSvg(nodeId: string): boolean {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return false;
  // An SVG layer is already the original — revert only means something for a
  // group that was converted away from one.
  if (readSvgLayer(node)) return false;
  return readRetainedSvgSource(node) !== null;
}
