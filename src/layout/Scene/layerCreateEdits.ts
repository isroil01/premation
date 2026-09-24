/**
 * Layer ▸ Create verbs through the engine API (B3z, docs/B3_PATTERNS.md §6,
 * ENGINE_API.md §15.9 "off-document builders"): Create Shapes from Text and
 * Create Nulls From Path Points. The Layers panel's row menu and the Layer
 * menu commands call these, so there is one implementation.
 *
 * Both are client macros: the geometry is computed in the editor (glyph
 * outlines need its fonts; a path's vertices are sampled at the playhead), the
 * new layers are BUILT off-document and sent as ONE `pasteLayers` — one undo
 * entry, engine-minted ids, the result selected.
 */

import type { Command } from '@motion/engine-api';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { outlineTextNode, type ShapesFromTextSource } from '@core/scene/shapesFromText';
import { createNullsFromPath } from '@core/scene/nullsFromPaths';
import { compOfLayer, graph as docGraph, isLayer, layerKindOf } from '@core/engine/doc';
import { insertBuiltLayers } from '@core/engine/offDocument';
import type { SceneNode } from '@core/types';

type Outlines = NonNullable<Awaited<ReturnType<typeof outlineTextNode>>>;

/**
 * The outline shape layer `createShapesFromText` makes, and the parent it goes
 * under beside the text (front-most among its siblings). Transform copied from
 * the text so the outlines coincide with it. Pure: the build adds it.
 */
function outlineShape(textId: string, outlines: Outlines): { parent: string; shape: SceneNode } | null {
  const node = docGraph.getNode(textId);
  if (!node) return null;
  const t = node.components.find((c) => c.type === 'Transform')?.props as Record<string, unknown> | undefined;
  const style = node.components.find((c) => c.type === 'Style' || c.type === 'Text')?.props as Record<string, unknown> | undefined;
  const num = (v: unknown, fb: number): number => (typeof v === 'number' ? v : fb);
  const id = `shape_from_text_${textId}`;
  const parent = node.parent ?? 'comp_root';
  const fill = typeof style?.fill === 'string' ? style.fill : '#ffffff';
  const shape: SceneNode = {
    id,
    name: `${node.name ?? 'Text'} Outlines (${outlines.source})`,
    parent,
    children: [],
    transform: {
      position: { x: num(t?.x, 0), y: num(t?.y, 0) },
      rotation: num(t?.rotation, 0),
      scale: { x: num(t?.scaleX, 1), y: num(t?.scaleY, 1) },
    },
    visible: true,
    locked: false,
    components: [
      {
        id: `${id}_t`,
        type: 'Transform',
        props: {
          [SCENE_KIND_PROP]: 'shape',
          x: num(t?.x, 0), y: num(t?.y, 0), rotation: num(t?.rotation, 0),
          scaleX: num(t?.scaleX, 1), scaleY: num(t?.scaleY, 1),
          width: outlines.w, height: outlines.h,
          shapeType: 'path',
        },
      },
      { id: `${id}_s`, type: 'Style', props: { fill, opacity: num(style?.opacity, 100) } },
      // Runs, never the flat point list: a letter with a counter is two runs.
      { id: `${id}_g`, type: 'Geometry', props: { subpaths: outlines.runs } },
    ],
  };
  return { parent, shape };
}

/**
 * AE's Layer ▸ Create ▸ Create Shapes from Text: the glyph outlines (from the
 * font, or traced — `outlineTextNode`) as a path layer beside the text, and the
 * text hidden (AE keeps it). ONE batch: `pasteLayers` of the built shape +
 * `setLayerSwitches{visible:false}` on the text; the shape is selected.
 * Resolves to the new layer's id and which source produced the outlines, or
 * null when the text could not be outlined (or the engine refused, toasted).
 */
export async function shapesFromTextEdit(
  nodeId: string,
  seconds: number,
): Promise<{ id: string; source: ShapesFromTextSource } | null> {
  const comp = isLayer(nodeId) ? compOfLayer(nodeId) : null;
  if (!comp) return null;
  const node = docGraph.getNode(nodeId);
  if (!node || layerKindOf(node) !== 'text') return null;
  const outlines = await outlineTextNode(node, seconds);
  if (!outlines) return null;
  const hide: Command = { type: 'setLayerSwitches', layers: [nodeId], patch: { visible: false } };
  const ids = await insertBuiltLayers('Create Shapes from Text', comp, () => {
    const made = outlineShape(nodeId, outlines);
    if (made) defaultSceneGraph.addChild(made.parent, made.shape);
  }, { after: [hide] });
  if (!ids || ids.length === 0) return null;
  return { id: ids[0]!, source: outlines.source };
}

/**
 * Create Nulls From Path Points (Nulls Follow Points): a null at every vertex
 * of the shape's outline at the playhead, parented to (nested in) the shape —
 * `createNullsFromPath`, built off-document and sent as ONE `pasteLayers` INTO
 * the shape. The nulls are selected. Resolves to their ids (`[]` when the
 * layer has no path points, or the engine refused — toasted).
 *
 * The live direction (Points Follow Nulls) also binds each vertex to its null
 * (`Geometry.pointBindings` on the shape), which no API property addresses —
 * that command stays on the legacy writer.
 */
export async function nullsFromPathEdit(shapeId: string, seconds: number): Promise<string[]> {
  const comp = isLayer(shapeId) ? compOfLayer(shapeId) : null;
  if (!comp) return [];
  const ids = await insertBuiltLayers('Create Nulls From Path Points', comp, () => createNullsFromPath(shapeId, seconds));
  return ids ?? [];
}
