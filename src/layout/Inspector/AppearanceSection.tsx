/**
 * AppearanceSection — Fill & Stroke (and, on a shape, Corners).
 *
 * Split (2026-09-04): this file was 46 KB — one 700-line function holding
 * every fill, stroke, taper, wave, gradient-stop and corner control, plus
 * three helper components above it. It is now the SHELL: the hook guard, the
 * group / ungroup buttons, the preset menu and three sub-rows, each in
 * `appearance/`:
 *
 *   FillRows      paint type, colour, gradient geometry, gizmo, stops, extras
 *   StrokeRows    the switch, width, colour, dash, taper & wave, paint, extras
 *   CornerRows    the link switch, the uniform radius, the four corners
 *   StopLists     the colour-stop and opacity-ramp editors (fill AND stroke)
 *   AnimatablePaintRow  the keyframeable scalar row every group draws
 *
 * The scalar rows read the SELECTION (`—` where the layers disagree, one undo
 * per gesture); the colour, type and switch controls edit the primary layer,
 * as they always did.
 */

import { memo, useCallback } from 'react';
import type { Command } from '@motion/engine-api';
import { useSelectionStore } from '@stores/selectionStore';
import { documentMirror } from '@stores/documentMirror';
import { useMirrorLayer, useMirrorTreeShape } from '@hooks/useMirror';
import { uiKindOf } from '@core/mirror/layerKinds';
import { isLayer } from '@core/mirror/docFacts';
import { edit } from '@core/engine/uiEdits';
import { mirrorFill, mirrorStrokeAt } from '@core/mirror/paintFields';
import type { Stroke } from '@core/paint/stroke';
import type { PresetValue, PresetValues } from '@stores/sectionPresetStore';
import { fillPaintCommands, strokePatchCommands } from './appearance/paintEdits';
import { SectionPresetMenu } from './SectionPresetMenu';
import { useInspectorSelection } from './inspectorSelection';
import { FillRows } from './appearance/FillRows';
import { StrokeRows } from './appearance/StrokeRows';
import { CornerRows } from './appearance/CornerRows';
import styles from './TransformSection.module.css';

export function AppearancePresetAction({
  nodeId,
  nodeIds,
}: {
  nodeId: string;
  nodeIds?: ReadonlyArray<string>;
}): JSX.Element {
  const isText = uiKindOf(useMirrorLayer(nodeId)) === 'text';
  const label = isText ? 'Stroke presets' : 'Fill & Stroke presets';
  const targetIds = useInspectorSelection(nodeId);
  const effectiveNodeIds = nodeIds && nodeIds.length > 0 ? nodeIds : targetIds;

  const capturePreset = useCallback(() => captureAppearance(nodeId), [nodeId]);
  const applyPreset = useCallback(
    (values: PresetValues) => { void applyAppearancePresetEdit(effectiveNodeIds, values); },
    [effectiveNodeIds],
  );

  return (
    <SectionPresetMenu
      sectionId="appearance"
      label={label}
      capture={capturePreset}
      apply={applyPreset}
    />
  );
}

/** The stroke fields a Fill & Stroke preset holds (`captureAppearancePreset`'s `stroke.<key>`). */
const STROKE_PRESET_KEYS: ReadonlyArray<keyof Stroke> = ['enabled', 'color', 'width', 'opacity', 'align', 'cap', 'join'];

function isPresetValue(v: unknown): v is PresetValue {
  return typeof v === 'number' ? Number.isFinite(v) : typeof v === 'string' || typeof v === 'boolean';
}

/**
 * The layer's Fill & Stroke as a preset (the twin of `captureAppearancePreset`,
 * read from the document mirror at call time): the primary fill's colour when
 * it is solid ('' for no fill), and the primary stroke's preset keys.
 */
function captureAppearance(nodeId: string): PresetValues {
  const m = documentMirror();
  const out: Record<string, PresetValue> = {};
  const fill = mirrorFill(m, nodeId);
  if (fill?.type === 'solid') out.fillColor = fill.color;
  else if (fill === undefined) out.fillColor = '';
  const stroke = mirrorStrokeAt(m, nodeId, 0);
  if (stroke) {
    for (const key of STROKE_PRESET_KEYS) {
      const v = stroke[key];
      if (isPresetValue(v)) out[`stroke.${key}`] = v;
    }
  }
  return out;
}

/**
 * A Fill & Stroke preset over these layers as commands: `fillColor` is the
 * primary fill (`layer/fillPaint` — a solid, or none for `''`), the stroke keys
 * patch the primary stroke of the stack (`layer/strokes`, created from the
 * default when the layer has none) — `applyAppearancePreset`'s writes.
 */
export function appearancePresetCommands(nodeIds: ReadonlyArray<string>, values: PresetValues): Command[] {
  const strokePatch: Partial<Record<keyof Stroke, unknown>> = {};
  for (const key of STROKE_PRESET_KEYS) {
    const v = values[`stroke.${key}`];
    if (v !== undefined) strokePatch[key] = v;
  }
  const fillColor = values.fillColor;
  const cmds: Command[] = [];
  for (const id of nodeIds) {
    if (!isLayer(id)) continue;
    if (typeof fillColor === 'string') cmds.push(...fillPaintCommands(id, fillColor ? { type: 'solid', color: fillColor } : undefined));
    if (Object.keys(strokePatch).length > 0) cmds.push(...strokePatchCommands(id, 0, strokePatch as Partial<Stroke>));
  }
  return cmds;
}

