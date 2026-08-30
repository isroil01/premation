/**
 * The four things a person does with captions, as commands.
 *
 * Commands rather than a panel, deliberately. Captions are an occasional
 * operation on a whole composition — import a file, generate from the audio,
 * export what is there, clear it — not a mode you sit in. A panel would cost
 * permanent screen space for something used twice per project, and commands are
 * already reachable three ways (the menu, the palette, a shortcut) without
 * inventing a fourth surface.
 *
 * Everything below is glue. The formats are `captionFormat.ts`, the scene work
 * is `captionLayers.ts` and the provider call is `transcribe.ts`; this file
 * only picks files, reports outcomes and decides what is enabled.
 */

import { asCommandId } from '@app-types/common';
import type { Command } from '@core/commands/Command';
import { useUIStore } from '@stores/uiStore';
import { getTimelineController } from '@core/timeline/TimelineController';
import { useCompositionStore } from '@stores/compositionStore';
import { activeCompRootId } from '@core/scene/activeComp';
import { downloadBlob } from '@core/export/exportManager';
import { CaptionFormatError, parseCaptions, toSrt, toVtt } from './captionFormat';
import { captionNodes, insertCaptionLayers, removeCaptionLayers } from './captionLayers';
import { readCaptionCues } from './captionLayers';
import { TranscribeError, transcribeComposition, transcriptionAvailable } from './transcribe';

function notify(
  message: string,
  level: 'success' | 'info' | 'warning' | 'error' = 'success',
  durationMs = 4000,
): void {
  useUIStore.getState().notify({ level, message, durationMs });
}

/** Pick one caption file. Resolves null when the picker is dismissed. */
function pickCaptionFile(): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.srt,.vtt,text/vtt,application/x-subrip,text/plain';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      resolve({ name: file.name, text: await file.text() });
    });
    // Chromium fires this when the dialog is dismissed; without it the promise
    // would never settle and the command would look like it hung.
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/** The export range: the work area if one is set, else the whole composition. */
function captionRange(): { startSec: number; endSec: number } {
  const controller = getTimelineController();
  const work = controller.getWorkArea();
  if (work && work.end > work.start) return { startSec: work.start, endSec: work.end };
  const comp = useCompositionStore.getState().comp();
  return { startSec: 0, endSec: comp.durationSeconds };
}

/** A filename stem from the composition, for a downloaded caption file. */
function captionFileStem(): string {
  return useCompositionStore.getState().comp().name?.trim() || 'captions';
}

async function importCaptions(): Promise<void> {
  const picked = await pickCaptionFile();
  if (!picked) return;

  let cues;
  try {
    cues = parseCaptions(picked.text);
  } catch (err) {
    notify(err instanceof CaptionFormatError ? err.message : String(err), 'error', 6000);
    return;
  }

  // Replacing, not adding. A second import over an unremoved first is forty
  // layers of doubled text, which reads as a rendering bug rather than as the
  // user's own second import.
  const existing = captionNodes().length;
  if (existing > 0) removeCaptionLayers();

  const result = insertCaptionLayers(cues);
  const skipped = result.skipped > 0 ? `, ${result.skipped} overlapping cue(s) dropped` : '';
  const replaced = existing > 0 ? ` (replaced ${existing})` : '';
  notify(`Added ${result.nodeIds.length} caption layer(s) from ${picked.name}${replaced}${skipped}`);
}

async function generateCaptions(): Promise<void> {
  const { startSec, endSec } = captionRange();
  // The user is about to wait on a network round trip over a file that grows
  // with the range, so say what is happening before it starts rather than
  // leaving the app looking frozen.
  notify(`Transcribing ${(endSec - startSec).toFixed(1)}s of audio…`, 'info', 3000);

  try {
    const cues = await transcribeComposition({ startSec, endSec, rootId: activeCompRootId() });
    const existing = captionNodes().length;
    if (existing > 0) removeCaptionLayers();
    const result = insertCaptionLayers(cues);
    notify(`Generated ${result.nodeIds.length} caption layer(s)`);
  } catch (err) {
    notify(
      err instanceof TranscribeError ? err.message : `Transcription failed: ${String(err)}`,
      'error',
      8000,
    );
  }
}

function exportCaptions(format: 'srt' | 'vtt'): void {
  const cues = readCaptionCues();
  if (cues.length === 0) {
    notify('There are no caption layers in this composition to export.', 'warning');
    return;
  }
  const text = format === 'srt' ? toSrt(cues) : toVtt(cues);
  downloadBlob(
    new Blob([text], { type: format === 'srt' ? 'application/x-subrip' : 'text/vtt' }),
    `${captionFileStem()}.${format}`,
  );
  notify(`Exported ${cues.length} caption(s)`);
}

function clearCaptions(): void {
  const removed = removeCaptionLayers();
  notify(removed === 0 ? 'There were no caption layers to remove.' : `Removed ${removed} caption layer(s)`, removed === 0 ? 'info' : 'success');
}

/** Every caption command, for `buildStaticCommands`. */
export function buildCaptionCommands(): ReadonlyArray<Command> {
  return [
    {
      id: asCommandId('captions.import'),
      label: 'Import Captions…',
      icon: 'type',
      enabled: () => true,
      execute: () => { void importCaptions(); },
    },
    {
      id: asCommandId('captions.generate'),
      label: 'Generate Captions from Audio',
      icon: 'audio',
      // Disabled rather than hidden where the shell cannot transcribe: a
      // missing menu item reads as "this app has no captions", a greyed one
      // reads as "not here", which is the true statement.
      enabled: () => transcriptionAvailable(),
      execute: () => { void generateCaptions(); },
    },
    {
      id: asCommandId('captions.exportSrt'),
      label: 'Export Captions (.srt)…',
      icon: 'download',
      enabled: () => captionNodes().length > 0,
      execute: () => exportCaptions('srt'),
    },
    {
      id: asCommandId('captions.exportVtt'),
      label: 'Export Captions (.vtt)…',
      icon: 'download',
      enabled: () => captionNodes().length > 0,
      execute: () => exportCaptions('vtt'),
    },
    {
      id: asCommandId('captions.clear'),
      label: 'Remove All Captions',
      icon: 'trash',
      enabled: () => captionNodes().length > 0,
      execute: () => clearCaptions(),
    },
  ];
}
