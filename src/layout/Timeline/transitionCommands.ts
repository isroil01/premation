/**
 * Transitions as first-class COMMANDS — so they reach the palette, the menus
 * and anything else that reads the registry.
 *
 * Registered from the timeline panel rather than the app's boot block, for the
 * reason `timelineFitCommands` and `timelineEditMode` give: the feature is one
 * self-contained unit, and nothing outside it has to be edited to add or remove
 * a kind. Registration is idempotent (the registry replaces by id).
 *
 * ## No shortcuts, deliberately
 *
 * Every plausible chord for "apply a dissolve" is already taken here —
 * Ctrl+Shift+D is Split Layer, D is Duplicate, and the Shift+letter row belongs
 * to the five edit tools. Binding one anyway would break a working shortcut for
 * a feature that has three other doors (the palette chips, a double-click on a
 * cut, the clip context menu). The commands are still searchable by name, which
 * is what the palette is for.
 *
 * ## Which cut a command means
 *
 * The chips and the context menu both name a cut explicitly. A command cannot,
 * so it takes the cut NEAREST THE PLAYHEAD — the same convention every
 * playhead-relative command in this timeline already uses (`Trim In to
 * Playhead`, `Split Layer at Playhead`), and the one place a user has already
 * said "here".
 */

import { asCommandId } from '@app-types/common';
import { getCommandRegistry, type Command } from '@core/commands/Command';
import { getTimelineController } from '@core/timeline/TimelineController';
import {
  addTransition,
  removeTransition,
  transitionAtCut,
  compIdForTransition,
  DEFAULT_TRANSITION_FRAMES,
  TRANSITION_KINDS,
  TRANSITION_LABEL,
} from '@core/timeline/transitions';
import type { TransitionKind } from '@core/timeline/transitions';

export const TRANSITION_COMMAND_PREFIX = 'timeline.transition.';

export interface PlayheadCut {
  leftNodeId: string;
  rightNodeId: string;
  /** Frames from the playhead to the cut — the ranking, exposed for tests. */
  distance: number;
}

/**
 * The cut nearest the playhead in the active composition, or null.
 *
 * Read off the ENGINE's bars rather than the timeline view model: a command may
 * fire from the palette with no timeline mounted, and the view model is a prop
 * of a component that may not exist. Pairs from the same scene node are skipped
 * for the reason `collectClipCuts` documents — there is no cut between a thing
 * and itself.
 */
export function cutNearestPlayhead(): PlayheadCut | null {
  const controller = getTimelineController();
  const bars = controller.layersOfComp();
  const playhead = controller.timeline.currentFrame;
  let best: PlayheadCut | null = null;
  for (const left of bars) {
    for (const right of bars) {
      if (left.id === right.id) continue;
      if (!left.sourceId || !right.sourceId || left.sourceId === right.sourceId) continue;
      if (Math.abs(left.end - right.start) > 1) continue;
      const distance = Math.abs(left.end - playhead);
      if (best === null || distance < best.distance) {
        best = { leftNodeId: left.sourceId, rightNodeId: right.sourceId, distance };
      }
    }
  }
  return best;
}

export function buildTransitionCommands(): ReadonlyArray<Command> {
  const add: Command[] = TRANSITION_KINDS.map((kind: TransitionKind) => ({
    id: asCommandId(`${TRANSITION_COMMAND_PREFIX}add.${kind}`),
    label: `Add ${TRANSITION_LABEL[kind]} at Nearest Cut`,
    description:
      `Apply a ${DEFAULT_TRANSITION_FRAMES}-frame ${TRANSITION_LABEL[kind]} to the cut nearest the playhead. ` +
      `Drag the chip from the timeline's transition palette to choose a different cut.`,
    icon: 'scissors',
    enabled: () => cutNearestPlayhead() !== null,
    execute: () => {
      const cut = cutNearestPlayhead();
      if (!cut) return;
      void addTransition(cut.leftNodeId, cut.rightNodeId, kind, DEFAULT_TRANSITION_FRAMES, 'centred');
    },
  }));

  return [
    ...add,
    {
      id: asCommandId(`${TRANSITION_COMMAND_PREFIX}remove`),
      label: 'Remove Transition at Nearest Cut',
      description: 'Take the transition off the cut nearest the playhead and restore what it held before.',
      icon: 'trash',
      enabled: () => {
        const cut = cutNearestPlayhead();
        if (!cut) return false;
        return !!transitionAtCut(compIdForTransition(cut), cut.leftNodeId, cut.rightNodeId);
      },
      execute: () => {
        const cut = cutNearestPlayhead();
        if (!cut) return;
        const compId = compIdForTransition(cut);
        const existing = transitionAtCut(compId, cut.leftNodeId, cut.rightNodeId);
        if (existing) void removeTransition(compId, existing.id);
      },
    },
  ];
}

let installed = false;

/** Register the transition commands. Safe to call repeatedly. */
export function installTransitionCommands(): void {
  if (installed) return;
  installed = true;
  const registry = getCommandRegistry();
  for (const command of buildTransitionCommands()) registry.register(command);
}

/** Test seam — forget that the commands were installed. */
export function resetTransitionCommandsForTest(): void {
  installed = false;
}
