/**
 * The timeline's TRANSPORT and VIEW state — the playhead, play / pause, loop,
 * the ruler's zoom and scroll — as UI code reaches it (B4, docs/B4_MIRROR.md).
 *
 * None of this is the document: transport is engine-owned control state
 * (ENGINE_API.md §6: play / pause / seek / step / setLoop are `[control]`
 * commands that never touch the document or history), and zoom / scroll are
 * editor view state (CLAUDE.md: editor state never enters the document).
 *
 * Block 3 (docs/TS_ENGINE_REMOVAL.md): this no longer forwards to the page
 * replica's TimelineController. The playhead IS the transient clock
 * (`playbackClockStore`, per tab) — the engine's `playhead` events write it
 * and a move made here is sent to the engine as a seek
 * (core/engine/engineTransport.ts); playing IS the active tab's `playing`
 * flag (engineTransport turns it into `play` / `pause`); the ruler's zoom,
 * scroll and the Loop toggle are `timelineViewStore`. Document facts — rate,
 * duration, markers, keyframes — come from the document mirror.
 *
 * Listed in the B4 read rule's SEAM_MODULES (scripts/lint/engineReadsRule.mjs)
 * like `transportController`: using it is not a document read.
 */

import { flicksToSeconds } from '@motion/engine-api';
import { documentMirror } from '@stores/documentMirror';
import { useWorkspaceStore } from '@stores/projectStore';
import { getClock, setTime } from '@stores/playbackClockStore';
import { useSelectionStore } from '@stores/selectionStore';
import {
  DEFAULT_TIMELINE_PPS,
  clampPixelsPerFrame,
  patchTimelineView,
  timelineViewOf,
  useTimelineViewStore,
} from '@stores/timelineViewStore';
import { framesOfTime, settingsFps } from '@core/mirror/compFacts';

// ── The active composition ───────────────────────────────────────────

function activeTab(): { id: string; comp: string; playing: boolean } | null {
  const ws = useWorkspaceStore.getState();
  const id = ws.activeTabId;
  const tab = id ? ws.tabs[id] : undefined;
  return id && tab ? { id, comp: tab.compositionId ?? '', playing: tab.playing === true } : null;
}

function settingsOf(comp: string) {
  return documentMirror().comp(comp)?.settings;
}

/** The composition's rate as stored (29.97, not 30000/1001 — what bars and frames are counted in). */
function fpsOf(comp: string): number {
  return settingsFps(settingsOf(comp)) || 30;
}

/** The composition's length, whole frames (the playhead may sit ON the end frame, as before). */
function durationFramesOf(comp: string): number {
  const s = settingsOf(comp);
  return s ? Math.max(0, Math.round(framesOfTime(s.duration, fpsOf(comp)))) : 0;
}

function frameSeconds(comp: string, frame: number): number {
  const rate = settingsOf(comp)?.frameRate;
  if (rate && rate.num > 0) return (frame * (rate.den || 1)) / rate.num;
  return frame / fpsOf(comp);
}

/** Move the active tab's playhead to a whole frame (clamped to the composition). */
function seekFrame(frame: number): void {
  const tab = activeTab();
  if (!tab) return;
  const dur = durationFramesOf(tab.comp);
  const f = Math.round(Math.min(dur > 0 ? dur : Number.POSITIVE_INFINITY, Math.max(0, frame)));
  setTime(tab.id, frameSeconds(tab.comp, f), f);
}

function currentFrame(): number {
  const tab = activeTab();
  return tab ? getClock(tab.id).frame : 0;
}

// ── Playhead ─────────────────────────────────────────────────────────

/** The active composition's playhead, seconds. */
export function playheadSeconds(): number {
  const tab = activeTab();
  return tab ? getClock(tab.id).time : 0;
}

/** Move the active composition's playhead (seconds). */
export function seekPlayhead(seconds: number): void {
  const tab = activeTab();
  if (!tab) return;
  seekFrame(seconds * fpsOf(tab.comp));
}

export function goToStart(): void {
  seekFrame(0);
}

export function goToEnd(): void {
  const tab = activeTab();
  if (tab) seekFrame(durationFramesOf(tab.comp));
}

export function stepForward(): void {
  seekFrame(Math.floor(currentFrame()) + 1);
}

export function stepBackward(): void {
  seekFrame(Math.ceil(currentFrame()) - 1);
}

/** Every keyframe time (comp seconds, sorted) of the selected layers — or of every layer of the active comp. */
function keyframeTimes(comp: string): number[] {
  const m = documentMirror();
  const selected = useSelectionStore.getState().ids.filter((id) => m.layer(id));
  const ids = selected.length > 0 ? selected : [...(m.comp(comp)?.layers ?? [])];
  const times = new Set<number>();
  for (const id of ids) {
    // The mirror's keyframes are on the COMPOSITION's time axis already.
    for (const keys of m.layerKeyframes(id).values()) for (const k of keys) times.add(flicksToSeconds(k.time));
  }
  return [...times].sort((a, b) => a - b);
}

/** Seek to the next keyframe after the playhead (selected layers, or all). */
export function goToNextKeyframe(): void {
  const tab = activeTab();
  if (!tab) return;
  const now = playheadSeconds();
  const next = keyframeTimes(tab.comp).find((t) => t > now + 0.0001);
  if (next !== undefined) seekPlayhead(next);
}

/** Seek to the previous keyframe before the playhead (selected layers, or all). */
export function goToPrevKeyframe(): void {
  const tab = activeTab();
  if (!tab) return;
  const now = playheadSeconds();
  const prev = keyframeTimes(tab.comp).reverse().find((t) => t < now - 0.0001);
  if (prev !== undefined) seekPlayhead(prev);
}

