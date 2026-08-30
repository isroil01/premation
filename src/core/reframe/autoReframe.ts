/**
 * Auto-reframe — retarget a composition to another aspect ratio.
 *
 * Analyse the composition once at a small size, decide where the eye goes in
 * each sampled frame, turn that into a pan the subject stays inside, and build
 * a NEW composition at the target size holding the original as a layer with
 * that pan keyframed onto it.
 *
 * ── A new composition, never an edit of the old one ────────────────────
 * The source is untouched and stays the master. That is not caution, it is what
 * makes the feature usable: a 16:9 cut retargeted to 9:16, 1:1 and 4:5 is four
 * deliverables from one edit, and every one of them has to update when the edit
 * changes. As a comp INSTANCE it does — re-cut the master and all four follow.
 * Baking the crop into the original would have produced one file and destroyed
 * the thing it came from.
 *
 * ── Why it renders the comp to look at it ──────────────────────────────
 * The alternative is reading the source footage directly, which is faster and
 * wrong: a composition is titles, graphics, effects and cuts as well as
 * footage, and a reframe that ignores the lower third can crop it off. So the
 * analysis pass is the real renderer at a small size (a 160-px-wide frame is
 * plenty for a centroid), through the same deterministic offline loop the
 * exporter uses.
 *
 * The two hard parts live next door and are pure: `saliency.ts` decides where
 * to look, `reframePath.ts` decides how the frame moves.
 */

import { writeTransformProps } from '@core/scene/transformWrite';
import { renderOffline } from '@core/export/offlineRenderer';
import { readCanvasPixels } from '@core/export/videoSink';
import { compSizeOf } from '@core/composition/compSizes';
import { createComposition } from '@core/composition/compositionOps';
import { insertCompInstance } from '@core/scene/sceneInsert';
import { cutsFromDistances, histogramDistance, lumaHistogram } from '@core/tracking/sceneEditDetect';
import { compToKeyframeTime, getTimelineController } from '@core/timeline/TimelineController';
import { runAnimEdit } from '@core/animation/animationCommands';
import { beginDocumentTransaction } from '@core/ai/aiTransaction';
import { defaultAnimation, type Keyframe } from '@motion/animation';
import { useProjectStore, type CompositionSettings } from '@stores/projectStore';
import { bumpScene } from '@stores/sceneStore';
import { analyseFrame, type AttentionPoint } from './saliency';
import { buildReframePath, coverScale, pathToKeyframes, type ReframeGeometry } from './reframePath';

/**
 * Analysis frame width. Small on purpose.
 *
 * A centroid does not get more accurate above about this: the subject is tens
 * of pixels across here, which localises it to a fraction of a percent of the
 * frame — far finer than the dead zone that follows. Every pixel above this is
 * render time and readback time spent on precision the path throws away.
 */
const ANALYSIS_WIDTH = 160;

/**
 * Analysis samples per second.
 *
 * Twelve is comfortably above the rate at which a considered camera move
 * changes direction, and a quarter to a fifth of the frames of typical footage
 * — so the pass costs a fraction of a full render. Sampling at frame rate
 * would quadruple the cost to measure a curve that is then smoothed with a
 * half-second time constant.
 */
const ANALYSIS_RATE = 12;

/** A target shape, as offered in the UI. */
export interface AspectPreset {
  id: string;
  label: string;
  /** Width : height. */
  ratio: number;
  hint: string;
}

export const ASPECT_PRESETS: readonly AspectPreset[] = [
  { id: '9:16', label: '9:16 Vertical', ratio: 9 / 16, hint: 'Reels, Shorts, TikTok, Stories' },
  { id: '1:1', label: '1:1 Square', ratio: 1, hint: 'Feed posts' },
  { id: '4:5', label: '4:5 Portrait', ratio: 4 / 5, hint: 'Instagram feed — the tallest a feed post may be' },
  { id: '16:9', label: '16:9 Widescreen', ratio: 16 / 9, hint: 'YouTube, broadcast' },
  { id: '4:3', label: '4:3 Classic', ratio: 4 / 3, hint: 'Archive and broadcast masters' },
];

