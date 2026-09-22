/**
 * The in-viewport HUD (View ▸ Viewport HUD, `Ctrl+Alt+H`).
 *
 * Seven numbers, in the corner of the stage, that answer "why does this feel
 * slow": the display rate, how long a real render takes, how much of that
 * rate is the RAM preview rather than the renderer, what resolution the
 * viewport is actually rendering at (which is NOT always the one you picked —
 * adaptive resolution moves it), whether adaptive is currently degrading, and
 * which GPU backend came up.
 *
 * Expanded (the `stages` row), it answers the next question — WHERE the frame
 * goes: rolling mean and p95 per render stage from `core/perf/framePerf`
 * (snapshot, flatten, texture feed, raster, CPU bake, GPU submit, cache
 * readback), plus how many rasters and bakes a frame pays and, on WebGPU, how
 * long the GPU takes to finish after submit. Two more rows come from the GPU
 * side: `gpu time`, the GPU's own time for a frame's passes (WebGPU timestamp
 * queries; lags the CPU rows by a frame or three, see framePerf's notes), and
 * `vram`, the renderer's estimate of the GPU memory it holds, with its peak.
 *
 * ## Why it does not re-render sixty times a second
 *
 * The render loop reports into `viewportHudStats` and `framePerf`, plain module
 * objects, and this samples them on a 250ms timer. Nothing about the HUD is in
 * the render path: a frame does not touch React, and turning the HUD off costs
 * one `clearInterval`.
 *
 * `FpsMeter` in the status bar is the same idea for the DISPLAY's rate and is
 * left alone — this reads the renderer's own counters instead, which is the
 * number that moves when a comp gets heavy.
 */

import { useEffect, useState } from 'react';
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
import { useRenderBackendStore, type ActiveRenderTier } from '@stores/renderBackendStore';
import { cpuBakeStats, type CpuBakeSample } from '@core/effects/effectBake';
import { framePerf, type PerfSample, type PerfStageName } from '@core/perf/framePerf';
import styles from './ViewportHud.module.css';

/** Sampling period. Fast enough to feel live, slow enough to be readable. */
const SAMPLE_MS = 250;

/** Above this, a render is the reason the viewport is not at 60. */
const SLOW_FRAME_MS = 16.7;

const BACKEND_LABEL: Record<ActiveRenderTier, string> = {
  pending: 'starting…',
  webgpu: 'WebGPU',
  webgl2: 'WebGL2',
  null: 'none',
  software: 'software',
};

/** The expanded rows, in pipeline order. `total` is the collapsed `frame` row. */
const STAGE_ROWS: ReadonlyArray<{ stage: PerfStageName; label: string; counted?: boolean }> = [
  { stage: 'snapshot', label: 'snapshot' },
  { stage: 'flatten', label: 'flatten' },
  { stage: 'textureFeed', label: 'tex feed' },
  { stage: 'raster', label: 'raster', counted: true },
  { stage: 'bake', label: 'cpu bake', counted: true },
  { stage: 'gpuSubmit', label: 'gpu submit' },
  { stage: 'cacheReadback', label: 'cache copy' },
];

const ms = (v: number): string => (v >= 10 ? v.toFixed(0) : v.toFixed(1));
const mb = (bytes: number): string => {
  const v = bytes / (1024 * 1024);
  return v >= 100 ? v.toFixed(0) : v.toFixed(1);
};

