/**
 * The timeline's EDIT MODE — which NLE edit a plain drag on a clip performs.
 *
 * ## Why this exists
 *
 * Slip and slide already worked, as Alt-drag and Alt+Shift-drag on a clip body.
 * Both were invisible: nothing in the panel said they existed, no tooltip
 * mentioned them, and the only way to find one was to hold a modifier over a
 * bar and notice the cursor change. Roll — the two-sided trim at a cut, the one
 * edit you cannot fake with the tools that were there — did not exist at all,
 * and razor (click to split at a frame) meant travelling to the playhead first
 * because Ctrl+Shift+D is the only splitter.
 *
 * A mode is what every NLE uses for this, and the reason is not fashion: these
 * gestures all start with a press on a clip body and differ only in what they
 * mean, so they cannot be distinguished by where you press. Either a modifier
 * says which one, or the tool does. Modifiers do not survive being forgotten;
 * a lit button in a tool row does.
 *
 * ## Why its own store rather than `uiStore`'s `Tool`
 *
 * `Tool` is the CANVAS toolbar — selection, pen, shapes, puppet pins. Those act
 * on the viewport; these act on time. Folding razor and slip into that union
 * would put five entries in the canvas toolbar that do nothing to the canvas,
 * make every `activeTool === 'select'` check in the viewport wrong the moment
 * someone picked a timeline mode, and mean choosing a shape tool silently
 * cancelled the razor. They are two independent pieces of state because a user
 * genuinely holds both at once: pen on the canvas, razor in the timeline.
 *
 * ## Escape
 *
 * Every mode returns to `select` on Escape, registered as a command that is
 * only ENABLED while a non-select mode is active — so in the common case the
 * chord falls straight through to Deselect, exactly as the camera tool's exit
 * does. The alternative (a bare listener) would eat Escape from every other
 * surface that wants it.
 */

import { create } from 'zustand';
import { asCommandId } from '@app-types/common';
import { getCommandRegistry, type Command } from '@core/commands/Command';
import { getShortcutManager } from '@core/commands/ShortcutManager';
import type { IconName } from '@components/Icon';

export type TimelineEditMode = 'select' | 'razor' | 'slip' | 'slide' | 'roll';

interface TimelineEditModeStore {
  mode: TimelineEditMode;
  setMode: (mode: TimelineEditMode) => void;
  /** Back to `select`. Escape, and the end of a one-shot razor cut. */
  reset: () => void;
}

export const useTimelineEditModeStore = create<TimelineEditModeStore>((set) => ({
  mode: 'select',
  setMode: (mode) => set({ mode }),
  reset: () => set({ mode: 'select' }),
}));

/** Read the mode outside React (drag handlers, command `enabled` predicates). */
export function getTimelineEditMode(): TimelineEditMode {
  return useTimelineEditModeStore.getState().mode;
}

export function setTimelineEditMode(mode: TimelineEditMode): void {
  useTimelineEditModeStore.getState().setMode(mode);
}

/**
 * The tool row's contents, in order — one source for the buttons, the command
 * palette entries and the shortcut bindings, so a mode cannot exist in one and
 * not the others.
 *
 * ## The chords, and why they are not Premiere's bare letters
 *
 * Premiere puts these on V / C / Y / U / N. Every one of those bare keys is
 * already claimed here, and taking one would break a working shortcut for a
 * tool the user can see:
 *
 *   V → Select Tool          C → Camera Tool (orbit/pan/dolly cycle)
 *   Y → Pan Behind Tool      U → Reveal Animated Properties (and UU → Modified)
 *   N → Set Work Area Out    (`useTimelineKeys`, beside B for the in-point)
 *
 * So the family moves up one modifier and keeps the letters, which is the part
 * muscle memory actually holds. Roll takes R rather than Premiere's N: N is
 * arbitrary even in Premiere, R is free at every modifier level here, and it is
 * the letter of the thing. All five chords were checked against the command
 * registry, `useTimelineKeys`, and `data-shortcut-claim` before being taken.
 */
