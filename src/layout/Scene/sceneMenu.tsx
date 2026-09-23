/**
 * The Layers panel's row context menu.
 *
 * Built here rather than inline in `ScenePanel` for two reasons: it is the
 * largest single thing that panel does, and it is worth testing as a LIST —
 * "does Time ▸ Time-Reverse reach the layer time command" is a question about
 * this table, not about React.
 *
 * ── What it offers, and why it is more than it was ────────────────────
 * The Layers panel is where users pick a layer, so it is where they expect to
 * act on one. It used to offer nine verbs while the app had implemented four
 * times that many — Create Nulls from Paths, Create Shapes from Text, Split
 * Layer, Time Stretch, Time-Reverse, Fit to Comp, Align, Blending Mode, Track
 * Matte and Parent were all shipped, wired and reachable from somewhere else.
 * A command that exists and cannot be found from the panel the user is looking
 * at is, from their side, a command that does not exist.
 *
 * Every entry routes to the SAME implementation the menu bar and the timeline
 * use. Nothing here re-implements a verb.
 */

import type { ContextMenuItem } from '@stores/contextMenuStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import { useSelectionStore } from '@stores/selectionStore';
import { useProjectStore } from '@stores/projectStore';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { asCommandId } from '@app-types/common';
import {
  arrangeNodes,
  eligibleParents,
  parentOfNode,
  parentOptionsFor,
  reparentNode,
} from '@core/scene/parenting';
import {
  deleteSelectedLayers,
  duplicateSelectedLayers,
  groupSelectedLayers,
  ungroupSelected,
} from '@core/scene/sceneInsert';
import { toggleLayerSwitchAnchored } from './layerSwitchEdits';
import { liveMergeSelectedPaths, mergeSelectedPaths } from '@core/scene/mergePaths';
import { rigLogoForAnimation } from '@core/scene/rigLogo';
import { createNullsFromPathUndoable } from '@core/scene/nullsFromPaths';
import { canCreateShapesFromText, createShapesFromText } from '@core/scene/shapesFromText';
import { createMasksFromText } from '@core/scene/masksFromText';
import { LAYER_FLAGS, describeLayerFlag, layerFlagAvailable, readLayerFlag, toggleLayerFlags } from '@core/scene/layerFlags';
import { LABEL_COLORS, nodesWithLabelColor, readNodeLabelColor, setNodeLabelColor } from '@core/scene/labelColor';
import { alignNodes, type AlignMode } from '@core/scene/alignNodes';
import { readNodeBlend, setNodeBlend, type LayerBlendMode } from '@core/effects/blendMode';
import { blendModeLabel, blendModeSections } from '@layout/Inspector/blendMenu';
import { MATTE_OPTIONS, applyMatteOption, matteOptionId } from '@components/MatteControl/matteMenu';
import { readNodeMatte, setNodeMatte } from '@core/effects/matte';
import { isRetimableLayer, toggleFreeze, toggleReverse } from '@core/animation/layerTimeCommands';
import { getTimelineController } from '@core/timeline/TimelineController';
import { getTime } from '@stores/playbackClockStore';
import { svgContextMenuItems } from '@layout/Inspector/svgLayerActions';
import { openPrecomposeDialog } from '@layout/Composition/PrecomposeDialog';
import { runDocumentEdit } from '@core/commands/documentEdit';
import { bumpScene } from '@stores/sceneStore';
import { useUIStore } from '@stores/uiStore';
import styles from '@layout/EditorLayout/panels.module.css';

/** Run a registered command by id — the menu bar's route, so the enabled gate,
 *  the undo entry and the shortcut all stay one implementation. */
function run(id: string): void {
  void getCommandSystem().execute(asCommandId(id));
}

/** A small round swatch shown next to a color name in the Label Color menu. */
function LabelSwatch({ color }: { color: string }): JSX.Element {
  return <span aria-hidden="true" className={styles.labelSwatch} style={{ background: color }} />;
}

/**
 * "Label Color" submenu (AE-style): the fixed swatch palette + a None entry
 * that clears back to the layer kind's default category color. Applies to the
 * whole selection when the clicked layer is part of it (AE behavior).
 */
