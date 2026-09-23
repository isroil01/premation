/**
 * Marker commands — add, edit, delete, and the model-refresh they all need.
 *
 * ## Why the chord is panel-scoped
 *
 * `M` with the timeline focused adds a marker at the playhead. It is NOT
 * registered as a global chord: `M` is a single letter with no modifier, and
 * taking it globally would mean the viewport, the assets grid and every future
 * panel lose it forever. The timeline root claims `m` through
 * `data-shortcut-claim` and handles the press itself — exactly the route
 * `snapCommands` documents for `S`. The commands here therefore carry no chord
 * and exist so the palette, the menus and the context menus can reach the same
 * behaviour by name.
 *
 * ## Comp marker or layer marker
 *
 * `M` adds a COMP marker: it is the one that answers "where was that beat" for
 * the whole composition, and it is what the number keys navigate to. A LAYER
 * marker annotates one layer and travels with it when the layer is trimmed, so
 * it needs a layer to be selected — `Alt+M`, and the command below reports
 * `enabled: false` with nothing selected rather than silently adding a comp
 * marker the user did not ask for.
 */

import { asCommandId } from '@app-types/common';
import { getCommandRegistry, type Command } from '@core/commands/Command';
import { getTimelineController } from '@core/timeline/TimelineController';
import { useSelectionStore } from '@stores/selectionStore';
import { bumpScene } from '@stores/sceneStore';
import { DEFAULT_MARKER_COLOR } from './markerGeometry';
import { deleteMarkers, editMarker, markerPatchNeedsLegacy, type MarkerEditPatch } from './timelineEdits';

export const TIMELINE_ADD_MARKER_COMMAND = asCommandId('timeline.addMarker');
export const TIMELINE_ADD_LAYER_MARKER_COMMAND = asCommandId('timeline.addLayerMarker');

/**
 * The one refresh every marker edit needs.
 *
 * Markers reach the view through `timelineModel`, which is rebuilt from the
 * scene bump — the engine's own `MarkerAdded` event moves no scene node, so
 * without this the marker exists, serializes, exports as a chapter, and is
 * invisible until the next unrelated edit repaints the panel.
 */
export function markersChanged(): void {
  bumpScene();
}

/**
 * Add a comp marker at the playhead.
 *
 * B3-legacy: engine gap — a marker's colour is a timeline swatch TOKEN
 * (`MARKER_COLORS`), and `addMarkers` only carries a LAYER-label index, which
 * has none of them; a marker added through the API would lose its colour.
 */
export function addCompMarkerAtPlayhead(label = 'Marker'): void {
  getTimelineController().addMarkerAtPlayhead(label, DEFAULT_MARKER_COLOR);
  markersChanged();
}

/**
 * Add a layer marker at the playhead on every selected layer.
 *
 * Every selected layer, not just the first: "mark this moment on these two
 * shots" is one act, and adding it to whichever layer happened to be first in
 * the selection order is the kind of half-obeyed command that gets typed twice.
 *
 * B3-legacy: engine gap — the marker colour (see `addCompMarkerAtPlayhead`).
 */
export function addLayerMarkersAtPlayhead(label = 'Marker'): number {
  const controller = getTimelineController();
  let added = 0;
  for (const nodeId of useSelectionStore.getState().ids) {
    if (controller.addLayerMarkerAtPlayhead(nodeId, label)) added += 1;
  }
  if (added > 0) markersChanged();
  return added;
}

export function deleteMarker(id: string): void {
  void deleteMarkers([id]);
}

/**
 * Edit a marker — name, comment, span or position through the engine (one
 * undo entry: "Move Marker" for a pure move, "Edit Marker" otherwise). Returns
 * false when there is no such marker (deleted under a dialog still open).
 */
export function updateMarker(
  id: string,
  patch: MarkerEditPatch,
): boolean {
  if (!getTimelineController().timeline.getMarker(id)) return false;
  if (markerPatchNeedsLegacy(id, patch)) {
    // B3-legacy: engine gap — marker colour tokens (see `markerPatchNeedsLegacy`).
    const ok = getTimelineController().updateMarker(id, patch);
    if (ok) markersChanged();
    return ok;
  }
  void editMarker(id, patch);
  return true;
}

export function buildTimelineMarkerCommands(): ReadonlyArray<Command> {
  return [
    {
      id: TIMELINE_ADD_MARKER_COMMAND,
      label: 'Add Marker at Playhead',
      description:
        'Drop a composition marker on the current frame. With the timeline focused the chord is M, '
        + 'or Numpad * anywhere — including mid-playback, which is how you tap markers to a beat; '
        + 'drag the chip to move it, double-click to name and colour it.',
      icon: 'marker',
      /**
       * AE's Numpad `*`, and the reason it is bound GLOBALLY rather than to the
       * focused timeline: the gesture it exists for is tapping in time with the
       * music while a preview plays, and during playback focus is wherever the
       * user last clicked. A chord that only works with the timeline focused
       * would drop markers for some users and silently do nothing for others.
       *
       * `M` keeps its timeline-scoped binding; this is an addition, not a move.
       */
      shortcut: { key: 'Numpad*' },
      execute: () => addCompMarkerAtPlayhead(),
    },
    {
      id: TIMELINE_ADD_LAYER_MARKER_COMMAND,
      label: 'Add Layer Marker at Playhead',
      description:
        'Drop a marker on each selected layer. Layer markers are stored relative to the layer, '
        + 'so they travel with it when it is trimmed or slid.',
      icon: 'marker',
      // Reports disabled rather than falling back to a comp marker: a chord
      // that quietly does a DIFFERENT thing when nothing is selected is worse
      // than one that does nothing.
      enabled: () => useSelectionStore.getState().ids.length > 0,
      execute: () => {
        addLayerMarkersAtPlayhead();
      },
    },
  ];
}

let installed = false;

export function installTimelineMarkerCommands(): void {
  if (installed) return;
  installed = true;
  const registry = getCommandRegistry();
  for (const command of buildTimelineMarkerCommands()) registry.register(command);
}

export function resetTimelineMarkerCommandsForTest(): void {
  installed = false;
}
