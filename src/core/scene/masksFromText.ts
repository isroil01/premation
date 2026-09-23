/**
 * Create Masks from Text — AE's Layer ▸ Create ▸ Create Masks from Text.
 *
 * AE's result, reproduced: a NEW comp-sized solid in the text's fill colour
 * holding one mask per glyph contour (counters as Subtract masks — see
 * `masksFromTextGeometry.ts`), and the text layer hidden rather than deleted.
 * Masks, not a shape layer, because the point of this command is what masks
 * can do and shapes cannot: feather per glyph, stroke/scribble effects that
 * read mask paths, and text-on-path style reveals.
 *
 * Outlines come from `outlineTextNode` — the font's own Béziers when the face
 * can be read, a trace otherwise — the same choice Create Shapes from Text
 * makes, so the two commands never disagree about a layer's geometry.
 *
 * ## Spaces
 *
 * The outlines are in the TEXT layer's space; masks live in the SOLID's.
 * Both conversions go through `layerSpaceAt` — text → comp, comp → solid — the
 * same functions the renderer's matrices back. So a rotated, scaled, parented
 * (or 3D) text layer produces masks that sit on the glyphs as drawn, and a
 * solid added under a transformed parent still receives correct masks.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import { makeNode } from '@core/scene/sceneInsert';
import { activeCompRootId, activeCompSize } from '@core/scene/activeComp';
import { layerSpaceAt } from '@core/scene/layerSpace';
import { addMaskPath } from '@core/effects/mask';
import { runDocumentEdit } from '@core/commands/documentEdit';
import { getTimelineController } from '@core/timeline/TimelineController';
import { useSelectionStore } from '@stores/selectionStore';
import type { SceneNode } from '@core/types';
import { outlineTextNode, canCreateShapesFromText, type ShapesFromTextSource } from './shapesFromText';
import { glyphContoursToMaskPaths } from './masksFromTextGeometry';

/** Same precondition as Create Shapes from Text: one text layer with content. */
export const canCreateMasksFromText = canCreateShapesFromText;

/** The text's fill: the Text component's, then any component's, then white. */
export function textFillOf(node: SceneNode): string {
  const text = node.components.find((c) => c.type === 'Text')?.props as Record<string, unknown> | undefined;
  if (typeof text?.fill === 'string') return text.fill;
  for (const c of node.components) {
    const f = (c.props as Record<string, unknown>).fill;
    if (typeof f === 'string') return f;
  }
  return '#ffffff';
}

export interface MasksFromTextResult {
  id: string;
  source: ShapesFromTextSource;
  masks: number;
}

/** The asynchronous half: the text's outlines and placement, read at `compTime`. */
export interface MasksFromTextPlan {
  nodeId: string;
  compTime: number;
  outlines: NonNullable<Awaited<ReturnType<typeof outlineTextNode>>>;
  comp: ReturnType<typeof activeCompSize>;
  textSpace: NonNullable<ReturnType<typeof layerSpaceAt>>;
}

/**
 * Outline the text (fonts are loaded asynchronously) and read where it sits.
 * Null when the text cannot be outlined or placed. `compTime` is the
 * composition time the text's placement is read at (the playhead by default) —
 * an animated text layer is captured where it is now, as AE does.
 */
export async function planMasksFromText(
  nodeId: string,
  compTime: number = getTimelineController().currentSeconds,
): Promise<MasksFromTextPlan | null> {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || readNodeKind(node) !== 'text') return null;
  const outlines = await outlineTextNode(node, compTime);
  if (!outlines || outlines.runs.length === 0) return null;
  const comp = activeCompSize();
  const textSpace = layerSpaceAt(nodeId, compTime, comp);
  if (!textSpace) return null;
  return { nodeId, compTime, outlines, comp, textSpace };
}

/**
 * The synchronous BUILD: add the comp-sized solid (in the text's colour, beside
 * the text in its parent) with one mask per glyph contour. Changes nothing
 * else — the editor runs it off-document and sends the solid as `pasteLayers`
 * (+ hiding the text) in one batch (layout/Text/textEdits.ts
 * `masksFromTextEdit`). Null when the solid cannot be placed.
 */
export function buildMasksFromTextSolid(plan: MasksFromTextPlan): MasksFromTextResult | null {
  const node = defaultSceneGraph.getNode(plan.nodeId);
  if (!node) return null;
  const { outlines, comp, textSpace, compTime } = plan;
  const solid = makeNode('shape', `${node.name ?? 'Text'} Outlines`);
  const t = solid.components.find((c) => c.type === 'Transform');
  if (t) {
    Object.assign(t.props, {
      x: comp.width / 2, y: comp.height / 2, width: comp.width, height: comp.height,
      anchorX: 0, anchorY: 0, rotation: 0, scaleX: 1, scaleY: 1,
    });
  }
  solid.transform.position.x = comp.width / 2;
  solid.transform.position.y = comp.height / 2;
  const parent = node.parent && defaultSceneGraph.getNode(node.parent) ? node.parent : activeCompRootId();
  defaultSceneGraph.addChild(parent, solid);
  defaultSceneGraph.setSolid(solid.id, true);
  defaultSceneGraph.setFill(solid.id, { type: 'solid', color: textFillOf(node) });
  const solidSpace = layerSpaceAt(solid.id, compTime, comp);
  if (!solidSpace) return null;
  const paths = glyphContoursToMaskPaths(
    outlines.runs,
    (x, y) => solidSpace.fromComp(textSpace.toComp([x, y])),
    (i) => `mask_text_${solid.id}_${i}`,
  );
  for (const p of paths) addMaskPath(solid.id, p);
  return { id: solid.id, source: outlines.source, masks: paths.length };
}

/**
 * Legacy one-shot form (pre-API callers): build the solid and its masks, hide
 * the text, one `runDocumentEdit`. The editor's command goes through the
 * engine (`masksFromTextEdit`).
 */
export async function createMasksFromText(
  nodeId: string,
  compTime: number = getTimelineController().currentSeconds,
): Promise<MasksFromTextResult | null> {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || readNodeKind(node) !== 'text') return null;
  const plan = await planMasksFromText(nodeId, compTime);
  if (!plan) return null;
  return runDocumentEdit('Create Masks from Text', () => {
    const made = buildMasksFromTextSolid(plan);
    if (!made) return null;
    // AE hides the source text rather than deleting it: the text is still the
    // editable truth, the masks a derivative of one moment of it.
    const src = defaultSceneGraph.getNode(nodeId);
    if (src) src.visible = false;
    useSelectionStore.getState().set([made.id]);
    return made;
  });
}
