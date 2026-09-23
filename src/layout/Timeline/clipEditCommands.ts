/**
 * Ripple Delete, Lift and Extract — reachable from a row at last.
 *
 * `TimelineController.rippleDeleteLayer` and the ripple-gap helpers have
 * existed for a long time and had exactly one caller between them, in a menu
 * that was never built. This module is the seam that connects them to the two
 * places a user actually reaches for them: the clip's own context menu, and
 * `Shift+Delete`.
 *
 * ## Why Shift+Delete is panel-scoped
 *
 * `Delete` is globally bound to "delete the selected layers", and the timeline
 * root already claims `delete`/`backspace` so a keyframe selection can take
 * them. `Shift+Delete` joins that claim rather than becoming a global chord: it
 * is meaningless anywhere the notion of "the gap after this layer" does not
 * exist, and a global binding would have it firing from the Assets panel.
 *
 * ## Why Lift and Extract take the WORK AREA
 *
 * They remove a RANGE, and the work area is the only range the editor has that
 * the user set deliberately. There is no fallback to "playhead → end" — see
 * `rangeEdits.workAreaRange` for why a silent fallback there is a data-loss
 * shape rather than a convenience.
 */

import { asCommandId } from '@app-types/common';
import { BuiltinCommands, getCommandRegistry, type Command } from '@core/commands/Command';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { getTimelineController } from '@core/timeline/TimelineController';
import { useSelectionStore } from '@stores/selectionStore';
import { bumpScene } from '@stores/sceneStore';
import { useUIStore } from '@stores/uiStore';
import type { ContextMenuItem } from '@stores/contextMenuStore';
import { extractRange, liftRange, workAreaRange } from '@core/timeline/rangeEdits';
import { barOf, rippleDeleteLayers } from './timelineEdits';

function notify(message: string, level: 'success' | 'info' | 'warning' | 'error' = 'success'): void {
  useUIStore.getState().notify({ level, message, durationMs: 4000 });
}

export const TIMELINE_RIPPLE_DELETE_COMMAND = asCommandId('timeline.rippleDelete');
export const TIMELINE_LIFT_COMMAND = asCommandId('timeline.lift');
export const TIMELINE_EXTRACT_COMMAND = asCommandId('timeline.extract');

/**
 * Ripple-delete the layers a clip id stands for.
 *
 * Addressed by the ENGINE LAYER id the row handed us, because that is the bar
 * the user right-clicked — a node that has been split has several, and going
 * back through the scene node would delete whichever came first.
 */
export function rippleDeleteClip(clipId: string): void {
  const bar = barOf(clipId);
  if (bar) void rippleDeleteLayers([bar.nodeId]);
}

/**
 * Ripple-delete every bar of every SELECTED layer.
 *
 * Reverse order over a snapshot of the bar list: each delete slides the bars
 * after it left, so walking forwards would compute the second deletion's gap
 * against geometry the first one had already changed.
 */
export function rippleDeleteSelection(): number {
  const controller = getTimelineController();
  const selected = new Set(useSelectionStore.getState().ids);
  if (selected.size === 0) return 0;
  const bars = controller
    .layersOfComp()
    .filter((l) => l.sourceId !== null && selected.has(l.sourceId) && !l.locked)
    .sort((a, b) => b.start - a.start);
  // ONE engine command over the layers: the engine closes the union of the
  // gaps in one pass, so the order problem above cannot arise (and the whole
  // selection is one undo entry).
  if (bars.length > 0) void rippleDeleteLayers([...new Set(bars.map((b) => b.sourceId!))]);
  return bars.length;
}

/**
 * Plain Delete / Backspace with the TIMELINE focused: delete the selected
 * layers, exactly as the key does everywhere else.
 *
 * WHY THE PANEL HAS TO DO THIS ITSELF. The timeline root claims `delete` and
 * `backspace` (`data-shortcut-claim`) so a KEYFRAME selection can take them —
 * and a claim makes `ShortcutManager` skip the chord outright, whatever is
 * selected. Nothing picked the key back up when there were no keyframes to
 * delete, so it fell on the floor. Clicking a layer's name is how a layer gets
 * selected, and it is also what puts focus on the row header inside the claim:
 * the ordinary "select a layer, press Delete" did nothing, while the same key
 * worked from the viewport, where no claim applies.
 *
 * Routed through the registered command rather than `deleteSelectedLayers`
 * directly, so this is the same undoable edit, the same toast and the same
 * `enabled` gate as the global chord, and cannot drift from it.
 *
 * Returns whether the key was taken, so the caller only swallows the event
 * when something was there to delete.
 */