export function labelColorMenuItems(targetId: string): ContextMenuItem[] {
  const sel = useSelectionStore.getState().ids;
  const ids: string[] = sel.includes(targetId) ? [...sel] : [targetId];
  const node = defaultSceneGraph.getNode(targetId);
  const current = node ? readNodeLabelColor(node) : undefined;
  return [
    {
      id: 'label-none',
      label: 'None (Default)',
      icon: current === undefined ? 'check' : undefined,
      onSelect: () => setNodeLabelColor(ids, undefined),
    },
    { id: 'label-sep', separator: true },
    ...LABEL_COLORS.map((c): ContextMenuItem => ({
      id: `label-${c.id}`,
      label: (
        <>
          <LabelSwatch color={c.color} />
          {c.label}
        </>
      ),
      icon: current === c.color ? 'check' : undefined,
      onSelect: () => setNodeLabelColor(ids, c.color),
    })),
    { id: 'label-select-sep', separator: true },
    {
      id: 'label-select-same',
      // The other half of what a label is FOR. Assigning colours only pays off
      // if you can then act on the group; without this the palette is
      // decoration. Matches the UNLABELLED set too, which is how you find the
      // layers you forgot to tag.
      label: 'Select All with This Label',
      onSelect: () => {
        const matches = nodesWithLabelColor(targetId);
        if (matches.length) useSelectionStore.getState().set(matches);
      },
    },
  ];
}

/** The AE switch set as a submenu, for the switches not drawn on the row. */
function switchesMenuItems(targetId: string, ids: ReadonlyArray<string>): ContextMenuItem[] {
  const node = defaultSceneGraph.getNode(targetId);
  if (!node) return [];
  return LAYER_FLAGS.filter((def) => layerFlagAvailable(node, def.id)).map((def) => ({
    id: `flag-${def.id}`,
    // Named for THIS layer — the sunburst and Quality each say something
    // different depending on what they are sitting on.
    label: describeLayerFlag(node, def.id).label,
    icon: readLayerFlag(node, def.id) ? 'check' : undefined,
    onSelect: def.id === 'shy'
      ? () => { void toggleLayerSwitchAnchored(targetId, 'shy'); }
      : () => toggleLayerFlags(ids, def.id, targetId),
  }));
}

function blendMenuItems(targetId: string, ids: ReadonlyArray<string>): ContextMenuItem[] {
  const node = defaultSceneGraph.getNode(targetId);
  const current = node ? readNodeBlend(node) : undefined;
  const out: ContextMenuItem[] = [];
  blendModeSections().forEach((section, i) => {
    if (i > 0) out.push({ id: `blend-sep-${i}`, separator: true });
    for (const mode of section.modes) {
      out.push({
        id: `blend-${mode}`,
        label: blendModeLabel(mode),
        icon: current === mode ? 'check' : undefined,
        onSelect: () => applyBlendMode(ids, mode),
      });
    }
  });
  return out;
}

function applyBlendMode(ids: ReadonlyArray<string>, mode: LayerBlendMode): void {
  runDocumentEdit(ids.length === 1 ? 'Blending Mode' : `Blending Mode (${ids.length} layers)`, () => {
    for (const id of ids) setNodeBlend(id, mode);
    bumpScene();
  });
}

function matteMenuItems(targetId: string): ContextMenuItem[] {
  const node = defaultSceneGraph.getNode(targetId);
  if (!node) return [];
  const stored = readNodeMatte(node);
  const currentId = matteOptionId(stored);
  return MATTE_OPTIONS.map((opt) => ({
    id: `matte-${opt.id}`,
    label: opt.label,
    icon: currentId === opt.id ? 'check' : undefined,
    onSelect: () => {
      runDocumentEdit('Track Matte', () => {
        setNodeMatte(targetId, applyMatteOption(stored, opt.id));
        bumpScene();
      });
    },
  }));
}

/**
 * Parent submenu — the drop-down half of the timeline's parent control. The
 * pick-whip half is on the row itself (`ScenePanel`'s `renderLead`); both call
 * the same `reparentNode`, so parenting cannot mean two different things
 * depending on which control was used.
 */
function parentMenuItems(targetId: string): ContextMenuItem[] {
  const options = eligibleParents(targetId);
  const current = parentOfNode(targetId);
  return [
    {
      id: 'parent-none',
      label: 'None',
      icon: current === null ? 'check' : undefined,
      onSelect: () => reparentNode(targetId, null),
    },
    ...(options.length ? [{ id: 'parent-sep', separator: true } as ContextMenuItem] : []),
    ...options.map((o): ContextMenuItem => ({
      id: `parent-${o.id}`,
      label: o.name,
      icon: current === o.id ? 'check' : undefined,
      onSelect: () => reparentNode(targetId, o.id, parentOptionsFor({ altKey: false, shiftKey: false })),
    })),
  ];
}

