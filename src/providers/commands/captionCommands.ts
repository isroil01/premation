/**
 * The caption commands (Import / Generate / Export .srt·.vtt / Remove All) over
 * the engine (B4 round 7).
 *
 * The composition's captions are its top-level `LayerInfo.caption` layers (the
 * document mirror); their cues come from the engine's `getCaptionCues` (each
 * caption's first bar and the text it shows); an import or a generate
 * REPLACES them in one entry (`captionReplaceCommands`: `deleteLayers` of the
 * old + one `pasteLayers` of the styled layers built off-document). The export
 * range is the composition's work area when it has one, else the whole comp.
 */

import { asCommandId } from '@app-types/common';
import { flicksToSeconds, type Command as EngineCommand } from '@motion/engine-api';
import type { Command } from '@core/commands/Command';
import { engine } from '@core/engine/engineInstance';
import { edit } from '@core/engine/uiEdits';
import { captionReplaceCommands } from '@core/engine/captionEdit';
import { downloadBlob } from '@core/export/exportManager';
import { CaptionFormatError, parseCaptions, toSrt, toVtt, type Cue } from '@core/captions/captionFormat';
import { TranscribeError, transcribeComposition, transcriptionAvailable } from '@core/captions/transcribe';
import { documentMirror } from '@stores/documentMirror';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { activeCompIdNow } from '@hooks/useMirror';