export function deleteSelectionFromTimeline(): boolean {
  if (useSelectionStore.getState().count() === 0) return false;
  void getCommandSystem().execute(BuiltinCommands.DeleteSelected);
  return true;
}

/** Shared by both range commands: run it, or say why it could not. */
async function runRangeEdit(kind: 'lift' | 'extract'): Promise<void> {
  const range = workAreaRange();
  if (!range) {
    notify(
      `${kind === 'lift' ? 'Lift' : 'Extract'} removes the work area, and this composition has none. `
      + 'Set it with B and N, then try again.',
      'warning',
    );
    return;
  }
  // Scoped to the selection when there is one — "lift this out of the title
  // layer" — and to everything the range crosses when there is not, which is
  // what removing a moment from a cut means.
  const nodeIds = useSelectionStore.getState().ids;
  const result = kind === 'lift' ? await liftRange(range, nodeIds) : await extractRange(range, nodeIds);
  bumpScene();
  notify(
    `${kind === 'lift' ? 'Lifted' : 'Extracted'} ${result.removedSeconds.toFixed(2)}s — `
    + `${result.deletedClips} clip piece(s) removed, ${result.splits} split`
    + (kind === 'extract' ? `, ${result.rippled} shifted` : ''),
  );
}

export function buildTimelineClipEditCommands(): ReadonlyArray<Command> {
  return [
    {
      id: TIMELINE_RIPPLE_DELETE_COMMAND,
      label: 'Ripple Delete Layer',
      description: 'Delete the selected layers and close the gap they leave on their own track.',
      icon: 'trash',
      enabled: () => useSelectionStore.getState().ids.length > 0,
      execute: () => {
        rippleDeleteSelection();
      },
    },
    {
      id: TIMELINE_LIFT_COMMAND,
      label: 'Lift Work Area',
      description: 'Remove what is inside the work area and leave the hole — later clips stay put.',
      icon: 'scissors',
      enabled: () => workAreaRange() !== null,
      execute: () => runRangeEdit('lift'),
    },
    {
      id: TIMELINE_EXTRACT_COMMAND,
      label: 'Extract Work Area',
      description: 'Remove what is inside the work area and close the hole — later clips slide left.',
      icon: 'scissors',
      enabled: () => workAreaRange() !== null,
      execute: () => runRangeEdit('extract'),
    },
  ];
}

/**
 * The three entries a clip's context menu gains, ready to spread into it.
 *
 * Built HERE rather than at the menu's call site so the labels, the shortcut
 * hint and the ripple semantics have one home — the host only has to decide
 * where in its menu they go.
 */
export function clipRippleMenuItems(clipId: string, onDone?: () => void): ContextMenuItem[] {
  const finish = (): void => {
    bumpScene();
    onDone?.();
  };
  return [
    {
      id: 'ripple-delete',
      label: 'Ripple Delete Layer (Shift+Delete)',
      danger: true,
      onSelect: () => {
        rippleDeleteClip(clipId);
        finish();
      },
    },
    {
      id: 'lift-work-area',
      label: 'Lift Work Area',
      disabled: workAreaRange() === null,
      onSelect: () => {
        void runRangeEdit('lift').then(finish);
      },
    },
    {
      id: 'extract-work-area',
      label: 'Extract Work Area',
      disabled: workAreaRange() === null,
      onSelect: () => {
        void runRangeEdit('extract').then(finish);
      },
    },
  ];
}

let installed = false;

export function installTimelineClipEditCommands(): void {
  if (installed) return;
  installed = true;
  const registry = getCommandRegistry();
  for (const command of buildTimelineClipEditCommands()) registry.register(command);
}

export function resetTimelineClipEditCommandsForTest(): void {
  installed = false;
}
