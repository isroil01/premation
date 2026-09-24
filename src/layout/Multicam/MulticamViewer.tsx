/**
 * Multicam Viewer — every angle at once, click (or Alt+digit) to cut.
 *
 * Premiere's multicam monitor, sized to this engine: each cell is a muted
 * `<video>` element seeked to the playhead through its layer's clip mapping
 * (bar start + sourceIn), so what a cell shows is what a cut to that angle
 * would show. Cutting goes through `switchMulticamAngle`, the same hold-
 * keyframe write the Alt+digit shortcuts use — the viewer adds no second
 * cutting mechanism, only eyes.
 *
 * Scrub-follow is paused-preview quality (per-cell seeks, throttled to rAF);
 * it does not attempt gapless multi-angle PLAYBACK, which needs a compositor
 * of its own. The "Sync by Audio" button runs `alignMulticamByAudio`.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@utils/cn';
import { openModal } from '@stores/modalStore';
import { useCurrentTime, useThrottledTime } from '@stores/playbackClockStore';
import { useAssetStore } from '@stores/assetStore';
import { useUIStore } from '@stores/uiStore';
import { documentMirror } from '@stores/documentMirror';
import { useMirrorKeys, useRetainTrees } from '@hooks/useMirror';
import { flicksToSeconds } from '@motion/engine-api';
import { readTrack } from '@core/mirror/selection';
import { trackRefIn } from '@core/mirror/trackIndex';
import {
  planMulticamAudioSync,
  multicamLayersInActiveComp,
  switchMulticamAngle,
} from '@core/composition/multicam';
import { Button } from '@components/Button';
import { EmptyState } from '@components/EmptyState';
import { moveBars } from '@layout/Timeline/timelineEdits';
import styles from './MulticamViewer.module.css';

interface AngleView {
  id: string;
  angle: number;
  name: string;
  src: string | null;
  /** Comp seconds where this angle's bar starts. */
  barStartSec: number;
  /** Seconds into the source where the bar's content begins. */
  sourceInSec: number;
}

/** Any document revision (see MulticamViewerBody), plus membership and items. */
const DOC_KEYS: readonly string[] = ['doc', 'layers', 'items'];

function collectAngleViews(): AngleView[] {
  const m = documentMirror();
  // B4-gap: the playable media URL of the footage (`asset.src`: the blob: /
  // file URL the decoder opens) — ItemInfo carries the on-disk `path` only
  // ('' for a browser import); an ItemInfo media URL field would close it.
  const assets = useAssetStore.getState().assets;
  // B4-gap: which layers are multicam angles, and their numbers — the
  // `__multicamAngle` tag on the Transform component has no catalog path (a
  // `layer/multicamAngle` int field would close it).
  return multicamLayersInActiveComp().map((l) => {
    const layer = m.layer(l.id);
    const assetId = layer?.source;
    const asset = assetId ? assets.find((a) => a.id === assetId) : null;
    // One bar per layer (`timing`, comp flicks): its head plays source time
    // `inPoint − startTime` (what the bar's `sourceIn` was).
    const timing = layer?.timing;
    return {
      id: l.id,
      angle: l.angle,
      name: layer?.name || l.name,
      src: asset?.src ?? null,
      barStartSec: timing ? flicksToSeconds(timing.inPoint) : 0,
      sourceInSec: timing ? flicksToSeconds(timing.inPoint - timing.startTime) : 0,
    };
  });
}

/**
 * The angle whose opacity wins at `t` (comp seconds) — the one the comp
 * shows. From the document mirror at the THROTTLED display time: never a
 * value query per played frame.
 */
function liveAngleAt(views: ReadonlyArray<AngleView>, t: number): number | null {
  const m = documentMirror();
  let best: number | null = null;
  let bestOpacity = -1;
  for (const v of views) {
    const opacity = readTrack(m, v.id, 'opacity', t) ?? 100;
    if (opacity > bestOpacity) {
      bestOpacity = opacity;
      best = v.angle;
    }
  }
  return best;
}

