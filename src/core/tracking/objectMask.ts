/**
 * Object mask — one gesture on the footage becomes a mask path.
 *
 * The viewport hands this a CLICK (a point prompt) or a drawn BOX (a box
 * prompt) in source display px; this decodes the REAL frame under the
 * playhead through the exact decoder, segments it (the bundled SAM pipeline
 * when it is registered, classical GrabCut otherwise — `segmentSam` decides),
 * traces the matte to a contour, and writes it as a mask path on the layer.
 *
 * Why a `none`-mode path: the produced mask exists to be GEOMETRY — the spine
 * for Track mask and for path-following effects (Write-on / Vegas via their
 * `pathMaskId` param) — not to cut the layer. `none` is precisely "a path in
 * the stack that clips nothing" (see mask.ts), so drawing a box around a
 * wheel does not also punch the rest of the frame out. Flipping it to `add`
 * afterwards is one click in the mask list for anyone who DOES want the cut.
 *
 * This replaces the placeholder Segment action, which ran GrabCut on a
 * SYNTHETIC blob frame — path wiring demonstrated, footage never consulted.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useCompositionStore } from '@stores/compositionStore';
import { useProjectStore } from '@stores/projectStore';
import { useTrackerStore } from '@stores/trackerStore';
import { bumpScene } from '@stores/sceneStore';
import { readGeometry } from '@core/workspace/geometry';
import { addMaskPath, type MaskPath } from '@core/effects/mask';
import { segmentSam } from './samSegment';
import { matteToPath } from './rotoMatte';
import { sourceDisplaySize } from './trackerSource';
import { loadExactSource, mediaTimeAt } from './rotoBrush';
import { runEngineJob } from '@core/engine/engineJobs';
import { secondsToFlicks } from '@motion/engine-api';

export interface ObjectMaskRequest {
  nodeId: string;
  /** Playhead, comp seconds — the frame the person is looking at. */
  compTime: number;
  fps: number;
  /** Click prompt, source display px. */
  point?: { x: number; y: number };
  /** Marquee prompt, source display px. Wins over `point` when both arrive. */
  box?: { x0: number; y0: number; x1: number; y1: number };
}

export interface ObjectMaskResult {
  maskId: string;
  contourPoints: number;
  engine: 'onnx' | 'classical';
}

/**
 * Segment and write the mask path. Throws with a user-facing sentence on the
 * failure modes a person can actually cause (no source, empty matte).
 */
export async function segmentObjectMask(req: ObjectMaskRequest): Promise<ObjectMaskResult> {
  const node = defaultSceneGraph.getNode(req.nodeId);
  const g = node ? readGeometry(node) : null;
  const display = sourceDisplaySize(req.nodeId);
  if (!node || !g || !display) throw new Error('Layer has no sized video source.');

  const { source, width, height } = await loadExactSource(req.nodeId);
  try {
    // The frame under the playhead, decoded exactly — the pixels the person
    // drew the box over, not a proxy's approximation of them.
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('No 2D context for segmentation readback.');
    const mediaSec = mediaTimeAt(req.nodeId, req.compTime);
    const idx = source.frameIndexAt(Math.max(0, Math.round(mediaSec * 1e6) + 1));
    const frame = await source.frameAt(idx);
    ctx.drawImage(frame as CanvasImageSource, 0, 0);
    const rgba = ctx.getImageData(0, 0, width, height).data;

    // Prompts arrive in DISPLAY px; the decoded plane is CODED px.
    const sx = width / display.width;
    const sy = height / display.height;
    const box = req.box
      ? {
          x0: Math.min(req.box.x0, req.box.x1) * sx,
          y0: Math.min(req.box.y0, req.box.y1) * sy,
          x1: Math.max(req.box.x0, req.box.x1) * sx,
          y1: Math.max(req.box.y0, req.box.y1) * sy,
        }
      : undefined;
    const points = !req.box && req.point
      ? [{ x: req.point.x * sx, y: req.point.y * sy, label: 1 as const }]
      : undefined;
    if (!box && !points) throw new Error('Nothing to segment — click the object or drag a box around it.');

    const segment = await segmentSam({
      rgba,
      width,
      height,
      ...(points ? { points } : {}),
      ...(box ? { box } : {}),
      featherPx: 2,
    });

    const traced = matteToPath(segment.mask, width, height);
    if (traced.length < 3) {
      throw new Error('Could not find an object there — try a tighter box, or a click on the object itself.');
    }
    // Decimate: the tracer emits a vertex roughly per pixel, and a hundred-
    // point outline is worse at every next step — Track mask tracks at most
    // 64 vertices and interpolates the rest (its per-vertex trackers need
    // features, not a shape), hand-editing needs graspable anchors, and the
    // path effects only see the resampled polyline anyway. 48 keeps every
    // vertex of this path a tracked one, with margin under that cap.
    const MAX_POINTS = 48;
    const stride = Math.max(1, Math.ceil(traced.length / MAX_POINTS));
    const contour = traced.filter((_, i) => i % stride === 0);

    const path: MaskPath = {
      id: `obj_${Date.now().toString(36)}`,
      name: 'Object mask',
      mode: 'none',
      closed: true,
      points: contour.map((p) => {
        const lx = (p.x / width - 0.5) * g.width;
        const ly = (p.y / height - 0.5) * g.height;
        return { x: lx, y: ly, inX: lx, inY: ly, outX: lx, outY: ly };
      }),
      feather: 2,
      opacity: 1,
      expansion: 0,
      inverted: false,
    };
    addMaskPath(req.nodeId, path);
    bumpScene();
    return { maskId: path.id, contourPoints: contour.length, engine: segment.engine };
  } finally {
    source.close();
  }
}

