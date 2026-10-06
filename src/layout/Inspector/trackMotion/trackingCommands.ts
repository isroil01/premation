/**
 * The Animation menu's tracking entries (AE parity 3.8; AE's Animation ▸
 * Track Motion / Stabilize Motion / Warp Stabilizer / Track Camera / Track
 * Face / Content-Aware Fill). Each sets the Tracker's mode for the selected
 * footage layer and opens the panel that runs it — the work stays in the
 * Tracker and Content-Aware Fill panels.
 */

import { asCommandId } from '@app-types/common';
import type { Command } from '@core/commands/Command';
import { uiKindOf } from '@core/mirror/layerKinds';
import { mirrorSourceDisplaySize } from '@core/mirror/sourceSize';
import { documentMirror } from '@stores/documentMirror';
import { useLayoutStore } from '@stores/layoutStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useTrackerStore, type TrackerMode } from '@stores/trackerStore';

/** The selected layer when it is footage. */
function selectedFootage(): string | null {
  const id = useSelectionStore.getState().ids[0];
  if (!id) return null;
  const kind = uiKindOf(documentMirror().layer(id));
  return kind === 'video' || kind === 'image' ? id : null;
}

/** Arm the Tracker in `mode` for the selected footage and show it. */
export function openTracker(mode: TrackerMode): void {
  const id = selectedFootage();
  if (id) {
    const src = mirrorSourceDisplaySize(documentMirror(), id);
    useTrackerStore.getState().setMode(mode, src?.width ?? 0, src?.height ?? 0);
  }
  useLayoutStore.getState().openPanel('tracker');
}

const ENTRIES: ReadonlyArray<{ id: string; label: string; mode: TrackerMode | 'contentAwareFill' }> = [
  { id: 'animation.trackMotion', label: 'Track Motion', mode: 'follow' },
  { id: 'animation.stabilizeMotion', label: 'Stabilize Motion', mode: 'stabilize' },
  { id: 'animation.warpStabilizer', label: 'Warp Stabilizer', mode: 'smooth' },
  { id: 'animation.trackPlanar', label: 'Track Planar Surface', mode: 'planar' },
  { id: 'animation.trackCamera', label: 'Track Camera', mode: 'camera' },
  { id: 'animation.trackFace', label: 'Track Face', mode: 'face' },
  { id: 'animation.contentAwareFill', label: 'Content-Aware Fill', mode: 'contentAwareFill' },
];

export function buildTrackingCommands(): Command[] {
  return ENTRIES.map((e) => ({
    id: asCommandId(e.id),
    label: e.label,
    icon: e.mode === 'contentAwareFill' ? 'magic-wand' : 'crosshair',
    // Each needs footage to work on; the panels say so when there is none.
    enabled: () => selectedFootage() !== null,
    execute: () => {
      if (e.mode === 'contentAwareFill') useLayoutStore.getState().openPanel('contentAwareFill');
      else openTracker(e.mode);
    },
  }));
}

