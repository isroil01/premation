/**
 * Automatic subject tracking (the approved Subjects Pro design, board 4:
 * "background tracking"; After Effects' Object Matte propagates as you move
 * through the shot, never leaving a selection standing still).
 *
 * A subject selected on one frame of a VIDEO is otherwise held — the same
 * matte on every frame — so a style on it (an outline, a glow) stays where
 * the subject was while the subject moves on. Here every subject edit on
 * footage that moves starts tracking by itself, in the background:
 *
 *   first selection      the subject is Followed over the work area, both
 *                        ways from the frame it was selected on
 *   a fix on a tracked   only the frames between the fixes either side are
 *   subject              re-tracked from the fixed frame (retrackSubject)
 *
 * Edits close together (Shift-click, Shift-click, Alt-click) wait for a pause
 * (SETTLE_MS) and run once; an edit while a walk of that subject runs cancels
 * the walk, which then starts over from the newer matte. Locked subjects and
 * stills are left alone. Turned off with the Tracking block's "Track
 * automatically" (subjectStore.autoTrack).
 */

import { useSubjectStore } from '@stores/subjectStore';
import { activeCompSettingsNow } from '@hooks/useMirrorFrame';
import { settingsFps } from '@core/mirror/compFacts';
import { onSubjectEdited } from '@core/workspace/rotoBrushTool';
import { subjectLocked } from '@core/workspace/subjects';
import { fetchSubjectTracks, isTracked, retrackRange } from '@core/workspace/subjectTracks';
import { cancelSubjectWalk, followSubject, layerMoves, retrackSubject } from './subjectActions';

/** How long the edits must pause before tracking starts. */
const SETTLE_MS = 1200;

const pending = new Map<string, ReturnType<typeof setTimeout>>();

/** What tracking an edit at `time` asks for: a whole Follow, a re-track between fixes, or nothing. */
export async function trackingFor(nodeId: string, subject: string, time: number): Promise<'follow' | 'retrack' | null> {
  if (!layerMoves(nodeId) || subjectLocked(nodeId, subject)) return null;
  const fps = settingsFps(activeCompSettingsNow());
  const frames = (await fetchSubjectTracks(nodeId)).find((s) => s.subject === subject)?.frames ?? [];
  if (frames.length === 0) return null;  // the edit left nothing (an Alt-click took it all)
  if (!isTracked(frames, fps)) return 'follow';
  // A fix outside the tracked frames (beyond the work area it was followed over) is left as it is.
  return retrackRange(frames, time, fps) ? 'retrack' : null;
}

async function run(nodeId: string, subject: string, time: number): Promise<void> {
  if (!useSubjectStore.getState().autoTrack) return;
  const what = await trackingFor(nodeId, subject, time);
  if (what === 'follow') await followSubject(nodeId, subject, time);
  else if (what === 'retrack') await retrackSubject(nodeId, subject, time);
}

/** Start listening to subject edits. Returns the stop. */
export function installAutoTrack(): () => void {
  const off = onSubjectEdited((nodeId, subject, time) => {
    if (!useSubjectStore.getState().autoTrack || !layerMoves(nodeId)) return;
    const key = `${nodeId}:${subject}`;
    // The edit makes any walk of this subject stale: it starts over once the edits settle.
    cancelSubjectWalk(nodeId, subject);
    const was = pending.get(key);
    if (was) clearTimeout(was);
    pending.set(key, setTimeout(() => {
      pending.delete(key);
      void run(nodeId, subject, time);
    }, SETTLE_MS));
  });
  return () => {
    off();
    for (const t of pending.values()) clearTimeout(t);
    pending.clear();
  };
}