const ALIGN_ITEMS: ReadonlyArray<{ id: AlignMode; label: string }> = [
  { id: 'left', label: 'Left Edges' },
  { id: 'center-h', label: 'Horizontal Centres' },
  { id: 'right', label: 'Right Edges' },
  { id: 'top', label: 'Top Edges' },
  { id: 'middle-v', label: 'Vertical Centres' },
  { id: 'bottom', label: 'Bottom Edges' },
];

function alignMenuItems(ids: ReadonlyArray<string>): ContextMenuItem[] {
  const comp = activeCompSize();
  return [
    ...ALIGN_ITEMS.map((a): ContextMenuItem => ({
      id: `align-${a.id}`,
      label: a.label,
      onSelect: () => {
        runDocumentEdit('Align Layers', () => {
          alignNodes([...ids], a.id, 'selection', comp.width, comp.height);
          bumpScene();
        });
      },
    })),
    { id: 'align-sep', separator: true },
    ...(['distribute-h', 'distribute-v'] as const).map((mode): ContextMenuItem => ({
      id: `align-${mode}`,
      label: mode === 'distribute-h' ? 'Distribute Horizontally' : 'Distribute Vertically',
      // AE greys distribution out below three layers, because two layers are
      // already evenly distributed and the command would be a no-op.
      disabled: ids.length < 3,
      onSelect: () => {
        runDocumentEdit('Distribute Layers', () => {
          alignNodes([...ids], mode as AlignMode, 'selection', comp.width, comp.height);
          bumpScene();
        });
      },
    })),
  ];
}

function activeCompSize(): { width: number; height: number } {
  const p = useProjectStore.getState();
  const compId = p.activeTabId ? p.tabs[p.activeTabId]?.compositionId : undefined;
  const comp = compId ? p.comps[compId] : undefined;
  return { width: comp?.width ?? 1920, height: comp?.height ?? 1080 };
}

function notify(message: string, level: 'info' | 'warning' = 'info'): void {
  useUIStore.getState().notify({ level, message, durationMs: 3000 });
}

export interface SceneMenuDeps {
  /** Start the inline rename on this row (panel state). */
  startRename: (id: string) => void;
}

/**
 * The full row menu. `targetId` is the RIGHT-CLICKED row; `ids` is what the
 * verbs apply to — the selection when the row is in it, that row alone
 * otherwise. Labels are anchored on the target so "Unlock" and the action agree
 * even when the rest of the selection is in the other state.
 */
