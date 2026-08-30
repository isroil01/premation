/**
 * The user-facing side of one-click tracking: one action, two call sites.
 *
 * The viewport calls it when the armed crosshair is clicked; the panel calls
 * it when "Track again" is pressed. Keeping the flow here rather than in
 * either component is what stops the two from drifting into subtly different
 * behaviour — the case that matters is cancellation, where a half-finished
 * walk left in the store looks exactly like a finished one.
 *
 * Everything it touches is a store or `autoTrackVideoLayer`. No React.
 */

import { useCompositionStore } from '@stores/compositionStore';
import { useProjectStore } from '@stores/projectStore';
import { pointCountFor, useTrackerStore, type AutoPlanSummary } from '@stores/trackerStore';
import { autoTrackVideoLayer, type CompTrackSample } from './trackVideoLayer';

export interface AutoTrackCommandOptions {
  nodeId: string;
  /** Where the user clicked, in source display px. Omit for the frame centre. */
  hint?: { x: number; y: number };
}

/** Enough of a track to be worth applying — two samples is a line, one is a
 *  point, and a "track" of one keyframe animates nothing. */
const MIN_USEFUL_SAMPLES = 2;

/**
 * Pick, plan and track in one action, writing the outcome into the tracker
 * store. Never throws: every failure ends as a sentence in `note`, because
 * this runs from a click on a canvas and there is nobody upstream to catch.
 */
export async function runAutoTrack(opts: AutoTrackCommandOptions): Promise<void> {
  const store = useTrackerStore;
  if (store.getState().tracking) return;

  const fps = useCompositionStore.getState().fps || 30;
  const time = useProjectStore.getState().activeTabId
    ? useProjectStore.getState().tabs[useProjectStore.getState().activeTabId!]?.time ?? 0
    : 0;

  store.getState().setAutoPlan(null);
  store.getState().setAutoPhase('analyzing');
  store.getState().beginTracking();
  try {
    const out = await autoTrackVideoLayer({
      nodeId: opts.nodeId,
      anchorCompTime: time,
      fps,
      ...(opts.hint ? { hint: opts.hint } : {}),
      onProgress: (f) => {
        store.getState().setProgress(f);
        // The store's `tracking` flag is the cancel channel — clearing it
        // (Cancel, or switching layer) stops the walk at the next frame.
        return store.getState().tracking;
      },
    });

    if (!out) {
      store.getState().finishTracking(
        null,
        'Nothing trackable there — that patch has no corner to lock onto. Try a hard edge, a marker, or a high-contrast detail.',
      );
      return;
    }

    const plan: AutoPlanSummary = out.plan;
    store.getState().setAutoPlan(plan);
    // One click produces ONE feature, so the panel has to be in a one-point
    // mode for the result to mean anything — a four-corner planar pin cannot
    // be applied from a single track. Switching is the honest move; leaving
    // the mode alone would show a result the Apply button could not use.
    if (pointCountFor(store.getState().mode) !== 1) {
      store.getState().setMode('follow', out.sourceWidth, out.sourceHeight);
    }
    // The chosen feature becomes the visible track point, so the manual
    // controls below carry on from exactly where the analysis landed.
    store.getState().setPoint(0, plan.x, plan.y);
    store.getState().setSizes(Math.round(plan.featureHalf), Math.round(plan.searchHalf));

    const primary = out.tracks[0] ?? [];
    if (primary.length < MIN_USEFUL_SAMPLES) {
      store.getState().finishTracking(null, 'The feature was lost immediately — try a steadier detail.');
      return;
    }

    store.getState().finishTracking(
      {
        // Every surviving track, so the panel can offer rotation and scale
        // when a companion made it through the walk.
        tracks: out.tracks.filter((t) => t.length >= MIN_USEFUL_SAMPLES),
        sourceWidth: out.sourceWidth,
        sourceHeight: out.sourceHeight,
        // The store speaks the three-state vocabulary the manual path uses;
        // 'partial' is a track that stopped early, which is 'lost'.
        status: out.status === 'partial' ? 'lost' : out.status,
      },
      summarize(primary, out.status, plan, out.tracks.length > 1),
    );
  } catch (e) {
    store.getState().finishTracking(null, e instanceof Error ? e.message : String(e));
  }
}

/**
 * The one line the user reads after a run.
 *
 * It names the measurements rather than just the outcome, because "tracked
 * 180 frames" and "tracked 180 frames, 12 of them guessed" call for different
 * decisions, and only one of them is visible in the result curve.
 */
function summarize(
  samples: readonly CompTrackSample[],
  status: 'completed' | 'partial' | 'cancelled',
  plan: AutoPlanSummary,
  hasCompanion: boolean,
): string {
  const frames = samples.length;
  const outcome =
    status === 'completed'
      ? `Tracked ${frames} frames`
      : status === 'cancelled'
        ? `Cancelled — kept ${frames} frames`
        : `Lost part-way — kept ${frames} frames`;
  const motion = plan.motionPerFrame === null ? '' : `, ${plan.motionPerFrame.toFixed(1)} px/frame`;
  // Coasted frames are PREDICTED, not measured — an occlusion the tracker
  // rode through. They are drawn in amber on the canvas, and saying how many
  // there are is the difference between trusting the curve and checking it.
  const coasted = samples.reduce((n, s) => n + (s.coasted ? 1 : 0), 0);
  const guessed = coasted > 0 ? ` · ${coasted} predicted through occlusion` : '';
  const warning = plan.distinctness < 0.5 ? ' · look-alikes nearby, check the path' : '';
  const rotation = hasCompanion ? ' · rotation & scale available' : '';
  return `${outcome}${motion}.${guessed}${warning}${rotation}`;
}
