/**
 * The work area as engine edits (B3z `setWorkArea` / `clearWorkArea`) — the
 * B / N / Shift+B keys, the band drag and the transport's mark in / out.
 * Moved out of layout/Timeline/timelineEdits.ts so the shared transport
 * (core/timeline/transportController.ts) reaches the engine too instead of the
 * page replica's TimelineController.
 *
 * No React (src/core).
 */

import { framesToFlicks } from '@core/engine/time';
import { edit } from '@core/engine/uiEdits';
import { framesOfTime, settingsFps } from '@core/mirror/compFacts';
import { documentMirror } from '@stores/documentMirror';
import { useWorkspaceStore } from '@stores/projectStore';
import { playheadSeconds } from './timelineView';

function activeCompId(): string {
  const ws = useWorkspaceStore.getState();
  const tab = ws.activeTabId ? ws.tabs[ws.activeTabId] : null;
  return tab?.compositionId || 'comp_default';
}

function activeSettings() {
  return documentMirror().comp(activeCompId())?.settings;
}

/** The active composition's frame rate, as stored (29.97, not 30000/1001). */
function fps(): number {
  return settingsFps(activeSettings()) || 30;
}

/** The active composition's length, whole frames. */
function compFrames(): number {
  const s = activeSettings();
  return s ? Math.round(framesOfTime(s.duration, fps())) : 0;
}

function playheadFrame(): number {
  return Math.round(playheadSeconds() * fps());
}

/** The active composition's work area, whole frames. */
function workAreaFrames(): { start: number; duration: number } | null {
  const s = activeSettings();
  if (!s) return null;
  const rate = fps();
  return { start: Math.round(framesOfTime(s.workArea.start, rate)), duration: Math.round(framesOfTime(s.workArea.duration, rate)) };
}

/** The active composition's work area in seconds, or null when it covers the whole composition (none set). */
export function activeWorkAreaSeconds(): { start: number; end: number } | null {
  const wa = workAreaFrames();
  if (!wa || (wa.start === 0 && wa.duration >= compFrames())) return null;
  const rate = fps();
  return { start: wa.start / rate, end: (wa.start + wa.duration) / rate };
}

async function sendWorkArea(startF: number, endF: number): Promise<void> {
  const rate = fps();
  const wa = workAreaFrames();
  if (wa && wa.start === startF && wa.duration === endF - startF) return;
  await edit('Work Area', {
    type: 'setWorkArea',
    comp: activeCompId(),
    range: { start: framesToFlicks(startF, rate), duration: framesToFlicks(endF - startF, rate) },
  });
}

/** Set the work area in comp seconds (whole frames, inside the comp). */
export async function setWorkArea(startSeconds: number, endSeconds: number): Promise<void> {
  const rate = fps();
  const startF = Math.max(0, Math.round(startSeconds * rate));
  const endF = Math.min(compFrames(), Math.round(endSeconds * rate));
  if (endF <= startF) return;
  await sendWorkArea(startF, endF);
}

/**
 * Shift+B — clear the work area: it covers the whole composition again and
 * follows its duration (`clearWorkArea`, B3z).
 */
export async function clearWorkArea(): Promise<void> {
  // Nothing to clear when the work area already covers the whole composition
  // (the API always states one; "none" is the full range).
  const wa = workAreaFrames();
  if (!wa || (wa.start === 0 && wa.duration >= compFrames())) return;
  await edit('Clear Work Area', { type: 'clearWorkArea', comp: activeCompId() });
}

/** B — the work-area in point at the playhead (at/past the out point MOVES the area). */
export async function setWorkAreaIn(): Promise<void> {
  const f = playheadFrame();
  const wa = workAreaFrames();
  const last = compFrames();
  const outFrame = wa && f < wa.start + wa.duration ? wa.start + wa.duration : last;
  const start = Math.max(0, Math.min(f, last - 1));
  if (outFrame <= start) return;
  await sendWorkArea(start, outFrame);
}

/** N — the work-area out point at the playhead (at/before the in point pulls it back to 0). */
export async function setWorkAreaOut(): Promise<void> {
  const f = playheadFrame();
  const wa = workAreaFrames();
  const inFrame = wa && f > wa.start ? wa.start : 0;
  const end = Math.min(compFrames(), Math.max(f, inFrame + 1));
  if (end <= inFrame) return;
  await sendWorkArea(inFrame, end);
}
