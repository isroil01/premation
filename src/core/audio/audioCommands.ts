/**
 * Audio editing commands: remove silence, duck music.
 *
 * Both are dialog-first — they have four parameters each and a readout that
 * only means something once the audio has been analysed, so "run it and see"
 * is not an option and a one-click menu entry would be a coin toss. The command
 * therefore opens the dialog rather than doing the edit; the edit lives in
 * `silenceRemoval.ts` / `ducking.ts` and is reachable without any UI at all.
 *
 * ## Why the opener is injected
 *
 * A command in `core/` opening a React dialog in `layout/` would be the first
 * production import from core into layout in this tree, and the direction that
 * points is the one where the engine cannot be built or tested without the
 * panels. So the dialogs REGISTER themselves here ({@link setAudioToolOpener})
 * when their module loads, and the commands ask for whatever is registered. A
 * command whose dialog has not loaded says so instead of throwing.
 */

import { asCommandId } from '@app-types/common';
import { getCommandRegistry, type Command } from '@core/commands/Command';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { audioVoices } from './silenceRemoval';

export const REMOVE_SILENCE_COMMAND = asCommandId('audio.removeSilence');
export const DUCK_MUSIC_COMMAND = asCommandId('audio.duckMusic');

/** Which dialog an opener stands for. */
export type AudioTool = 'silence' | 'ducking';

const openers = new Map<AudioTool, (nodeId: string) => void>();

/** Called by each dialog module as it loads. Replacing is fine (HMR). */
export function setAudioToolOpener(tool: AudioTool, open: (nodeId: string) => void): void {
  openers.set(tool, open);
}

function notify(message: string, level: 'info' | 'warning' = 'warning'): void {
  useUIStore.getState().notify({ level, message, durationMs: 5000 });
}

/**
 * The selected layer that has sound, or undefined.
 *
 * Membership of the VOICE list is the test, not `readNodeKind(n) === 'audio'`:
 * a video layer carries its own track in this app (see `audioScene`), and both
 * of these commands are as meaningful on a piece to camera as on a wav.
 */
export function selectedAudioNodeId(): string | undefined {
  const ids = useSelectionStore.getState().ids;
  if (ids.length === 0) return undefined;
  const voices = audioVoices();
  return ids.find(
    (id) => defaultSceneGraph.getNode(id) !== undefined && voices.some((v) => v.nodeId === id),
  );
}

function run(tool: AudioTool, what: string): void {
  const nodeId = selectedAudioNodeId();
  if (!nodeId) {
    notify(`Select a layer with sound first — ${what} needs something to listen to.`);
    return;
  }
  const open = openers.get(tool);
  if (!open) {
    notify('The audio panel has not loaded yet. Open the Inspector and try again.', 'info');
    return;
  }
  open(nodeId);
}

/** Both commands, for `buildStaticCommands` or a direct registration. */
export function buildAudioCommands(): ReadonlyArray<Command> {
  return [
    {
      id: REMOVE_SILENCE_COMMAND,
      label: 'Remove Silence…',
      description:
        'Find the dead air in this layer and cut it out, closing the gaps — '
        + 'picture and sound from the same file stay in sync.',
      icon: 'audio',
      enabled: () => selectedAudioNodeId() !== undefined,
      execute: () => run('silence', 'silence removal'),
    },
    {
      id: DUCK_MUSIC_COMMAND,
      label: 'Duck Under Voice…',
      description:
        'Hold this layer’s level down whenever another layer is talking, as level keyframes.',
      icon: 'audio',
      enabled: () => selectedAudioNodeId() !== undefined,
      execute: () => run('ducking', 'ducking'),
    },
  ];
}

/** Put both commands in the registry. Idempotent — registering replaces. */
export function registerAudioCommands(): void {
  const registry = getCommandRegistry();
  for (const command of buildAudioCommands()) registry.register(command);
}

// Registered on import. The inspector's audio section imports this module, so
// the commands exist as soon as anything that could invoke them does.
registerAudioCommands();