export function sceneNodeMenuItems(targetId: string, deps: SceneMenuDeps): ContextMenuItem[] {
  const node = defaultSceneGraph.getNode(targetId);
  if (!node) return [];
  const sel = useSelectionStore.getState().ids;
  const ids = sel.includes(targetId) ? [...sel] : [targetId];
  const many = ids.length >= 2;

  const hidden = node.visible === false;
  const locked = node.locked === true;
  const solo = node.solo === true;
  const kind = readNodeKind(node);
  const isGroup = kind === 'group';
  const isRoot = node.parent === null;
  const isText = kind === 'text' && canCreateShapesFromText(targetId);
  const isShape = kind === 'shape' || kind === 'svg';
  // Footage and precomps have a source to play backwards; nothing else does.
  const retimable = isRetimableLayer(targetId);

  /* A composition ROOT is the document, not a layer: renaming it, arranging it
     and every switch below belong to the comp, which the Compositions list
     above already offers. Offering them here would be a second, divergent set
     of comp verbs. */
  if (isRoot) {
    return [
      { id: 'rename', label: 'Rename', onSelect: () => deps.startRename(targetId) },
      { id: 'sep-root', separator: true },
      { id: 'settings', label: 'Composition Settings…', onSelect: () => run('comp.settings') },
    ];
  }

  return [
    { id: 'rename', label: 'Rename', shortcut: 'F2', onSelect: () => deps.startRename(targetId) },
    { id: 'duplicate', label: 'Duplicate', shortcut: 'Ctrl+D', onSelect: () => duplicateSelectedLayers() },
    // `arrangeNodes` over the WHOLE selection, never a loop over it — the
    // loop moved a multi-selection one layer at a time and the members
    // leapfrogged each other (see `reorderSiblings`). Same call the Layer ▸
    // Arrange commands and the viewport's context menu make.
    { id: 'arrange', label: 'Arrange', children: [
      { id: 'arr-front', label: 'Bring to Front', onSelect: () => { arrangeNodes(ids, 'front'); } },
      { id: 'arr-forward', label: 'Bring Forward', onSelect: () => { arrangeNodes(ids, 'forward'); } },
      { id: 'arr-backward', label: 'Send Backward', onSelect: () => { arrangeNodes(ids, 'backward'); } },
      { id: 'arr-back', label: 'Send to Back', onSelect: () => { arrangeNodes(ids, 'back'); } },
    ] },
    { id: 'sep1', separator: true },

    // Anchored on the clicked row, so the label ("Unlock") and the action
    // agree even when the rest of the selection is in the other state.
    { id: 'toggle', label: hidden ? 'Show' : 'Hide', onSelect: () => { void toggleLayerSwitchAnchored(targetId, 'visible'); } },
    { id: 'lock', label: locked ? 'Unlock' : 'Lock', onSelect: () => { void toggleLayerSwitchAnchored(targetId, 'locked'); } },
    { id: 'solo', label: solo ? 'Unsolo' : 'Solo', onSelect: () => { void toggleLayerSwitchAnchored(targetId, 'solo'); } },
    { id: 'switches', label: 'Switches', children: switchesMenuItems(targetId, ids) },
    { id: 'labelColor', label: 'Label Color', children: labelColorMenuItems(targetId) },
    { id: 'sep2', separator: true },

    // ── Compositing: what this layer does to the ones under it ──────────
    { id: 'blend', label: `Blending Mode — ${blendModeLabel(readNodeBlend(node))}`, children: blendMenuItems(targetId, ids) },
    { id: 'matte', label: 'Track Matte', children: matteMenuItems(targetId) },
    { id: 'parent', label: 'Parent', children: parentMenuItems(targetId) },
    { id: 'sep3', separator: true },

    // ── Transform: the AE Layer ▸ Transform verbs, through their commands ──
    { id: 'transform', label: 'Transform', children: [
      { id: 'fit', label: 'Fit to Comp', shortcut: 'Ctrl+Alt+F', onSelect: () => run('layer.fitToComp') },
      { id: 'fit-w', label: 'Fit to Comp Width', onSelect: () => run('layer.fitToCompWidth') },
      { id: 'fit-h', label: 'Fit to Comp Height', onSelect: () => run('layer.fitToCompHeight') },
      { id: 'fill', label: 'Fill Comp (crop to frame)', onSelect: () => run('layer.fillComp') },
      { id: 'native', label: 'Set to Native Size', onSelect: () => run('layer.nativeSize') },
      { id: 'tr-sep', separator: true },
      { id: 'centre-anchor', label: 'Centre Anchor Point in Layer Content', onSelect: () => run('layer.centreAnchor') },
    ] },
    ...(many ? [{ id: 'align', label: 'Align & Distribute', children: alignMenuItems(ids) } as ContextMenuItem] : []),

    /*
      Time. TWO gates, not one, because `layerTimeCommands` draws the line
      itself: Split and Time Stretch apply to EVERY layer (a shape with no
      source to resample has its bar and its keyframes scaled instead), while
      Reverse and Freeze are footage verbs that need something to play
      backwards. Gating the whole submenu on `isRetimableLayer` — footage and
      precomps only — would have hidden Split from every shape and text layer
      in the project, which is not what the command does.
    */
    {
      id: 'time',
      label: 'Time',
      children: [
        { id: 'split', label: 'Split Layer at Playhead', shortcut: 'Ctrl+Shift+D', onSelect: () => splitAtPlayhead(ids) },
        { id: 'stretch', label: 'Time Stretch…', onSelect: () => run('time.timeStretch') },
        { id: 'time-sep', separator: true },
        {
          id: 'reverse',
          label: 'Time-Reverse Layer',
          disabled: !retimable,
          onSelect: () => toggleReverse(ids),
        },
        {
          id: 'freeze',
          label: 'Freeze Frame at Playhead',
          disabled: !retimable,
          onSelect: () => toggleFreeze(ids, getTime()),
        },
      ],
    },
    { id: 'sep4', separator: true },

    // ── Create: turn this layer into other layers ───────────────────────
    { id: 'group', label: 'Group Selection', onSelect: () => groupSelectedLayers() },
    ...(isGroup ? [{ id: 'ungroup', label: 'Ungroup', onSelect: () => ungroupSelected() }] : []),
    { id: 'precompose', label: 'Pre-compose…', shortcut: 'Ctrl+Shift+C', onSelect: () => openPrecomposeDialog() },
    ...(isText
      ? [
          {
            id: 'shapes-from-text',
            label: 'Create Shapes from Text',
            onSelect: () => { void createShapesFromText(targetId).then((r) => { if (!r) notify('That text could not be traced to shapes', 'warning'); }); },
          },
          {
            id: 'masks-from-text',
            label: 'Create Masks from Text',
            onSelect: () => { void createMasksFromText(targetId); },
          },
        ]
      : []),
    ...(isShape
      ? [{
          id: 'nulls-from-paths',
          label: 'Create Nulls from Path Points',
          onSelect: () => {
            const made = createNullsFromPathUndoable(targetId, getTime());
            if (!made) notify('That layer has no path points to bind nulls to', 'warning');
          },
        }]
      : []),
    { id: 'rig-logo', label: 'Rig Logo for Animation', onSelect: () => { void rigLogoForAnimation(); } },
    ...svgContextMenuItems(targetId),

    ...(many
      ? [
          { id: 'sep_merge', separator: true },
          {
            id: 'merge-paths',
            label: 'Merge Paths',
            children: [
              { id: 'merge-live-union', label: 'Live Union (Add)', onSelect: () => liveMergeSelectedPaths('union') },
              { id: 'merge-live-subtract', label: 'Live Subtract', onSelect: () => liveMergeSelectedPaths('subtract') },
              { id: 'merge-live-intersect', label: 'Live Intersect', onSelect: () => liveMergeSelectedPaths('intersect') },
              { id: 'merge-live-exclude', label: 'Live Exclude (XOR)', onSelect: () => liveMergeSelectedPaths('exclude') },
              { id: 'merge-sep', separator: true },
              { id: 'merge-union', label: 'Bake Union', onSelect: () => mergeSelectedPaths('union') },
              { id: 'merge-subtract', label: 'Bake Subtract', onSelect: () => mergeSelectedPaths('subtract') },
              { id: 'merge-intersect', label: 'Bake Intersect', onSelect: () => mergeSelectedPaths('intersect') },
              { id: 'merge-exclude', label: 'Bake Exclude', onSelect: () => mergeSelectedPaths('exclude') },
            ],
          },
        ]
      : []),

    { id: 'sep5', separator: true },
    { id: 'select-all', label: 'Select All', shortcut: 'Ctrl+A', onSelect: () => run('edit.selectAll') },
    { id: 'invert', label: 'Invert Selection', onSelect: () => invertSelection() },
    { id: 'sep6', separator: true },
    {
      id: 'delete',
      label: many ? `Delete ${ids.length} Layers` : 'Delete',
      danger: true,
      shortcut: 'Del',
      onSelect: () => deleteLayersWithFeedback(ids),
    },
  ];
}

