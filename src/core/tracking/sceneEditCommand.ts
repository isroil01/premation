/**
 * The user-facing Scene Edit Detection flow: run the detector, report, apply.
 *
 * One function so the timeline's clip menu and the command registry drive the
 * same thing. Progress goes through a dismissible notification updated in
 * place (the detector is a decode-speed walk: seconds on a short clip, a
 * minute on an hour of 4K), and the result is a confirm that names the count —
 * applying 40 splits to a clip is not a thing to do silently.
 */

import { useUIStore } from '@stores/uiStore';
import { useCompositionStore } from '@stores/compositionStore';
import { customConfirm } from '@components/Modal';
import { detectSceneEdits, applySceneEditsAsMarkers, applySceneEditsAsSplits } from './sceneEditDetectLayer';

export type SceneEditMode = 'markers' | 'split';

export async function runSceneEditDetection(nodeId: string, mode: SceneEditMode): Promise<void> {
  const ui = useUIStore.getState();
  const fps = useCompositionStore.getState().fps || 30;
  const noteId = ui.notify({ level: 'info', message: 'Scene Edit Detection: reading frames… 0%', durationMs: 0 });
  let last = -1;
  const update = (message: string, level: 'info' | 'success' | 'warning' | 'error' = 'info', durationMs = 0) => {
    useUIStore.getState().dismissNotification(noteId);
    return useUIStore.getState().notify({ level, message, durationMs });
  };
  let liveId = noteId;
  try {
    const result = await detectSceneEdits({
      nodeId,
      fps,
      onProgress: (f) => {
        const pct = Math.round(f * 100);
        if (pct !== last && pct % 5 === 0) {
          last = pct;
          useUIStore.getState().dismissNotification(liveId);
          liveId = useUIStore.getState().notify({
            level: 'info', message: `Scene Edit Detection: reading frames… ${pct}%`, durationMs: 0,
          });
        }
      },
    });
    useUIStore.getState().dismissNotification(liveId);
    const n = result.cutsCompSec.length;
    const fades = result.dissolvesCompSec.length;
    if (n === 0) {
      useUIStore.getState().notify({ level: 'info', message: 'Scene Edit Detection: no cuts found in this clip.', durationMs: 3200 });
      return;
    }
    const found = fades
      ? `Found ${n - fades} cut${n - fades === 1 ? '' : 's'} and ${fades} dissolve${fades === 1 ? '' : 's'}.`
      : `Found ${n} cut${n === 1 ? '' : 's'}.`;
    const what = mode === 'split' ? `split the clip into ${n + 1} shots` : `add ${n} marker${n === 1 ? '' : 's'}`;
    const ok = await customConfirm(
      'Scene Edit Detection',
      `${found} ${what[0]!.toUpperCase()}${what.slice(1)}?`,
      { confirmLabel: mode === 'split' ? 'Split' : 'Add markers' },
    );
    if (!ok) return;
    const applied = mode === 'split'
      ? applySceneEditsAsSplits(nodeId, result.cutsCompSec)
      : applySceneEditsAsMarkers(result.cutsCompSec, result.dissolvesCompSec);
    useUIStore.getState().notify({
      level: 'success',
      message: mode === 'split' ? `Split at ${applied} cut${applied === 1 ? '' : 's'}.` : `Added ${applied} marker${applied === 1 ? '' : 's'}.`,
      durationMs: 3200,
    });
  } catch (err) {
    update(`Scene Edit Detection failed: ${err instanceof Error ? err.message : String(err)}`, 'error', 6000);
  }
}
