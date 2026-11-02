/**
 * Fill the gap a Separated subject left in its clip (Photoshop's
 * Content-Aware Move, for video): after Separate Subject the original layer
 * still shows the subject, so moving the cut-out shows it twice. This runs
 * Content-Aware Fill on the ORIGINAL with the subject's own tracked matte as
 * the hole (ContentAwareFillJob `subject`) over the frames it was tracked —
 * the background rebuilt from the frame and its neighbours — attached as one
 * undo entry when it finishes. A Tasks-panel job; it can be stopped.
 */

import { activeCompSettingsNow } from '@hooks/useMirrorFrame';
import { settingsDurationSeconds, settingsFps } from '@core/mirror/compFacts';
import { startContentAwareFill } from '@core/tracking/contentAwareFill';
import { fetchSubjectTracks, isTracked } from '@core/workspace/subjectTracks';
import { useUIStore } from '@stores/uiStore';
import { t } from '@core/i18n';

/** The frames to fill: the subject's tracked span, else (held on a frame or two) the whole composition. */
export async function gapRange(layer: string, subject: string): Promise<{ start: number; end: number } | null> {
  const settings = activeCompSettingsNow();
  const fps = settingsFps(settings);
  const frames = (await fetchSubjectTracks(layer)).find((s) => s.subject === subject)?.frames ?? [];
  if (frames.length === 0) return null;
  if (!isTracked(frames, fps)) return { start: 0, end: settingsDurationSeconds(settings) };
  return { start: frames[0]!.time, end: frames[frames.length - 1]!.time + 1 / fps };
}

/** Run it on `layer` (the clip the subject was separated from). */
export async function fillSubjectGap(layer: string, subject: string): Promise<void> {
  const ui = useUIStore.getState();
  const range = await gapRange(layer, subject);
  if (!range) {
    ui.notify({ level: 'warning', message: t('workspace.subjects.gapNoSubject', 'That layer has no subject left to fill behind.'), durationMs: 3600 });
    return;
  }
  const jobId = `gap-${layer}-${subject}`;
  let cancel: (() => void) | null = null;
  ui.startJob({ id: jobId, kind: 'analysis', label: t('workspace.subjects.gapFilling', 'Filling the gap behind the subject'), progress: 0, cancel: () => cancel?.() });
  try {
    const handle = await startContentAwareFill({
      layer,
      subject,
      start: range.start,
      end: range.end,
      fps: settingsFps(activeCompSettingsNow()),
      mode: 'object',
      lighting: 'subtle',
      expansion: 0,
      references: [],
    }, (f) => useUIStore.getState().updateJob(jobId, { progress: f }));
    cancel = handle.cancel;
    const out = await handle.done;
    if (out.status === 'cancelled') {
      useUIStore.getState().finishJob(jobId, { status: 'cancelled', message: t('workspace.subjects.gapCancelled', 'Gap fill stopped') });
      return;
    }
    if (out.status !== 'done') throw new Error(out.error?.message ?? t('core.contentAwareFill.feature', 'Content-Aware Fill'));
    // A still is filled on one frame (it holds for the whole clip).
    const n = out.result?.frames ?? 0;
    useUIStore.getState().finishJob(jobId, {
      status: 'done',
      message: n === 1
        ? t('workspace.subjects.gapDoneOne', 'Filled the gap on 1 frame')
        : t('workspace.subjects.gapDone', 'Filled the gap over {n} frames', { n }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    useUIStore.getState().finishJob(jobId, { status: 'failed', message });
    useUIStore.getState().notify({ level: 'warning', message, durationMs: 4200 });
  }
}