export interface TimelineEditModeDef {
  mode: TimelineEditMode;
  label: string;
  /** What the mode does, for the tooltip and the palette. */
  description: string;
  icon: IconName;
  /** Display form of the chord, for tooltips. */
  chord: string;
  key: string;
}

export const TIMELINE_EDIT_MODES: ReadonlyArray<TimelineEditModeDef> = [
  {
    mode: 'select',
    label: 'Selection',
    description: 'Drag clip bars to move them; drag an edge to trim. Alt-drag still slips, Alt+Shift-drag still slides.',
    icon: 'select-arrow',
    chord: 'Shift+S',
    key: 's',
  },
  {
    mode: 'razor',
    label: 'Razor',
    description: 'Click a clip to split it at the pointer. Shift+click splits every clip on every track at that frame.',
    icon: 'scissors',
    chord: 'Shift+C',
    key: 'c',
  },
  {
    mode: 'slip',
    label: 'Slip',
    description: 'Drag a clip to move the source under a fixed bar — its position and length never change.',
    icon: 'grip-horizontal',
    chord: 'Shift+Y',
    key: 'y',
  },
  {
    mode: 'slide',
    label: 'Slide',
    description: 'Drag a clip to move the bar between its neighbours, trimming them so no gap opens.',
    icon: 'distribute-horizontal',
    chord: 'Shift+U',
    key: 'u',
  },
  {
    mode: 'roll',
    label: 'Roll',
    description: 'Drag a cut between two adjacent clips to move it — the out-point and the in-point travel together.',
    icon: 'grip-vertical',
    chord: 'Shift+R',
    key: 'r',
  },
];

export const TIMELINE_EDIT_MODE_COMMAND_PREFIX = 'timeline.editMode.';

export function buildTimelineEditModeCommands(): ReadonlyArray<Command> {
  const modes: Command[] = TIMELINE_EDIT_MODES.map((def) => ({
    id: asCommandId(`${TIMELINE_EDIT_MODE_COMMAND_PREFIX}${def.mode}`),
    label: `Timeline: ${def.label} Tool`,
    description: def.description,
    icon: def.icon,
    shortcut: { key: def.key, shift: true },
    enabled: () => true,
    // `isChecked` lights the row in the command palette and any menu that
    // renders these, so the palette agrees with the tool row about what is on.
    isChecked: () => getTimelineEditMode() === def.mode,
    execute: () => setTimelineEditMode(def.mode),
  }));

  return [
    ...modes,
    {
      // Registered AFTER every other Escape binding: the ShortcutManager scans
      // most-recently-added first, so while an edit mode is active Esc leaves
      // it, and otherwise this is disabled and Escape falls through to Deselect
      // (and to the camera tool's exit) exactly as before. Same shape as
      // `tool.cameraExit`, deliberately.
      id: asCommandId('timeline.editMode.exit'),
      label: 'Timeline: Exit Edit Tool',
      description: 'Return the timeline to the Selection tool.',
      icon: 'select-arrow',
      shortcut: { key: 'Escape' },
      enabled: () => getTimelineEditMode() !== 'select',
      execute: () => useTimelineEditModeStore.getState().reset(),
    },
  ];
}

let installed = false;

/**
 * Register the mode commands and bind their shortcuts. Idempotent — the
 * registry replaces by id, and the shortcut manager only sees a command that
 * was registered before its last rescan, which is why the rehydrate is here
 * and not left to the app's boot block.
 */
export function installTimelineEditModeCommands(): void {
  if (installed) return;
  installed = true;
  const registry = getCommandRegistry();
  for (const command of buildTimelineEditModeCommands()) registry.register(command);
  getShortcutManager().rehydrateFromRegistry();
}

/** Test seam — forget that the commands were installed. */
export function resetTimelineEditModeCommandsForTest(): void {
  installed = false;
  useTimelineEditModeStore.getState().reset();
}