function notify(message: string, level: 'success' | 'info' | 'warning' | 'error' = 'success', durationMs = 4000): void {
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
    // Chromium fires this when the dialog is dismissed; without it the promise never settles.
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/** The active composition's caption layers (top level, `LayerInfo.caption`). */
export function captionLayerIds(comp: string | undefined = activeCompIdNow()): string[] {
  if (!comp) return [];
  const m = documentMirror();
  return (m.comp(comp)?.layers ?? []).filter((id) => m.layer(id)?.caption === true);
}

/** The export range, composition seconds: the work area if one is set, else the whole composition. */
export function captionRange(comp: string | undefined = activeCompIdNow()): { startSec: number; endSec: number } {
  const s = comp ? documentMirror().comp(comp)?.settings : undefined;
  if (!s) return { startSec: 0, endSec: 0 };
  const whole = flicksToSeconds(s.duration);
  const start = flicksToSeconds(s.workArea.start);
  const end = start + flicksToSeconds(s.workArea.duration);
  return end > start && (start > 0 || end < whole) ? { startSec: start, endSec: end } : { startSec: 0, endSec: whole };
}

/** Replace the active composition's captions with `cues`, as ONE entry. */
export async function replaceCaptions(cues: readonly Cue[]): Promise<{ added: string[]; removed: number; skipped: number }> {
  const comp = activeCompIdNow();
  if (!comp) return { added: [], removed: 0, skipped: cues.length };
  const settings = documentMirror().comp(comp)?.settings;
  const e = captionReplaceCommands(cues, { rootId: comp, width: settings?.width ?? 1920, height: settings?.height ?? 1080 }, captionLayerIds(comp));
  if (e.commands.length === 0) return { added: [], removed: 0, skipped: e.skipped };
  const res = await edit(`Add ${e.added} caption${e.added === 1 ? '' : 's'}`, e.commands);
  if (!res.ok) return { added: [], removed: 0, skipped: e.skipped };
  const added = e.added > 0 ? ((res.value.at(-1) as { layers?: string[] } | undefined)?.layers ?? []) : [];
  if (added.length > 0) useSelectionStore.getState().set(added);
  return { added, removed: e.removed, skipped: e.skipped };
}

/** The active composition's captions as cues (the engine's `getCaptionCues`). */
export async function captionCues(): Promise<Cue[]> {
  const comp = activeCompIdNow();
  if (!comp) return [];
  const res = await engine().query({ type: 'getCaptionCues', comp });
  return res.ok ? res.value.cues.map((c) => ({ start: flicksToSeconds(c.start), end: flicksToSeconds(c.end), text: c.text })) : [];
}

async function importCaptions(): Promise<void> {
  const picked = await pickCaptionFile();
  if (!picked) return;
  let cues: Cue[];
  try {
    cues = parseCaptions(picked.text);
  } catch (err) {
    notify(err instanceof CaptionFormatError ? err.message : String(err), 'error', 6000);
    return;
  }
  // Replacing, not adding: a second import over an unremoved first is doubled text.
  const r = await replaceCaptions(cues);
  const skipped = r.skipped > 0 ? `, ${r.skipped} overlapping cue(s) dropped` : '';
  const replaced = r.removed > 0 ? ` (replaced ${r.removed})` : '';
  notify(`Added ${r.added.length} caption layer(s) from ${picked.name}${replaced}${skipped}`);
}

async function generateCaptions(): Promise<void> {
  const comp = activeCompIdNow();
  if (!comp) return;
  const { startSec, endSec } = captionRange(comp);
  // A JOB rather than a timed toast: the transcription can run for a while.
  const ui = useUIStore.getState();
  ui.startJob({ id: 'transcribe', label: `Transcribing ${(endSec - startSec).toFixed(1)}s of audio…` });
  try {
    const cues = await transcribeComposition({ startSec, endSec, rootId: comp });
    const r = await replaceCaptions(cues);
    useUIStore.getState().finishJob('transcribe', { status: 'done', message: `Generated ${r.added.length} caption layer(s)` });
  } catch (err) {
    useUIStore.getState().finishJob('transcribe', {
      status: 'failed',
      message: err instanceof TranscribeError ? err.message : `Transcription failed: ${String(err)}`,
    });
  }
}

async function exportCaptions(format: 'srt' | 'vtt'): Promise<void> {
  const cues = await captionCues();
  if (cues.length === 0) {
    notify('There are no caption layers in this composition to export.', 'warning');
    return;
  }
  const text = format === 'srt' ? toSrt(cues) : toVtt(cues);
  const comp = activeCompIdNow();
  const stem = (comp ? documentMirror().comp(comp)?.settings.name?.trim() : '') || 'captions';
  downloadBlob(new Blob([text], { type: format === 'srt' ? 'application/x-subrip' : 'text/vtt' }), `${stem}.${format}`);
  notify(`Exported ${cues.length} caption(s)`);
}

/** Remove every caption layer of the active composition, as one entry. Resolves to the count removed. */
export async function removeCaptions(): Promise<number> {
  const ids = captionLayerIds();
  if (ids.length === 0) return 0;
  const res = await edit(`Remove ${ids.length} caption${ids.length === 1 ? '' : 's'}`, [{ type: 'deleteLayers', layers: ids } as EngineCommand]);
  return res.ok ? ids.length : 0;
}

async function clearCaptions(): Promise<void> {
  const removed = await removeCaptions();
  notify(removed === 0 ? 'There were no caption layers to remove.' : `Removed ${removed} caption layer(s)`, removed === 0 ? 'info' : 'success');
}

/** Every caption command, for `buildStaticCommands`. */
export function buildCaptionCommands(): ReadonlyArray<Command> {
  const has = (): boolean => captionLayerIds().length > 0;
  return [
    { id: asCommandId('captions.import'), label: 'Import Captions…', icon: 'type', enabled: () => true, execute: () => { void importCaptions(); } },
    {
      id: asCommandId('captions.generate'),
      label: 'Generate Captions from Audio',
      icon: 'audio',
      // Disabled rather than hidden where the shell cannot transcribe.
      enabled: () => transcriptionAvailable(),
      execute: () => { void generateCaptions(); },
    },
    { id: asCommandId('captions.exportSrt'), label: 'Export Captions (.srt)…', icon: 'download', enabled: has, execute: () => { void exportCaptions('srt'); } },
    { id: asCommandId('captions.exportVtt'), label: 'Export Captions (.vtt)…', icon: 'download', enabled: has, execute: () => { void exportCaptions('vtt'); } },
    { id: asCommandId('captions.clear'), label: 'Remove All Captions', icon: 'trash', enabled: has, execute: () => clearCaptions() },
  ];
}
