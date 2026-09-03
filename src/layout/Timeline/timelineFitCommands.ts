/**
 * The two timeline fit actions, as first-class COMMANDS.
 *
 * Registered here rather than in the app's boot block so the feature is one
 * self-contained unit: the math, the buttons and the shortcuts all ship
 * together, and nothing else has to be edited to add or remove them.
 *
 * Registration is idempotent (the registry replaces by id) and the shortcut
 * manager is asked to re-scan afterwards — bindings are a snapshot of the
 * registry taken at boot, so a command registered later is inert until it is.
 */

import { asCommandId } from '@app-types/common';
import { getCommandRegistry, type Command } from '@core/commands/Command';
import { getShortcutManager } from '@core/commands/ShortcutManager';
import { getTimelineViewport } from './timelineViewport';
import { fitTimelineToComposition, fitTimelineToWorkArea, hasWorkArea } from './timelineFit';

export const TIMELINE_FIT_COMP_COMMAND = asCommandId('timeline.zoomToFit');
export const TIMELINE_FIT_WORK_AREA_COMMAND = asCommandId('timeline.zoomToWorkArea');

/** A timeline has to be mounted and measured before either action means anything. */
const timelineMeasured = (): boolean => getTimelineViewport().width > 0;

export function buildTimelineFitCommands(): ReadonlyArray<Command> {
  return [
    {
      id: TIMELINE_FIT_COMP_COMMAND,
      label: 'Fit Composition to Timeline',
      description: 'Zoom the timeline so the whole composition fills the visible lanes.',
      icon: 'fit',
      // AE binds `;` to exactly this.
      shortcut: { key: ';' },
      enabled: timelineMeasured,
      execute: () => {
        fitTimelineToComposition();
      },
    },
    {
      id: TIMELINE_FIT_WORK_AREA_COMMAND,
      label: 'Fit Work Area to Timeline',
      description: 'Zoom the timeline so the work area fills the visible lanes.',
      icon: 'frame',
      shortcut: { key: ';', alt: true },
      enabled: () => timelineMeasured() && hasWorkArea(),
      execute: () => {
        fitTimelineToWorkArea();
      },
    },
  ];
}

let installed = false;

/**
 * Register both commands and bind their shortcuts. Safe to call repeatedly;
 * the first call does the work and the rest are no-ops.
 */
export function installTimelineFitCommands(): void {
  if (installed) return;
  installed = true;
  const registry = getCommandRegistry();
  for (const command of buildTimelineFitCommands()) registry.register(command);
  getShortcutManager().rehydrateFromRegistry();
}

/** Test seam — forget that the commands were installed. */
export function resetTimelineFitCommandsForTest(): void {
  installed = false;
}
