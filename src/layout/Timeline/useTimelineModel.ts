/**
 * The timeline's MODEL from the document mirror (B4, docs/B4_MIRROR.md) — the
 * one way the editor shell (App.tsx), the pop-out timeline and the panels
 * benchmark build it.
 *
 *   useTimelineTracks(comp, expanded)   the rows (`buildTimelineTracks`)
 *   useTimelineRuler(comp)              duration / frame rate / start frame / markers / work area
 *   useTimelinePixelsPerSecond(comp)    the ruler's zoom (editor view state, `timelineView`)
 *
 * ── Subscriptions ───────────────────────────────────────────────────────
 * Exactly what the builder reads: the comp's record and stack order, layer
 * membership, every listed layer's header (`layer:`) and keyframes (`keys:`),
 * and — for EXPANDED rows only — their property trees (`tree:`, retained here)
 * plus the throttled display time (their value fields read at the playhead).
 * Nothing wakes on the raw clock, and a collapsed timeline never re-renders
 * while the playhead moves.
 *
 * ── Identity ────────────────────────────────────────────────────────────
 * `buildTimelineTracks` keeps each unchanged row's object (its cache); this
 * hook also keeps the ARRAY when every row is unchanged, so an edit to a layer
 * of another composition does not hand <Timeline> a new model.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { flicksToSeconds } from '@motion/engine-api';
import { documentMirror, type DocumentMirror } from '@stores/documentMirror';
import { useDisplayClockStore } from '@stores/playbackClockStore';
import { useProjectStore } from '@stores/projectStore';
import { compFps, useMirrorComp, useRetainTrees } from '@hooks/useMirror';
import { onTimelineZoomChanged, timelinePixelsPerSecond } from '@core/timeline/timelineView';
import { buildTimelineTracks, compMarkersOf, createTrackCache, workAreaOf, type TimelineTrackCache } from './timelineTracks';
import type { TimelineMarker, TimelineModel, TimelineTrack } from './TimelineModel';

const NO_TRACKS: TimelineTrack[] = [];

/** The composition the timeline shows: the tab's, else the document's first. */
function resolveComp(m: DocumentMirror, compId: string | undefined): string | undefined {
  return compId || m.compIds[0];
}

/** Re-render when any of `keys` changes (subscription keyed on the array's IDENTITY — 2,000 layers' keys are never joined per render). */
function useKeysVersion(m: DocumentMirror, keys: readonly string[]): number {
  const ver = useRef(0);
  const subscribe = useMemo(
    () => (cb: () => void) => m.subscribe(keys, () => {
      ver.current += 1;
      cb();
    }),
    [m, keys],
  );
  return useSyncExternalStore(subscribe, () => ver.current, () => ver.current);
}

/**
 * Re-render at the throttled display time while `on` (an expanded row shows
 * values at the playhead); never while off. Returns the time, or 0 when off.
 */
function useThrottledTimeWhen(on: boolean): number {
  const tab = useProjectStore((s) => s.activeTabId) ?? '';
  return useDisplayClockStore((s) => (on ? s.clocks[tab]?.time ?? 0 : 0));
}

/** The comp's rows, top of the stack first, rendered from the mirror only. */
export function useTimelineTracks(compId: string | undefined, expandedIds: ReadonlyArray<string>): TimelineTrack[] {
  const m = documentMirror();
  const comp = resolveComp(m, compId);
  const cacheRef = useRef<TimelineTrackCache | null>(null);
  if (!cacheRef.current) cacheRef.current = createTrackCache();
  const lastRef = useRef<TimelineTrack[]>(NO_TRACKS);

  // Expanded rows draw their property trees: keep them loaded.
  useRetainTrees(expandedIds);

  // The comp's stack decides which layers' records the rows read. Reading it
  // here is safe: `order:`/`comp:` are in the keys, so a new stack re-renders
  // and re-subscribes.
  const order = comp ? m.comp(comp)?.layers : undefined;
  const keys = useMemo(() => {
    const out = ['comps', 'layers'];
    if (comp) out.push(`comp:${comp}`, `order:${comp}`);
    for (const id of order ?? []) out.push(`layer:${id}`, `keys:${id}`);
    for (const id of expandedIds) out.push(`tree:${id}`);
    return out;
  }, [comp, order, expandedIds]);
  const ver = useKeysVersion(m, keys);
  useThrottledTimeWhen(expandedIds.length > 0);

  return useMemo(() => {
    void ver;
    const next = buildTimelineTracks(m, comp, expandedIds, cacheRef.current!);
    const prev = lastRef.current;
    if (prev.length === next.length && prev.every((t, i) => t === next[i])) return prev;
    lastRef.current = next;
    return next;
  }, [m, comp, expandedIds, ver]);
}

export interface TimelineRuler {
  duration: number;
  frameRate: number;
  startFrame: number;
  markers: TimelineMarker[];
  workArea: TimelineModel['workArea'];
}

/** The comp's ruler facts (seconds), from its mirror record. */
export function useTimelineRuler(compId: string | undefined): TimelineRuler {
  const m = documentMirror();
  const comp = useMirrorComp(resolveComp(m, compId));
  return useMemo(() => {
    const fps = compFps(comp);
    return {
      duration: comp ? flicksToSeconds(comp.settings.duration) : 0,
      frameRate: fps,
      startFrame: comp ? Math.round(flicksToSeconds(comp.settings.startTimecode) * fps) : 0,
      markers: compMarkersOf(comp),
      workArea: workAreaOf(comp),
    };
  }, [comp]);
}

/** The ruler's zoom (px/s) of the active composition's timeline, following zoom gestures. */
export function useTimelinePixelsPerSecond(compId: string | undefined): number {
  const [pps, setPps] = useState(() => timelinePixelsPerSecond());
  useEffect(() => {
    setPps(timelinePixelsPerSecond());
    return onTimelineZoomChanged(() => setPps(timelinePixelsPerSecond()));
  }, [compId]);
  return pps;
}