/**
 * The pick-gesture entry: segment at the playhead and narrate the outcome
 * through the tracker store, exactly the shape `runAutoTrack` has. Never
 * throws — a click on a canvas has nobody upstream to catch.
 *
 * Deliberately does NOT `beginTracking()`: that clears the last track result,
 * and making a mask is an addition beside a track, not a replacement for it.
 * The phase alone drives the busy UI; the previous result is threaded back
 * through `finishTracking` untouched.
 */
export async function runObjectMaskPick(opts: {
  nodeId: string;
  point?: { x: number; y: number };
  box?: { x0: number; y0: number; x1: number; y1: number };
}): Promise<void> {
  const store = useTrackerStore;
  if (store.getState().tracking || store.getState().autoPhase === 'analyzing') return;
  const fps = useCompositionStore.getState().fps || 30;
  const activeTab = useProjectStore.getState().activeTabId;
  const time = activeTab ? useProjectStore.getState().tabs[activeTab]?.time ?? 0 : 0;
  const prevResult = store.getState().result;

  store.getState().setAutoPhase('analyzing');
  try {
    // The engine segments the frame with SAM itself when it runs jobs (the
    // objectMatte job; the model in a child engine process) and adds the mask.
    const viaEngine = await runEngineJob<{ contourPoints: number; engine?: string }>({
      kind: 'objectMatte',
      value: {
        layer: opts.nodeId,
        range: { start: secondsToFlicks(time), duration: secondsToFlicks(1 / fps) },
        prompts: opts.point ? [opts.point] : [],
        backgroundPrompts: [],
        encoderModel: '',
        decoderModel: '',
        ...(opts.box
          ? { box: { x: Math.min(opts.box.x0, opts.box.x1), y: Math.min(opts.box.y0, opts.box.y1), width: Math.abs(opts.box.x1 - opts.box.x0), height: Math.abs(opts.box.y1 - opts.box.y0) } }
          : {}),
      },
    });
    if (viaEngine) {
      if (viaEngine.status !== 'done') throw new Error(viaEngine.error?.message ?? 'Object mask was cancelled.');
      const display = sourceDisplaySize(opts.nodeId);
      if (display) store.getState().setMode('mask', display.width, display.height);
      store.getState().finishTracking(
        prevResult,
        `Object mask: ${viaEngine.result?.contourPoints ?? 0} points (neural). ` +
          'Track mask makes it follow; Write-on/Vegas can draw along it via their Path option.',
      );
      return;
    }
    const r = await segmentObjectMask({
      nodeId: opts.nodeId,
      compTime: time,
      fps,
      ...(opts.point ? { point: opts.point } : {}),
      ...(opts.box ? { box: opts.box } : {}),
    });
    // Land in mask mode: the produced path's next steps — Track mask, or a
    // path-following effect — both live there, and the mode's point count (0)
    // keeps the manual handles out of the way.
    const display = sourceDisplaySize(opts.nodeId);
    if (display) store.getState().setMode('mask', display.width, display.height);
    store.getState().finishTracking(
      prevResult,
      `Object mask: ${r.contourPoints} points (${r.engine === 'onnx' ? 'neural' : 'classical'}). ` +
        'Track mask makes it follow; Write-on/Vegas can draw along it via their Path option.',
    );
  } catch (e) {
    store.getState().finishTracking(prevResult, e instanceof Error ? e.message : String(e));
  }
}
