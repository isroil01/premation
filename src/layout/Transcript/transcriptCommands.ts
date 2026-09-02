/**
 * The transcript's commands — the palette, the menu and the shortcut view of
 * what the panel's buttons do.
 *
 * Registered from THIS module rather than from `Providers.tsx` because the
 * panel owns them and nothing else needs to know they exist. `register` is
 * idempotent by id (see `CommandRegistryImpl`), so the module-load call below
 * is safe against a double import and against the boot order — the registry is
 * only ever cleared on `Application.shutdown`.
 *
 * ## Why every one of these has `enabled`
 *
 * Each command acts on the ACTIVE composition's cached transcript, and there
 * usually is not one. A palette entry that runs and silently does nothing is
 * worse than a greyed one: the greyed one says "not here", which is true, while
 * the live one says "this feature is broken".
 *
 * ## Menu rows this offers
 *
 * There is no menu edit in this change — `menuModel.ts` is owned elsewhere.
 * The rows these are meant to become are listed in the module footer so
 * whoever owns the menu can add them verbatim.
 */

import { asCommandId } from '@app-types/common';
import { getCommandRegistry, type Command } from '@core/commands/Command';
import { useLayoutStore } from '@stores/layoutStore';
import { activeCompRootId } from '@core/scene/activeComp';
import {
  findFillerWordIds,
  parseFillerList,
  type TranscriptWord,
} from '@core/captions/transcriptEdit';
import {
  addTranscriptAsCaptions,
  deleteSelectedWords,
  exportTranscript,
  runTranscription,
  transcriptionAvailable,
} from './transcriptOps';
import { useTranscriptStore } from './transcriptStore';

/** The panel id. Kept beside the commands that open it. */
export const TRANSCRIPT_PANEL_ID = 'transcript';

/** Words currently cached for the composition on screen. */
function currentWords(): readonly TranscriptWord[] {
  return useTranscriptStore.getState().byComp[activeCompRootId()]?.words ?? [];
}

export function buildTranscriptCommands(): ReadonlyArray<Command> {
  return [
    {
      id: asCommandId('view.transcript'),
      label: 'Transcript',
      description: 'Edit the composition by editing its words.',
      icon: 'mic',
      enabled: () => true,
      execute: () => useLayoutStore.getState().openPanel(TRANSCRIPT_PANEL_ID),
    },
    {
      id: asCommandId('transcript.transcribe'),
      label: 'Transcribe for Transcript',
      description:
        'Transcribe the selected layers, the work area, or the whole composition, '
        + 'and show the result as editable words.',
      icon: 'mic',
      // Disabled rather than hidden where the shell cannot transcribe — the
      // same call `captions.generate` makes, for the same reason.
      enabled: () => transcriptionAvailable(),
      execute: () => {
        useLayoutStore.getState().openPanel(TRANSCRIPT_PANEL_ID);
        void runTranscription();
      },
    },
    {
      id: asCommandId('transcript.deleteSelection'),
      label: 'Delete Transcript Selection',
      description:
        'Cut the selected words’ time out of every overlapping clip and close the gap. '
        + 'One undo entry.',
      icon: 'trash',
      enabled: () => useTranscriptStore.getState().selected.length > 0,
      execute: () => { void deleteSelectedWords(); },
    },
    {
      id: asCommandId('transcript.selectFillers'),
      label: 'Select Filler Words',
      description: 'Select every um, uh and like in the transcript, ready to delete.',
      icon: 'magic-wand',
      enabled: () => currentWords().length > 0,
      execute: () => {
        const state = useTranscriptStore.getState();
        const ids = findFillerWordIds(currentWords(), parseFillerList(state.fillerText));
        useLayoutStore.getState().openPanel(TRANSCRIPT_PANEL_ID);
        state.select(ids, 'replace');
      },
    },
    {
      id: asCommandId('transcript.addCaptions'),
      label: 'Add Transcript as Captions',
      description: 'One text layer per segment, timed to the edited transcript.',
      icon: 'type',
      enabled: () => currentWords().length > 0,
      execute: () => { addTranscriptAsCaptions(); },
    },
    {
      id: asCommandId('transcript.exportSrt'),
      label: 'Export Transcript (.srt)…',
      icon: 'download',
      enabled: () => currentWords().length > 0,
      execute: () => { exportTranscript('srt'); },
    },
    {
      id: asCommandId('transcript.exportVtt'),
      label: 'Export Transcript (.vtt)…',
      icon: 'download',
      enabled: () => currentWords().length > 0,
      execute: () => { exportTranscript('vtt'); },
    },
  ];
}

/** Idempotent. Called on module load and available to tests. */
export function registerTranscriptCommands(): void {
  const registry = getCommandRegistry();
  for (const command of buildTranscriptCommands()) registry.register(command);
}

registerTranscriptCommands();

/**
 * MENU ROWS (for whoever owns `layout/Menu/menuModel.ts`):
 *
 *   Window  → { command: 'view.transcript' }                  — "Transcript"
 *   Window/Captions submenu, after `captions.generate`:
 *           → { command: 'transcript.transcribe' }            — "Transcribe for Transcript"
 *           → { command: 'transcript.addCaptions' }           — "Add Transcript as Captions"
 *           → { command: 'transcript.exportSrt' }             — "Export Transcript (.srt)…"
 *           → { command: 'transcript.exportVtt' }             — "Export Transcript (.vtt)…"
 *   Edit    → { command: 'transcript.deleteSelection' }       — near Ripple Delete
 *           → { command: 'transcript.selectFillers' }
 *
 * No shortcut is claimed by any of them. Delete is handled by the panel itself
 * while it has focus, which is the only scope where "Delete" can mean words
 * without also meaning layers.
 */