/** Apply a Fill & Stroke preset to the selection — one undo entry. */
export function applyAppearancePresetEdit(nodeIds: ReadonlyArray<string>, values: PresetValues): Promise<unknown> {
  return edit('Apply Fill & Stroke preset', appearancePresetCommands(nodeIds, values));
}

/**
 * Group the selection (`groupLayers`, one entry) and select the group.
 * `groupLayers` groups siblings of one parent, so a selection spanning parents
 * is first moved to the composition's root keeping each layer's world pose
 * (`setParent`, same batch) — where the pre-API grouping put the new group.
 */
export async function groupSelection(ids: ReadonlyArray<string>): Promise<void> {
  const m = documentMirror();
  const layers = ids.filter((id) => isLayer(id));
  if (layers.length === 0) return;
  const parentOf = (id: string): string | null => m.layer(id)?.parent ?? null;
  const first = parentOf(layers[0]!);
  const cmds: Command[] = [];
  if (layers.some((id) => parentOf(id) !== first)) {
    const nested = layers.filter((id) => parentOf(id) !== null);
    cmds.push({ type: 'setParent', layers: nested, keepWorldTransform: true });
  }
  cmds.push({ type: 'groupLayers', layers, name: 'Group Assembly' });
  const res = await edit('Group Layers', cmds);
  const group = res.ok ? (res.value[res.value.length - 1] as { layer?: string } | undefined)?.layer : undefined;
  if (group) useSelectionStore.getState().set([group]);
}

/**
 * Detach a node's parts and select them, one entry. A group layer is
 * `ungroupLayer` (its members take its place). Any other layer with children
 * (parenting is nesting) is dissolved the way the pre-API "Detach Parts" did:
 * its children move to the composition's root keeping their world pose, and
 * the emptied layer is deleted (`setParent` + `deleteLayers`). Children behind
 * a precomp barrier belong to another composition and are not detached.
 */
export async function ungroupNode(nodeId: string, children: ReadonlyArray<string>): Promise<void> {
  const m = documentMirror();
  const info = isLayer(nodeId) ? m.layer(nodeId) : undefined;
  if (!info) return;
  let cmds: Command[];
  if (info.kind === 'group') {
    cmds = [{ type: 'ungroupLayer', group: nodeId }];
  } else {
    const parts = children.filter((id) => m.layer(id)?.comp === info.comp);
    if (parts.length === 0 || parts.length !== children.length) return;
    cmds = [
      { type: 'setParent', layers: [...parts], keepWorldTransform: true },
      { type: 'deleteLayers', layers: [nodeId] },
    ];
  }
  const res = await edit('Ungroup', cmds);
  if (!res.ok) return;
  const parts = info.kind === 'group'
    ? (res.value[0] as { layers?: string[] } | undefined)?.layers
    : [...children];
  if (parts && parts.length > 0) useSelectionStore.getState().set(parts);
}

function AppearanceSectionInner({ nodeId }: { nodeId: string }): JSX.Element | null {
  // B4: the header (kind) and the property tree (whether the layer has a
  // Style — its catalog lists `layer/cornersLinked` exactly then). The rows
  // below watch their own properties.
  const layer = useMirrorLayer(nodeId);
  // SHAPE only (`nodes.has`): a value write on the layer — every step of a viewport drag — must not
  // re-render this section and its rows.
  const tree = useMirrorTreeShape(nodeId);

  // No early return above this line: every hook below has to run on every
  // render, including the ones for a node that has just been deleted. Returning
  // before them made React render fewer hooks than the previous pass and throw
  // — deleting a selected layer with this panel open took the editor down.
  const hasStyle = tree?.nodes.has('layer/cornersLinked') === true;
  const isText = uiKindOf(layer) === 'text';

  if (!layer || (!hasStyle && !isText)) return null;

  return (
    <div className={styles.section}>

      {/* Group / Ungroup are layer commands — the layer's right-click menu and
          the Layer menu, where After Effects keeps them — not amber chips at
          the top of the layer's paint (2026-10-07). */}
      {/* A six-button "Quick Style Presets" grid lived here — a second preset
          grid ONE ACCORDION away from the registry-backed Style Presets section
          in this same panel, with its own hard-coded looks that bypassed
          `applyStylePreset`. Removed rather than kept in sync: the presets
          section previews the real paint stack and covers all four categories
          plus 3D materials. */}
      <div className={styles.inlineRows}>
        {/* Text layers own Character Color in CharacterPanel. Editing paint fill
            here wrote the same prop and looked like a duplicate background
            picker — hide Fill chrome on text; Stroke remains. */}
        {/* AE's Contents order: the shape's own parameter (Roundness), then
            Fill, then Stroke. */}
        {hasStyle && <CornerRows nodeId={nodeId} />}

        {!isText && <FillRows nodeId={nodeId} />}

        <StrokeRows nodeId={nodeId} />
      </div>
    </div>
  );
}


/*
 * Memoized: the Properties panel re-renders for its own reasons (a selection
 * change, a sub-tab switch, the sticky header) and hands every section the
 * same `nodeId` it had before. Without this boundary the section would rebuild
 * its whole subtree on each of those, undoing the per-node subscriptions the
 * rows inside it use to stay asleep. Pinned by `inspectorRenderScope.test.tsx`.
 */
export const AppearanceSection = memo(AppearanceSectionInner);

export default AppearanceSection;
