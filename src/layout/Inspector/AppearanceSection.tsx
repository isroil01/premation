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

import { memo, useMemo, useCallback } from 'react';
import { useSceneRevision } from '@stores/sceneStore';
import { useAnimationRevision } from '@hooks/useAnimationRevision';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { Icon } from '@components/Icon';
import { groupSelectedNodes, ungroupSelectedNode } from '@core/scene/sceneInsert';
import { useSelectionStore } from '@stores/selectionStore';
import { isLayer } from '@core/engine/doc';
import { edit } from '@core/engine/uiEdits';
import { readNodeKind } from '@core/scene/sceneDerive';
import { applyAppearancePreset, captureAppearancePreset } from '@core/inspector/sectionPresets';
import { SectionPresetMenu } from './SectionPresetMenu';
import { useInspectorSelection } from './inspectorSelection';
import { FillRows } from './appearance/FillRows';
import { StrokeRows } from './appearance/StrokeRows';
import { CornerRows } from './appearance/CornerRows';
import styles from './TransformSection.module.css';
import effStyles from '../Effects/EffectsPanel.module.css';

export function AppearancePresetAction({
  nodeId,
  nodeIds,
}: {
  nodeId: string;
  nodeIds?: ReadonlyArray<string>;
}): JSX.Element {
  const node = defaultSceneGraph.getNode(nodeId);
  const isText = node ? node.components.some((c) => c.type === 'Text') : false;
  const label = isText ? 'Stroke presets' : 'Fill & Stroke presets';
  const targetIds = useInspectorSelection(nodeId);
  const effectiveNodeIds = nodeIds && nodeIds.length > 0 ? nodeIds : targetIds;

  const capturePreset = useCallback(() => captureAppearancePreset(nodeId), [nodeId]);
  const applyPreset = useCallback(
    (values: Readonly<Record<string, number | string | boolean>>) =>
      // B3-legacy: engine gap — a Fill & Stroke preset writes fill/stroke PAINT objects (solid / gradient / stroke stack), which have no API property yet.
      applyAppearancePreset(effectiveNodeIds, values),
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

/**
 * Group the selection (`groupLayers`, one entry) and select the group. The
 * API groups layers that share a parent; a selection spanning parents keeps
 * the legacy grouping (engine gap).
 */
async function groupSelection(ids: ReadonlyArray<string>): Promise<void> {
  const layers = ids.filter((id) => isLayer(id));
  const parent = layers.length > 0 ? defaultSceneGraph.getNode(layers[0]!)?.parent : undefined;
  if (layers.length !== ids.length || layers.some((id) => defaultSceneGraph.getNode(id)?.parent !== parent)) {
    // B3-legacy: engine gap — `groupLayers` needs one parent; the legacy grouping reparents a mixed selection under a new group in the active comp.
    groupSelectedNodes();
    return;
  }
  const res = await edit('Group Layers', { type: 'groupLayers', layers, name: 'Group Assembly' });
  const group = res.ok ? (res.value[0] as { layer?: string } | undefined)?.layer : undefined;
  if (group) useSelectionStore.getState().set([group]);
}

/** Detach a group's parts (`ungroupLayer`, one entry) and select them. */
async function ungroupNode(nodeId: string): Promise<void> {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || !isLayer(nodeId) || readNodeKind(node) !== 'group') {
    // B3-legacy: engine gap — `ungroupLayer` takes group LAYERS only; detaching the children of any other parent node has no API form.
    ungroupSelectedNode(nodeId);
    return;
  }
  const res = await edit('Ungroup', { type: 'ungroupLayer', group: nodeId });
  const parts = res.ok ? (res.value[0] as { layers?: string[] } | undefined)?.layers : undefined;
  if (parts && parts.length > 0) useSelectionStore.getState().set(parts);
}

function AppearanceSectionInner({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  useAnimationRevision();
  const node = defaultSceneGraph.getNode(nodeId);

  // No early return above this line: every hook below has to run on every
  // render, including the ones for a node that has just been deleted. Returning
  // before them made React render fewer hooks than the previous pass and throw
  // — deleting a selected layer with this panel open took the editor down.
  const styleComp = useMemo(() => node?.components.find((c) => c.type === 'Style'), [node]);
  const textComp = useMemo(() => node?.components.find((c) => c.type === 'Text'), [node]);
  const sComp = styleComp ?? textComp;

  // Hoisted above the `!node || !sComp` guard with the other hooks — it used to
  // sit below it, which is what made the hook count vary between renders.
  const selectedIds = useSelectionStore((s) => s.ids);

  if (!node || !sComp) return null;

  const isGroupNode = defaultSceneGraph.getChildren(node.id).length > 0 || node.components.some((c) => c.type === 'group');

  return (
    <div className={styles.section}>

      {/* Group Assembly Actions (Group / Ungroup Sub-Parts) */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, padding: '0 4px' }}>
        {selectedIds.length > 1 && (
          <button
            type="button"
            className={effStyles.addChip}
            style={{ flex: 1, justifyContent: 'center', background: 'rgba(245, 176, 65, 0.12)', color: '#f5b041', borderColor: 'rgba(245, 176, 65, 0.35)', gap: 5 }}
            onClick={() => { void groupSelection(selectedIds); }}
          >
            <Icon name="folder" size="sm" style={{ color: '#f5b041' }} />
            <span>Group Parts (⌘G)</span>
          </button>
        )}
        {isGroupNode && (
          <button
            type="button"
            className={effStyles.addChip}
            style={{ flex: 1, justifyContent: 'center', borderColor: 'var(--color-border-glass)', gap: 5 }}
            onClick={() => { void ungroupNode(nodeId); }}
          >
            <Icon name="layout" size="sm" />
            <span>Detach Parts (Ungroup)</span>
          </button>
        )}
      </div>

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
        {!textComp && <FillRows nodeId={nodeId} />}

        <StrokeRows nodeId={nodeId} />

        {styleComp && <CornerRows nodeId={nodeId} styleCompId={styleComp.id} />}
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
