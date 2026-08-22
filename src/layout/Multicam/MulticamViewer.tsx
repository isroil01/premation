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
import { useWorkspaceStore } from '@stores/projectStore';
import { useAssetStore } from '@stores/assetStore';
import { useSceneRevision } from '@stores/sceneStore';
import { useUIStore } from '@stores/uiStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { framesToSeconds } from '@motion/timeline';
import { assetIdOf } from '@core/source/sourceInfo';
import { compToKeyframeTime, getTimelineController } from '@core/timeline/TimelineController';
import {
  alignMulticamByAudio,
  multicamLayersInActiveComp,
  switchMulticamAngle,
} from '@core/composition/multicam';
import { Button } from '@components/Button';
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

function collectAngleViews(): AngleView[] {
  const controller = getTimelineController();
  const fr = controller.timeline.getFrameRate();
  const assets = useAssetStore.getState().assets;
  return multicamLayersInActiveComp().map((l) => {
    const node = defaultSceneGraph.getNode(l.id);
    const assetId = node ? assetIdOf(node) : null;
    const asset = assetId ? assets.find((a) => a.id === assetId) : null;
    const bar = controller.getLayersForNode(l.id)[0];
    return {
      id: l.id,
      angle: l.angle,
      name: l.name,
      src: asset?.src ?? null,
      barStartSec: bar ? framesToSeconds(bar.start, fr) : 0,
      sourceInSec: bar ? framesToSeconds(bar.clip.sourceIn, fr) : 0,
    };
  });
}

/** The angle whose sampled opacity wins at `t` — the one the comp shows. */
function liveAngleAt(views: ReadonlyArray<AngleView>, t: number): number | null {
  let best: number | null = null;
  let bestOpacity = -1;
  for (const v of views) {
    const sampled = defaultAnimation.sample(v.id, 'opacity', compToKeyframeTime(v.id, t));
    const node = defaultSceneGraph.getNode(v.id);
    const styleProps = node?.components.find((c) => c.type === 'Style')?.props as
      | Record<string, unknown>
      | undefined;
    const base = typeof styleProps?.opacity === 'number' ? styleProps.opacity : 100;
    const opacity = typeof sampled === 'number' ? sampled : base;
    if (opacity > bestOpacity) {
      bestOpacity = opacity;
      best = v.angle;
    }
  }
  return best;
}

function MulticamViewerBody(): JSX.Element {
  const sceneRev = useSceneRevision((s) => s.rev);
  const time = useWorkspaceStore((s) => (s.activeTabId ? s.tabs[s.activeTabId]?.time ?? 0 : 0));
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const videoRefs = useRef(new Map<string, HTMLVideoElement>());

  // Bars move on sync/undo (scene revision covers relink; time drives seeks).
  // eslint-disable-next-line react-hooks/exhaustive-deps -- sceneRev invalidates bar geometry
  const views = useMemo(collectAngleViews, [sceneRev]);
  const live = liveAngleAt(views, time);

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
      const report = await alignMulticamByAudio();
      setSyncNote(report.note);
      useUIStore.getState().notify({ level: report.shifted > 0 ? 'success' : 'info', message: report.note, durationMs: 5000 });
    } finally {
      setSyncing(false);
    }
  };

  if (views.length < 2) {
    return <div className={styles.hint}>This composition has no multicam angles. Create one via “New Multicam from Library…”.</div>;
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
