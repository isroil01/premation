/**
 * Layer ▸ Place Behind Subject, the context-menu item, and the Assistant's
 * `place_behind_subject`: plan from the selection, put the layers behind the
 * footage's subject (placeBehindSubject.ts, no duplicate), then either the
 * footage already has its subject, or it is made — from a point when one is
 * given (through the shot, as a Tasks-panel job), else by handing the footage
 * to the Object Matte tool.
 */

import { engine } from '@core/engine/engineInstance';
import { settingsDurationSeconds, settingsFps, settingsSetWorkArea } from '@core/mirror/compFacts';
import { playheadSeconds } from '@core/timeline/timelineView';
import { layerSize, propagateObjectMatte } from '@core/workspace/rotoBrushTool';
import { activeCompSettingsNow } from '@hooks/useMirrorFrame';
import { useRotoBrushStore } from '@stores/rotoBrushStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { t } from '@core/i18n';
import { registerPlaceBehindSubject } from '@core/workspace/placeBehindSubjectPort';
import { planPlaceBehindSubject, placeBehindSubjectEdit } from './placeBehindSubject';
import { createSubjectTrackEdit } from './subjectTrack';

export interface PlaceBehindOptions {
  /** A point on the subject, footage px from the top-left, on the frame at the playhead. */
  point?: { x: number; y: number };
  /** Which of the footage's subjects stand in front (absent = all): the text goes between them and the rest. */
  inFront?: string[];
}

export type PlaceBehindOutcome =
  | { ok: true; subject: string; matte: 'kept' | 'made' | 'pending'; frames?: number }
  | { ok: false; message: string };

const notify = (message: string, level: 'info' | 'success' | 'warning' | 'error'): void => {
  useUIStore.getState().notify({ level, message, durationMs: 4200 });
};

/** Never throws: every outcome is told (and returned, for the Assistant). */
export async function runPlaceBehindSubject(selection: readonly string[], opts: PlaceBehindOptions = {}): Promise<PlaceBehindOutcome> {
  const planned = planPlaceBehindSubject(selection);
  if (!planned.ok) {
    notify(planned.message, 'warning');
    return planned;
  }
  const made = await placeBehindSubjectEdit({ ...planned.plan, ...(opts.inFront ? { inFront: opts.inFront } : {}) });
  if (!made) return { ok: false, message: t('workspace.placeBehind.failed', 'Could not place the layers behind the subject.') };
  const { subject } = made;
  useSelectionStore.getState().set([subject]);
  if (made.hadMatte) {
    notify(t('workspace.placeBehind.done', 'The layers are behind the subject.'), 'success');
    return { ok: true, subject, matte: 'kept' };
  }
  if (!opts.point) {
    // No subject yet: the footage is the Object Matte tool's target. Click it, then Follow Through Shot.
    useUIStore.getState().setActiveTool('object-matte');
    useRotoBrushStore.getState().setNode(subject);
    useRotoBrushStore.getState().setStatus(t('workspace.placeBehind.clickSubject', 'Click the subject, then Propagate ◀▶ to cut it out through the shot.'));
    notify(t('workspace.placeBehind.pickSubject', 'Layers placed. Now click the subject with the Object Matte tool.'), 'info');
    return { ok: true, subject, matte: 'pending' };
  }
  return makeMatte(subject, opts.point);
}

/** Layer ▸ Create ▸ Subject Track (Null): the null selected, so a pick-whip to it is the next move. */
export async function runCreateSubjectTrack(layer: string): Promise<string | null> {
  const r = await createSubjectTrackEdit(layer);
  if (!r.ok) {
    notify(r.message, 'warning');
    return null;
  }
  useSelectionStore.getState().set([r.nullId]);
  notify(t('workspace.subjectTrack.done', 'Subject track: {n} keys. Parent layers to it to follow the subject.', { n: r.keys }), 'success');
  return r.nullId;
}

// The Assistant's tool reaches the edit through core's port (core cannot import the editor).
registerPlaceBehindSubject((layers, opts) => runPlaceBehindSubject(layers, opts));

async function makeMatte(subject: string, point: { x: number; y: number }): Promise<PlaceBehindOutcome> {
  const size = await engine().query({ type: 'getSourceSize', layers: [subject] });
  const s = size.ok ? size.value.sizes[0] : undefined;
  if (!s || !(s.width > 0)) return { ok: false, message: t('workspace.placeBehind.noSize', 'The footage has no picture to cut out.') };
  const settings = activeCompSettingsNow();
  const fps = settingsFps(settings);
  const origin = playheadSeconds();
  const wa = settingsSetWorkArea(settings);
  const start = wa ? wa.start : 0;
  const end = wa ? wa.end : settingsDurationSeconds(settings);
  const jobId = `place-behind-${subject}`;
  let cancelled = false;
  const ui = useUIStore.getState();
  ui.startJob({ id: jobId, kind: 'analysis', label: t('workspace.placeBehind.jobLabel', 'Cutting out the subject'), progress: 0, cancel: () => { cancelled = true; } });
  try {
    const roto = useRotoBrushStore.getState();
    // The point is in the footage's pixels; strokes are layer-local px of the layer's box (a resized layer's is smaller).
    const box = (await layerSize(subject)) ?? s;
    const local = { x: (point.x / s.width - 0.5) * box.width, y: (point.y / s.height - 0.5) * box.height };
    const r = await propagateObjectMatte(
      subject,
      [{ id: 'place-behind', kind: 'fg', points: [local], time: origin }],
      { origin, start, end, fps, direction: 'both', featherPx: roto.featherPx, refine: roto.refine },
      (f) => {
        useUIStore.getState().updateJob(jobId, { progress: f });
        return !cancelled;
      },
    );
    if (r.status === 'cancelled') {
      useUIStore.getState().finishJob(jobId, { status: 'cancelled', message: t('workspace.placeBehind.cancelled', 'Cut-out cancelled') });
      return { ok: true, subject, matte: 'pending' };
    }
    useUIStore.getState().finishJob(jobId, { status: 'done', message: t('workspace.placeBehind.cutDone', 'Subject cut out: {n} frames', { n: r.frames }) });
    return { ok: true, subject, matte: 'made', frames: r.frames };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    useUIStore.getState().finishJob(jobId, { status: 'failed', message });
    return { ok: false, message };
  }
}