/** Exported so the empty state can be asserted without opening a modal. */
export function MulticamViewerBody(): JSX.Element {
  // Which layers are angles is a legacy read over the whole document (the
  // B4-gap in collectAngleViews), so this wakes on any document revision —
  // bars moving on sync / undo, a relink, a cut — like the scene revision did.
  const docRev = useMirrorKeys(DOC_KEYS);
  const time = useCurrentTime();
  const displayTime = useThrottledTime();
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const videoRefs = useRef(new Map<string, HTMLVideoElement>());

  // `docRev` invalidates the angles and their bars.
  const views = useMemo(collectAngleViews, [docRev]);
  const angleIds = useMemo(() => views.map((v) => v.id), [views]);
  // The angles' opacity (their trees answer `readTrack`; a value fetched over
  // the pipe lands on `value:`).
  useRetainTrees(angleIds);
  const m = documentMirror();
  useMirrorKeys(angleIds.flatMap((id) => {
    const r = trackRefIn(m.tree(id), 'opacity');
    return [`tree:${id}`, ...(r ? [`value:${id}|${r.path}`] : [])];
  }));
  const live = liveAngleAt(views, displayTime);

  // Follow the playhead: seek each cell to its clip-local time, coalesced to
  // one seek per rAF — per-keystroke seeks on H.264 sources stall the tab.
  const seekRaf = useRef<number | null>(null);
  useEffect(() => {
    if (seekRaf.current !== null) return;
    seekRaf.current = requestAnimationFrame(() => {
      seekRaf.current = null;
      for (const v of views) {
        const el = videoRefs.current.get(v.id);
        if (!el || !Number.isFinite(el.duration)) continue;
        const local = Math.max(0, time - v.barStartSec + v.sourceInSec);
        if (Math.abs(el.currentTime - local) > 1 / 60) el.currentTime = Math.min(local, el.duration);
      }
    });
    return () => {
      if (seekRaf.current !== null) {
        cancelAnimationFrame(seekRaf.current);
        seekRaf.current = null;
      }
    };
  }, [time, views]);

  // Premiere-style: live angle carries audio; others stay silent.
  useEffect(() => {
    for (const v of views) {
      const el = videoRefs.current.get(v.id);
      if (!el) continue;
      el.muted = live !== v.angle;
      if (live === v.angle) {
        void el.play().catch(() => { /* autoplay policy — still seekable */ });
      } else {
        el.pause();
      }
    }
  }, [live, views, time]);

  const columns = views.length <= 4 ? 2 : 3;

  const onSync = async (): Promise<void> => {
    setSyncing(true);
    try {
      // The analysis (core, no write), then the bar shifts as ONE engine entry
      // (`setLayerTiming` through moveBars, B3z).
      const { moves, report } = await planMulticamAudioSync();
      if (moves.length > 0) await moveBars(moves, 'Sync Multicam by Audio');
      setSyncNote(report.note);
      useUIStore.getState().notify({ level: report.shifted > 0 ? 'success' : 'info', message: report.note, durationMs: 5000 });
    } finally {
      setSyncing(false);
    }
  };

  if (views.length < 2) {
    return (
      <EmptyState
        icon="video"
        title="No multicam angles"
        message="A multicam group needs at least two angles. Build one from the Library with “New Multicam from Library…”."
      />
    );
  }

  return (
    <div>
      <div className={styles.row}>
        <Button size="sm" onClick={() => void onSync()} disabled={syncing}>
          {syncing ? 'Syncing…' : 'Sync by Audio'}
        </Button>
        {syncNote && <span className={styles.syncNote}>{syncNote}</span>}
      </div>
      <div className={styles.grid} style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
        {views.map((v) => (
          <button
            key={v.id}
            type="button"
            className={cn(styles.cell, live === v.angle && styles.cellLive)}
            title={`Cut to angle ${v.angle} (Alt+${v.angle})`}
            onClick={() => switchMulticamAngle(v.angle)}
          >
            {v.src ? (
              <video
                muted={live !== v.angle}
                playsInline
                preload="auto"
                src={v.src}
                className={styles.video}
                ref={(el) => {
                  if (el) videoRefs.current.set(v.id, el);
                  else videoRefs.current.delete(v.id);
                }}
              />
            ) : (
              <div className={styles.video} />
            )}
            <span className={cn(styles.label, live === v.angle && styles.labelLive)}>
              {v.angle} · {v.name}
            </span>
          </button>
        ))}
      </div>
      <div className={styles.hint}>
        Click an angle to cut at the playhead. Alt+1…9 cuts without the viewer.
        Live angle plays audio; others stay muted.
      </div>
    </div>
  );
}

/** Open the Multicam Viewer modal (idempotent id — one viewer at a time). */
export function openMulticamViewer(): void {
  openModal({
    id: 'multicam-viewer',
    title: 'Multicam Viewer',
    size: 'lg',
    render: () => <MulticamViewerBody />,
  });
}
