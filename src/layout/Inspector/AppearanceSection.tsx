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
import type { Command } from '@motion/engine-api';
import { useSceneRevision } from '@stores/sceneStore';
import { useAnimationRevision } from '@hooks/useAnimationRevision';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { Icon } from '@components/Icon';
import { useSelectionStore } from '@stores/selectionStore';
import { documentMirror } from '@stores/documentMirror';
import { isLayer } from '@core/engine/doc';
import { edit } from '@core/engine/uiEdits';
import { captureAppearancePreset } from '@core/inspector/sectionPresets';
import type { Stroke } from '@core/paint/stroke';
import type { PresetValues } from '@stores/sectionPresetStore';
import { fillPaintCommands, strokePatchCommands } from './appearance/paintEdits';
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

  const childIds = defaultSceneGraph.getChildren(node.id).map((c) => c.id);
  const isGroupNode = childIds.length > 0 || node.components.some((c) => c.type === 'group');

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
            onClick={() => { void ungroupNode(nodeId, childIds); }}
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