export function ViewportHud(): JSX.Element | null {
  const on = useViewportDisplayStore((s) => s.hud);
  const expanded = useViewportDisplayStore((s) => s.hudStages);
  const toggleStages = useViewportDisplayStore((s) => s.toggleHudStages);
  const [sample, setSample] = useState<HudSample>(() => viewportHudStats.sample());
  const [bake, setBake] = useState<CpuBakeSample>(() => cpuBakeStats.sample());
  const [perf, setPerf] = useState<PerfSample | null>(null);

  const quality = useRenderQualityStore((s) => s);
  const tier = useRenderBackendStore((s) => s.activeTier);

  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => {
      setSample(viewportHudStats.sample());
      setBake(cpuBakeStats.sample());
      // The stage sort only runs while someone is looking at the stages.
      if (expanded) setPerf(framePerf.sample());
    }, SAMPLE_MS);
    return () => clearInterval(id);
  }, [on, expanded]);

  if (!on) return null;

  const effective = effectiveResolutionOf(quality);
  const degrading = effective !== quality.resolution;
  const total = sample.cacheHits + sample.cacheMisses;
  const hitPct = total > 0 ? Math.round((sample.cacheHits / total) * 100) : 0;

  return (
    <div className={styles.hud} data-viewport-hud="" aria-hidden="true">
      <span className={styles.key}>fps</span>
      <span className={styles.value}>{sample.fps}</span>

      <span className={styles.key}>frame</span>
      <span className={`${styles.value} ${sample.frameMs > SLOW_FRAME_MS ? styles.warn : ''}`}>
        {sample.frameMs.toFixed(1)} ms
      </span>

      <span className={styles.key}>cache</span>
      <span className={styles.value}>
        {hitPct}% · {sample.cacheHits}/{total}
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
      <span className={styles.value}>{BACKEND_LABEL[tier]}</span>

      {/* Layers whose effect chain ran on the CPU this frame, and the effects
          that forced it — the number behind "playback is slow with effects". */}
      <span className={styles.key}>cpu fx</span>
      <span className={`${styles.value} ${bake.bakedLayers > 0 ? styles.warn : ''}`}>
        {bake.bakedLayers === 0
          ? 'none'
          : `${bake.bakedLayers} layer${bake.bakedLayers === 1 ? '' : 's'}${bake.forcedBy.length > 0 ? ` · ${bake.forcedBy.slice(0, 3).map((f) => f.type).join(', ')}` : ''}`}
      </span>

      {/* The one interactive element in the HUD: everything else stays
          pointer-transparent so the readout never eats a click on the layer
          behind it. */}
      <button
        type="button"
        className={styles.toggle}
        onClick={toggleStages}
        aria-expanded={expanded}
        title={expanded ? 'Hide per-stage timings' : 'Show per-stage timings (mean / p95 ms per frame)'}
      >
        {expanded ? '▾' : '▸'} stages
      </button>

      {expanded && (
        <>
          <span className={styles.key}>ms/frame</span>
          <span className={styles.value}>mean · p95</span>
          {STAGE_ROWS.map(({ stage, label, counted }) => {
            const s = perf?.stages[stage];
            return [
              <span key={`${stage}-k`} className={styles.key}>{label}</span>,
              <span key={`${stage}-v`} className={`${styles.value} ${s && s.p95 > SLOW_FRAME_MS ? styles.warn : ''}`}>
                {s ? `${ms(s.mean)} · ${ms(s.p95)}${counted ? ` ×${s.perFrame.toFixed(1)}` : ''}` : '—'}
              </span>,
            ];
          })}
          <span className={styles.key}>gpu done</span>
          <span className={styles.value}>{perf?.gpuDoneMs != null ? `${ms(perf.gpuDoneMs)} ms` : 'n/a'}</span>
          {/* GPU-side time, from timestamp queries. Frames without a readback
              hold 0 with a run count of 0, so mean ÷ perFrame is the mean over
              MEASURED frames; no measured frame in the window → n/a, not 0. */}
          {(() => {
            const g = perf?.stages.gpuTime;
            const measured = g && g.perFrame > 0;
            const meanMeasured = measured ? g.mean / g.perFrame : 0;
            return [
              <span key="gpuTime-k" className={styles.key}>gpu time</span>,
              <span key="gpuTime-v" className={`${styles.value} ${measured && g.p95 > SLOW_FRAME_MS ? styles.warn : ''}`}>
                {measured ? `${ms(meanMeasured)} · ${ms(g.p95)}` : 'n/a'}
              </span>,
            ];
          })()}
          <span className={styles.key}>vram</span>
          <span className={styles.value}>
            {perf?.gpuBytes != null && perf.gpuBytesPeak != null
              ? `${mb(perf.gpuBytes)} MB · pk ${mb(perf.gpuBytesPeak)}`
              : 'n/a'}
          </span>
        </>
      )}
    </div>
  );
}