/**
 * The target frame size for an aspect, sized off the source.
 *
 * The SHORTER of the source's edges is preserved, so retargeting never invents
 * resolution: a 1920×1080 master becomes 1080×1920 vertical, not 2160×3840
 * upscaled from pixels that were never there.
 */
export function targetSizeFor(
  source: { width: number; height: number },
  ratio: number,
): { width: number; height: number } {
  const shortEdge = Math.min(source.width, source.height);
  const [w, h] = ratio >= 1
    ? [Math.round(shortEdge * ratio), shortEdge]
    : [shortEdge, Math.round(shortEdge / ratio)];
  // Even dimensions: every h.264/HEVC encoder wants them, and an odd edge here
  // becomes an ffmpeg scale filter at export or a refused encode.
  return { width: w - (w % 2), height: h - (h % 2) };
}

export interface AutoReframeOptions {
  /** Composition to retarget. Defaults to the active one. */
  sourceCompId?: string;
  /** Target frame size. Use `targetSizeFor` to derive it from an aspect. */
  target: { width: number; height: number };
  /** Name for the new composition. Defaults to "<source> <W>×<H>". */
  name?: string;
  /** How lazily the frame follows. See `PathOptions`. */
  deadZone?: number;
  lagSeconds?: number;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export interface AutoReframeResult {
  /** The new composition's id. */
  compId: string;
  /** The comp-instance layer inside it. */
  nodeId: string;
  /** Frames analysed. */
  samples: number;
  /** Shot changes found — the frame jumps at each. */
  cuts: number;
  /** Keyframes written across both axes. */
  keyframes: number;
}

export class AutoReframeError extends Error {}

/** Everything the analysis pass learns about the source. */
interface Analysis {
  points: AttentionPoint[];
  /** Sample indices that begin a shot. */
  cuts: number[];
}

/**
 * Render the composition small and look at every sampled frame.
 *
 * Holds one previous luma plane and one previous histogram, never a frame
 * buffer — the same discipline `walkSceneEdits` keeps, for the same reason: an
 * hour of footage must not grow memory.
 */
async function analyseComposition(
  comp: CompositionSettings,
  durationSec: number,
  onProgress: ((f: number) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<Analysis> {
  const width = Math.max(16, Math.round(ANALYSIS_WIDTH));
  const height = Math.max(16, Math.round((width * comp.height) / comp.width));
  const totalFrames = Math.max(1, Math.round(durationSec * ANALYSIS_RATE));

  const points: AttentionPoint[] = [];
  const distances: number[] = [];
  let previousLuma: Float32Array | null = null;
  let previousHistogram: Float32Array | null = null;

  await renderOffline(
    {
      width,
      height,
      fps: ANALYSIS_RATE,
      durationSec,
      comp: {
        width: comp.width,
        height: comp.height,
        background: comp.background,
        transparent: comp.transparent,
        rootId: comp.id,
        compSizeOf,
      },
    },
    (canvas, frame) => {
      const pixels = readCanvasPixels(canvas);
      if (!pixels) return;
      const { point, luma } = analyseFrame(pixels.data, previousLuma, width, height);
      points.push(point);

      // Cut detection rides the SAME pass. Rendering twice to ask two questions
      // about the same frames would double the only expensive part of this.
      const histogram = lumaHistogram({ data: luma, width, height });
      if (previousHistogram) distances.push(histogramDistance(previousHistogram, histogram));
      previousHistogram = histogram;
      previousLuma = luma;

      onProgress?.((frame + 1) / totalFrames);
    },
    signal,
  );

  // `cutsFromDistances` indexes the DISTANCE array, whose entry i compares
  // samples i and i+1 — so a cut there begins at sample i+1.
  const cuts = cutsFromDistances(distances).map((i) => i + 1);
  return { points, cuts };
}

/** Write the pan onto the comp-instance layer, as one undo entry. */
function writePanKeyframes(
  nodeId: string,
  path: { x: number[]; y: number[] },
  cuts: readonly number[],
  centre: { x: number; y: number },
): number {
  const toKeyframes = (values: number[], offset: number): Keyframe[] =>
    pathToKeyframes(values, cuts, ANALYSIS_RATE).map((k) => ({
      t: compToKeyframeTime(nodeId, k.t),
      value: offset + k.value,
      easing: k.easing,
    }));

  const xKfs = toKeyframes(path.x, centre.x);
  const yKfs = toKeyframes(path.y, centre.y);
  if (xKfs.length === 0) return 0;

  runAnimEdit('Auto-reframe', () => {
    defaultAnimation.batch(() => {
      // Written wholesale, not spliced: this layer was created moments ago by
      // this very operation and has no prior animation to preserve.
      defaultAnimation.setKeyframes(nodeId, 'x', xKfs);
      defaultAnimation.setKeyframes(nodeId, 'y', yKfs);
    });
  });
  return xKfs.length + yKfs.length;
}

/**
 * Retarget a composition to `target`, and open the result.
 *
 * Throws with a message meant for a toast: every failure here is something the
 * user can act on (pick a different comp, wait for the render, choose a
 * different aspect).
 */
export async function autoReframeComposition(options: AutoReframeOptions): Promise<AutoReframeResult> {
  const project = useProjectStore.getState();
  const sourceId = options.sourceCompId
    ?? (project.activeTabId ? project.tabs[project.activeTabId]?.compositionId : undefined);
  const source = sourceId ? project.comps[sourceId] : undefined;
  if (!source || !sourceId) throw new AutoReframeError('There is no composition to reframe.');

  const geometry: ReframeGeometry = {
    sourceWidth: source.width,
    sourceHeight: source.height,
    targetWidth: options.target.width,
    targetHeight: options.target.height,
  };
  if (geometry.targetWidth < 2 || geometry.targetHeight < 2) {
    throw new AutoReframeError('That target size is too small to render.');
  }

  const duration = Math.max(1 / ANALYSIS_RATE, source.durationSeconds);
  const analysis = await analyseComposition(source, duration, options.onProgress, options.signal);
  if (analysis.points.length === 0) {
    throw new AutoReframeError('Nothing could be analysed — the composition rendered no frames.');
  }

  const path = buildReframePath(analysis.points, analysis.cuts, geometry, {
    sampleRate: ANALYSIS_RATE,
    ...(options.deadZone !== undefined ? { deadZone: options.deadZone } : {}),
    ...(options.lagSeconds !== undefined ? { lagSeconds: options.lagSeconds } : {}),
  });

  // Everything from here mutates the document, and it is one action.
  const transaction = beginDocumentTransaction('Auto-reframe');
  try {
    const compId = createComposition({
      name: options.name ?? `${source.name} ${options.target.width}×${options.target.height}`,
      width: options.target.width,
      height: options.target.height,
      fps: source.fps,
      durationSeconds: source.durationSeconds,
      background: source.background,
      transparent: source.transparent,
      startFrame: source.startFrame,
    });

    // `createComposition` opened the new comp, so this lands inside it.
    const nodeId = insertCompInstance(sourceId);
    if (!nodeId) throw new AutoReframeError('The source composition could not be placed in the new one.');

    // Through the router, never `writeProp`: scale is an animatable property,
    // and the renderer reads animated values first — a raw write to a layer
    // that later carries a scale track is silently discarded. See
    // `transformWrite.ts` and the guard suite that enforces it.
    //
    // Static rather than keyframed: the crop's zoom is fixed by the two aspects,
    // and an animated scale would be a Ken Burns move nobody asked for.
    const scale = coverScale(geometry);
    writeTransformProps(
      nodeId,
      [{ prop: 'scaleX', value: scale }, { prop: 'scaleY', value: scale }],
      'Auto-reframe',
    );

    getTimelineController().syncFromScene(compId);
    const keyframes = writePanKeyframes(nodeId, path, analysis.cuts, {
      x: options.target.width / 2,
      y: options.target.height / 2,
    });

    bumpScene();
    transaction.commit();

    return {
      compId,
      nodeId,
      samples: analysis.points.length,
      cuts: analysis.cuts.length,
      keyframes,
    };
  } catch (err) {
    transaction.rollback();
    throw err;
  }
}
