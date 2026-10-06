/**
 * The user-facing side of one-click tracking: one action, two call sites.
 *
 * The viewport calls it when the armed crosshair is clicked; the panel calls
 * it when "Track again" is pressed. Keeping the flow here rather than in
 * either component is what stops the two from drifting into subtly different
 * behaviour — the case that matters is cancellation, where a half-finished
 * walk left in the store looks exactly like a finished one.
 *
 * The walk is the engine's `trackMotion` job (C++ engine; the page tracker
 * that ran on the TypeScript engine is gone — docs/TS_ENGINE_REMOVAL.md
 * phase 4) with `autoFeature` (AE parity 3.6): the engine picks the feature
 * nearest the click (Shi-Tomasi strength × distinctness), sizes both windows
 * from its measured motion, adds a companion feature for rotation / scale,
 * and tracks OUTWARD from the playhead in both directions. No React.
 */

import { flicksToSeconds, secondsToFlicks } from '@motion/engine-api';
import { useProjectStore } from '@stores/projectStore';
import { pointCountFor, useTrackerStore, type AutoPlanSummary } from '@stores/trackerStore';
import { engine } from '@core/engine/engineInstance';
import { requireEngineJob, startEngineJob } from '@core/engine/engineJobs';
import { documentMirror } from '@stores/documentMirror';
import { settingsFps } from '@core/mirror/compFacts';

export interface AutoTrackCommandOptions {
  nodeId: string;
  /** Where the user clicked, in source display px. Omit for the frame centre. */
  hint?: { x: number; y: number };
  /** Half-size of the marquee the user drew around the object, in source
   *  display px — the feature window. Omit for a plain click. */
  radius?: number;
}

/** Enough of a track to be worth applying — two samples is a line, one is a
 *  point, and a "track" of one keyframe animates nothing. */
const MIN_USEFUL_SAMPLES = 2;

/** One compact sample as the engine's trackMotion summary carries it. */
type EngineSample = [number, number, number, number, number];

interface TrackSummary {
  status: 'completed' | 'lost' | 'partial';
  sourceWidth: number;
  sourceHeight: number;
  tracks: EngineSample[][];
  /** autoFeature's measurements (source display px). */
  plan?: {
    x: number; y: number; featureHalf: number; searchHalf: number;
    motionPerFrame: number | null; strength: number; distinctness: number;
    companion: { x: number; y: number } | null;
  };
}

/**
 * Track in one action, writing the outcome into the tracker store. Never
 * throws: every failure ends as a sentence in `note`, because this runs from a
 * click on a canvas and there is nobody upstream to catch.
 */
export async function runAutoTrack(opts: AutoTrackCommandOptions): Promise<void> {
  const store = useTrackerStore;
  if (store.getState().tracking) return;

  const own = documentMirror().layer(opts.nodeId);
  const fps = settingsFps(own ? documentMirror().comp(own.comp)?.settings : undefined);
  const time = useProjectStore.getState().activeTabId
    ? useProjectStore.getState().tabs[useProjectStore.getState().activeTabId!]?.time ?? 0
    : 0;

  store.getState().setAutoPlan(null);
  store.getState().setAutoPhase('analyzing');
  store.getState().beginTracking();
  try {
    let point = opts.hint;
    if (!point) {
      const size = await engine().query({ type: 'getSourceSize', layers: [opts.nodeId] });
      const s = size.ok ? size.value.sizes[0] : undefined;
      point = { x: (s?.width ?? 0) / 2, y: (s?.height ?? 0) / 2 };
    }
    // A marquee's half-size bounds where the engine looks; a click searches
    // its default neighbourhood. The windows come back measured.
    const radius = opts.radius !== undefined ? Math.max(8, Math.round(opts.radius)) : 0;
    // The whole layer, tracked outward from the playhead.
    const layer = documentMirror().layer(opts.nodeId);
    const layerEnd = layer ? flicksToSeconds(layer.timing.outPoint) : time + 10;
    const start = layer ? Math.max(0, flicksToSeconds(layer.timing.inPoint)) : 0;
    let cancel: (() => void) | null = null;
    const handle = requireEngineJob(await startEngineJob<TrackSummary>(
      {
        kind: 'trackMotion',
        value: {
          layer: opts.nodeId,
          kind: 'position',
          points: [{
            feature: { x: point.x, y: point.y, width: radius > 0 ? 2 * radius + 1 : 0, height: radius > 0 ? 2 * radius + 1 : 0 },
            search: { x: point.x, y: point.y, width: 0, height: 0 },
            attach: { x: 0, y: 0 },
          }],
          autoFeature: true,
          excludeMasks: [],
          range: { start: secondsToFlicks(start), duration: secondsToFlicks(Math.max(1 / fps, layerEnd - start)) },
          direction: 'both',
          origin: secondsToFlicks(time),
          stabilize: false,
        },
      },
      {
        onProgress: (f) => {
          store.getState().setProgress(f);
          // The store's `tracking` flag is the cancel channel.
          if (!store.getState().tracking) cancel?.();
        },
      },
    ), 'Tracking');
    cancel = handle.cancel;
    const out = await handle.done;
    const res = out.result;
    if (out.status !== 'done' || !res) {
      store.getState().finishTracking(null, out.error?.message ?? 'Tracking was cancelled.');
      if (opts.hint && out.status === 'failed') store.getState().setAutoPhase('picking');
      return;
    }
    const tracks = res.tracks.map((t) => t.map(([compTime, x, y, confidence, coasted]) => ({ compTime, x, y, confidence, coasted: coasted === 1 })));
    const measured = res.plan;
    const featureHalf = Math.max(3, Math.round(measured?.featureHalf ?? store.getState().featureHalf));
    const searchHalf = Math.max(featureHalf + 4, Math.round(measured?.searchHalf ?? featureHalf * 2.4));
    const plan: AutoPlanSummary = measured
      ? { x: measured.x, y: measured.y, featureHalf, searchHalf, motionPerFrame: measured.motionPerFrame, strength: measured.strength, distinctness: measured.distinctness }
      : { x: point.x, y: point.y, featureHalf, searchHalf, motionPerFrame: null, strength: null, distinctness: null };
    store.getState().setAutoPlan(plan);
    // One click produces ONE feature, so the panel has to be in a one-point mode.
    if (pointCountFor(store.getState().mode) !== 1) {
      store.getState().setMode('follow', res.sourceWidth, res.sourceHeight);
    }
    store.getState().setPoint(0, plan.x, plan.y);
    store.getState().setSizes(featureHalf, searchHalf);

    const primary = tracks[0] ?? [];
    if (primary.length < MIN_USEFUL_SAMPLES) {
      store.getState().finishTracking(null, 'The feature was lost immediately — try a steadier detail.');
      if (opts.hint) store.getState().setAutoPhase('picking');
      return;
    }
    const status = res.status === 'completed' ? 'completed' : 'lost';
    const coasted = primary.reduce((n, s) => n + (s.coasted ? 1 : 0), 0);
    store.getState().finishTracking(
      { tracks: tracks.filter((t) => t.length >= MIN_USEFUL_SAMPLES), sourceWidth: res.sourceWidth, sourceHeight: res.sourceHeight, status },
      `${status === 'completed' ? `Tracked ${primary.length} frames` : `Lost part-way — kept ${primary.length} frames`}.`
        + (coasted > 0 ? ` · ${coasted} predicted through occlusion` : ''),
    );
  } catch (e) {
    store.getState().finishTracking(null, e instanceof Error ? e.message : String(e));
  }
}
