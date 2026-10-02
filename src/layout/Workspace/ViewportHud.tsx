/**
 * The in-viewport HUD (View ▸ Viewport HUD, `Ctrl+Alt+H`).
 *
 * A few numbers, in the corner of the stage, that answer "why does this feel
 * slow": the rate frames reach the viewport, how long a frame costs the engine
 * — split into its BUILD (document → frame scene, on the engine's core thread)
 * and its GPU time (render to completion) — how many frames the clock had to
 * skip, how much the engine's frame cache holds, what resolution the viewport
 * is actually rendering at (which is NOT always the one you picked — adaptive
 * resolution moves it), and whether adaptive is currently degrading.
 *
 * The picture is the C++ engine's, so these are the engine's own counters:
 * `viewportHudStats` is fed by EngineSurface per drawn frame, and the build /
 * GPU split, the drops and the cache size arrive once a second in the engine's
 * `renderStatsUpdated` event.
 *
 * ## Why it does not re-render sixty times a second
 *
 * The surface reports into `viewportHudStats`, a plain module object, and this
 * samples it on a 250ms timer. Nothing about the HUD is in the frame path: a
 * frame does not touch React, and turning the HUD off costs one
 * `clearInterval` and one unsubscribe.
 *
 * `FpsMeter` in the status bar is the same idea for the DISPLAY's rate and is
 * left alone — this reads the engine's counters instead, which is the number
 * that moves when a comp gets heavy.
 */

import { useEffect, useRef, useState } from 'react';
import type { EventBatch, RenderStats } from '@motion/engine-api';
import { subscribeEngine } from '@core/engine/engineInstance';
import {
  useViewportDisplayStore,
  viewportHudStats,
  type HudSample,
} from '@stores/viewportDisplayStore';
import {
  useRenderQualityStore,
  effectiveResolutionOf,
  RESOLUTION_LABELS,
} from '@stores/renderQualityStore';
import styles from './ViewportHud.module.css';

/** Sampling period. Fast enough to feel live, slow enough to be readable. */
const SAMPLE_MS = 250;

/** Above this, a frame is the reason the viewport is not at 60. */
const SLOW_FRAME_MS = 16.7;

const ms = (v: number): string => (v >= 10 ? v.toFixed(0) : v.toFixed(1));
const mb = (bytes: number): string => {
  const v = bytes / (1024 * 1024);
  return v >= 100 ? v.toFixed(0) : v.toFixed(1);
};

export function ViewportHud(): JSX.Element | null {
  const on = useViewportDisplayStore((s) => s.hud);
  const [sample, setSample] = useState<HudSample>(() => viewportHudStats.sample());
  const [engineStats, setEngineStats] = useState<RenderStats | null>(null);
  // The engine's once-a-second stats, kept in a ref and shown on the sampling tick.
  const latestStats = useRef<RenderStats | null>(null);

  const quality = useRenderQualityStore((s) => s);

  useEffect(() => {
    if (!on) return;
    const off = subscribeEngine((batch: EventBatch) => {
      for (const e of batch.events) {
        if (e.type === 'renderStatsUpdated') latestStats.current = e.stats;
      }
    });
    const id = setInterval(() => {
      setSample(viewportHudStats.sample());
      setEngineStats(latestStats.current);
    }, SAMPLE_MS);
    return () => {
      off();
      clearInterval(id);
    };
  }, [on]);

  if (!on) return null;

  const effective = effectiveResolutionOf(quality);
  const degrading = effective !== quality.resolution;

  return (
    <div className={styles.hud} data-viewport-hud="" aria-hidden="true">
      <span className={styles.key}>fps</span>
      <span className={styles.value}>{sample.fps}</span>

      <span className={styles.key}>frame</span>
      <span className={`${styles.value} ${sample.frameMs > SLOW_FRAME_MS ? styles.warn : ''}`}>
        {sample.frameMs.toFixed(1)} ms
      </span>

      {/* Where the frame goes: the engine's build (CPU) and its render (GPU). */}
      <span className={styles.key}>build</span>
      <span className={`${styles.value} ${engineStats && engineStats.cpuFrameMs > SLOW_FRAME_MS ? styles.warn : ''}`}>
        {engineStats ? `${ms(engineStats.cpuFrameMs)} ms` : '—'}
      </span>

      <span className={styles.key}>gpu time</span>
      <span className={`${styles.value} ${engineStats && engineStats.gpuFrameMs > SLOW_FRAME_MS ? styles.warn : ''}`}>
        {engineStats ? `${ms(engineStats.gpuFrameMs)} ms` : '—'}
      </span>

      <span className={styles.key}>dropped</span>
      <span className={`${styles.value} ${engineStats && engineStats.droppedFrames > 0 ? styles.warn : ''}`}>
        {engineStats ? engineStats.droppedFrames : '—'}
      </span>

      <span className={styles.key}>cache</span>
      <span className={styles.value}>
        {engineStats && engineStats.ramCacheBytes > 0 ? `${mb(engineStats.ramCacheBytes)} MB` : '—'}
      </span>

      <span className={styles.key}>res</span>
      <span className={`${styles.value} ${degrading ? styles.warn : ''}`}>
        {RESOLUTION_LABELS[effective]}
      </span>

      <span className={styles.key}>adaptive</span>
      <span className={styles.value}>
        {!quality.adaptive ? 'off' : degrading ? `→ ${RESOLUTION_LABELS[quality.adaptiveFloor]}` : 'ready'}
      </span>

      <span className={styles.key}>gpu</span>
      <span className={styles.value}>C++ engine (Dawn)</span>
    </div>
  );
}