/** The active composition's markers, whole frames, in time order. */
function markerFrames(): number[] {
  const tab = activeTab();
  if (!tab) return [];
  const fps = fpsOf(tab.comp);
  return (documentMirror().comp(tab.comp)?.markers ?? [])
    .map((mk) => Math.round(framesOfTime(mk.time, fps)))
    .sort((a, b) => a - b);
}

/** Seek to the next comp marker after the playhead. */
export function goToNextMarker(): void {
  const f = Math.round(currentFrame());
  const next = markerFrames().find((m) => m > f);
  if (next !== undefined) seekFrame(next);
}

/** Seek to the previous comp marker before the playhead. */
export function goToPrevMarker(): void {
  const f = Math.round(currentFrame());
  const prev = markerFrames().reverse().find((m) => m < f);
  if (prev !== undefined) seekFrame(prev);
}

/** Seek to the Nth comp marker (1-based, time order); false when there is none. */
export function goToMarkerIndex(n: number): boolean {
  if (!Number.isInteger(n) || n < 1) return false;
  const m = markerFrames()[n - 1];
  if (m === undefined) return false;
  seekFrame(m);
  return true;
}

// ── Play state ───────────────────────────────────────────────────────

export function isTransportPlaying(): boolean {
  return activeTab()?.playing === true;
}

export function playTransport(): void {
  const tab = activeTab();
  if (!tab) return;
  // Restart from the beginning when parked at the end.
  const dur = durationFramesOf(tab.comp);
  if (dur > 0 && currentFrame() >= dur) seekFrame(0);
  if (!tab.playing) useWorkspaceStore.getState().actions.setPlaying(true);
}

export function pauseTransport(): void {
  if (activeTab()?.playing) useWorkspaceStore.getState().actions.setPlaying(false);
}

/**
 * Kept for the playback hook: the active tab's `playing` flag IS the play
 * state now (engineTransport sends it to the engine), so there is nothing to
 * mirror.
 */
export function syncTransportPlaying(_playing: boolean): void {
  // The flag is the state.
}

export function togglePlayTransport(): void {
  if (isTransportPlaying()) pauseTransport();
  else playTransport();
}

/** Stop every composition's transport except the active one (tab switch mid-playback). */
export function pauseInactiveComps(): void {
  const ws = useWorkspaceStore.getState();
  for (const tab of Object.values(ws.tabs)) {
    if (tab.id !== ws.activeTabId && tab.playing) ws.actions.setTabPlaying(tab.id, false);
  }
}

/** Loop playback of the active composition (AE's loop toggle; follows the work area). */
export function isTransportLooping(): boolean {
  const tab = activeTab();
  return tab ? timelineViewOf(tab.comp).looping : true;
}

export function setTransportLooping(on: boolean): void {
  const tab = activeTab();
  if (tab) patchTimelineView(tab.comp, { looping: on });
}

// ── Ruler view (editor state) ────────────────────────────────────────

function pixelsPerFrameOf(comp: string): number {
  return timelineViewOf(comp).pixelsPerFrame ?? clampPixelsPerFrame(DEFAULT_TIMELINE_PPS / fpsOf(comp));
}

/** The ruler's zoom, pixels per second. */
export function timelinePixelsPerSecond(): number {
  const tab = activeTab();
  if (!tab) return DEFAULT_TIMELINE_PPS;
  return pixelsPerFrameOf(tab.comp) * fpsOf(tab.comp);
}

/** Set the ruler's zoom, optionally keeping `anchorSeconds` under the pointer. */
export function setTimelinePixelsPerSecond(pps: number, anchorSeconds?: number): void {
  const tab = activeTab();
  if (!tab || !(pps > 0)) return;
  const fps = fpsOf(tab.comp);
  const prev = pixelsPerFrameOf(tab.comp);
  const next = clampPixelsPerFrame(pps / fps);
  if (next === prev) return;
  let scrollX = timelineViewOf(tab.comp).scrollX;
  if (anchorSeconds !== undefined) {
    // Keep the anchor frame at the same on-screen pixel.
    const anchor = anchorSeconds * fps;
    scrollX = anchor - ((anchor - scrollX) * prev) / next;
  }
  patchTimelineView(tab.comp, { pixelsPerFrame: next, scrollX: Math.max(0, scrollX) });
}

/** Fit the whole composition into `viewportWidthPx`. */
export function fitTimelineZoom(viewportWidthPx: number): void {
  const tab = activeTab();
  if (!tab) return;
  const w = Math.max(1, viewportWidthPx - 24);
  const dur = Math.max(1, durationFramesOf(tab.comp));
  patchTimelineView(tab.comp, { pixelsPerFrame: clampPixelsPerFrame(w / dur), scrollX: 0 });
}

/** Mirror the timeline's horizontal scroll (px) into the ruler view. */
export function setTimelineScrollPixels(scrollLeftPx: number): void {
  const tab = activeTab();
  if (!tab) return;
  const ppf = pixelsPerFrameOf(tab.comp);
  if (ppf > 0) patchTimelineView(tab.comp, { scrollX: Math.max(0, scrollLeftPx / ppf) });
}

/**
 * Call `listener` whenever the ACTIVE composition's ruler zoom changes. Bound
 * to the composition active when called — re-subscribe on a tab switch.
 */
export function onTimelineZoomChanged(listener: () => void): () => void {
  const comp = activeTab()?.comp ?? '';
  return useTimelineViewStore.subscribe((s, prev) => {
    if (s.views[comp]?.pixelsPerFrame !== prev.views[comp]?.pixelsPerFrame) listener();
  });
}