/** Split at the playhead, the same call the transport bar's scissors makes. */
function splitAtPlayhead(ids: ReadonlyArray<string>): void {
  getTimelineController().splitSelectedAtPlayhead(ids);
  bumpScene();
}

/** Every layer of the active comp that is NOT currently selected. */
export function invertSelection(): void {
  const sel = new Set(useSelectionStore.getState().ids);
  const roots = defaultSceneGraph.getRoots();
  const out: string[] = [];
  const walk = (id: string): void => {
    for (const child of defaultSceneGraph.getChildren(id)) {
      if (!sel.has(child.id)) out.push(child.id);
      walk(child.id);
    }
  };
  for (const r of roots) walk(r.id);
  useSelectionStore.getState().set(out);
}

/**
 * Delete, and SAY what was skipped.
 *
 * `deleteSelectedLayers` has always filtered locked layers out; it did it
 * silently, so selecting five layers of which two were locked deleted three and
 * looked like a partial failure with no cause on screen.
 */
export function deleteLayersWithFeedback(ids: ReadonlyArray<string>): void {
  const lockedCount = ids.filter((id) => defaultSceneGraph.getNode(id)?.locked).length;
  deleteSelectedLayers();
  if (lockedCount > 0) {
    notify(
      lockedCount === ids.length
        ? lockedCount === 1 ? 'That layer is locked — unlock it to delete it.' : 'Those layers are locked — unlock them to delete them.'
        : `${lockedCount} locked layer${lockedCount === 1 ? ' was' : 's were'} left in place.`,
      'warning',
    );
  }
}
