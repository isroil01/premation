/**
 * Smooth Stabilize — the driver. Walks the clip once through the exact
 * decoder (the same demux + frame-index machinery every tracker mode uses),
 * estimates per-pair camera motion from optical flow, smooths the path, and
 * writes the corrections as keyframes.
 *
 * The division of labour: `pixelMotionFlow` measures where blocks went,
 * `globalMotion` turns votes into one similarity per pair and a smoothed
 * correction per frame, `applySmoothStabilize` speaks keyframes. This file
 * only sequences frames — one decode pass, previous luma retained, flow at a
 * DOWNSAMPLED size (box-filtered, deterministic) because camera motion is a
 * global signal and quarter resolution measures it at a sixteenth the cost.
 */

import { demuxFile } from '@core/video/demuxClient';
import { ExactVideoSource, SequentialFrameReader, webCodecsAvailable } from '@core/video/exactVideoSource';
import { lumaFromDecodedFrame } from './lumaExtract';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useAssetStore } from '@stores/assetStore';
import { assetIdOf } from '@core/source/sourceInfo';
import { compToKeyframeTime } from '@core/timeline/TimelineController';
import { computeFlow } from '@core/rendering/pixelMotionFlow';
import { fitSimilarity, flowSamplePoints, stabilizingCorrections, IDENTITY_SIM, type Sim } from './globalMotion';
import { applySmoothStabilize, applySubspaceMeshSequence } from './applyTrack';
import { estimateRollingShutterShear, fitSubspaceWarp, applyRollingShutterRepair } from './subspaceWarp';
import { planAnalysisDecode } from './analysisTier';

export interface SmoothStabilizeRequest {
  nodeId: string;
  startCompTime: number;
  endCompTime: number;
  fps: number;
  comp: { width: number; height: number; rootId?: string };
  /** Smoothing window in SECONDS of camera path (Gaussian sigma). Default 0.5 —
   *  strong enough to read as locked-off on handheld, short enough that a
   *  deliberate one-second pan survives. */
  smoothnessSec?: number;
  /**
   * `similarity` (default) — global Warp Stabilizer path.
   * `subspace` — grid of local sims → Mesh Warp on the layer.
   * `rolling-shutter` — estimate shear and bake into Mesh Warp rows.
   */
  variant?: 'similarity' | 'subspace' | 'rolling-shutter';
  onProgress?: (f: number) => void;
}

export interface SmoothStabilizeResult {
  /** Keyframes written per animated property. */
  keyframes: number;
  /** Frame pairs whose fit succeeded / total pairs. */
  fittedPairs: number;
  totalPairs: number;
}

/** Box-downsample a luma plane by an integer factor. Deterministic. */
export function downsampleLuma(
  data: Float32Array,
  w: number,
  h: number,
  factor: number,
): { data: Float32Array; w: number; h: number } {
  if (factor <= 1) return { data, w, h };
  const dw = Math.max(1, Math.floor(w / factor));
  const dh = Math.max(1, Math.floor(h / factor));
  const out = new Float32Array(dw * dh);
  const inv = 1 / (factor * factor);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      let sum = 0;
      for (let oy = 0; oy < factor; oy++) {
        for (let ox = 0; ox < factor; ox++) {
          sum += data[(y * factor + oy) * w + (x * factor + ox)]!;
        }
      }
      out[y * dw + x] = sum * inv;
    }
  }
  return { data: out, w: dw, h: dh };
}

/** Flow raster target: camera motion reads fine at ~480 wide. */
const STAB_MAX_DIM = 480;

export async function smoothStabilizeVideoLayer(req: SmoothStabilizeRequest): Promise<SmoothStabilizeResult> {
  if (!webCodecsAvailable()) {
    throw new Error('Stabilization needs WebCodecs, which this runtime does not have.');
  }
  const node = defaultSceneGraph.getNode(req.nodeId);
  if (!node) throw new Error('Layer is gone.');
  const assetId = assetIdOf(node);
  const asset = assetId ? useAssetStore.getState().assets.find((a) => a.id === assetId) : undefined;
  if (!asset || asset.type !== 'video') throw new Error('Layer has no video source.');

  // The ANALYSIS stand-in when one exists — same decision, and the same shared
  // rule, as the point tracker. Flow already runs at STAB_MAX_DIM whatever gets
  // decoded, so the resolution of the file changes nothing about the
  // measurement; what it changes is the seek (97.6% of the cost at 4K, per the
  // table in `@core/assets/proxy`) and the readback canvas, which drops from
  // 3840x2160 to 960x540 — a sixteenth of the pixels pulled back per frame.
  const plan = planAnalysisDecode(req.nodeId, asset);
  const res = await fetch(plan.src);
  if (!res.ok) throw new Error(`Source unreadable (${res.status}).`);
  // Off the main thread when one is available (see demuxClient). This also
  // picks the container by magic bytes, where this call site assumed MP4 —
  // a WebM layer used to reach mp4box and fail with a parse error.
  const demuxed = await demuxFile(await res.arrayBuffer());
  const source = new ExactVideoSource(demuxed);
  // Hoisted so the finally below can close the streaming pass (see makePass).
  let pass: { frameFor: (i: number) => Promise<unknown>; close: () => void } | null = null;

  try {
    const startFrame = Math.round(req.startCompTime * req.fps);
    const endFrame = Math.round(req.endCompTime * req.fps);
    if (endFrame <= startFrame) throw new Error('Nothing after the playhead to stabilize.');

    const srcIndexAt = (compFrame: number): number => {
      const mediaSec = compToKeyframeTime(req.nodeId, compFrame / req.fps);
      return source.frameIndexAt(Math.max(0, Math.round(mediaSec * 1e6) + 1));
    };

    // The ORIGINAL's grid, established without asking the decoder. The fallback
    // is reachable only when `planAnalysisDecode` refused a stand-in, so there
    // it IS the source's size — see `analysisTier` for why deriving this from
    // the decode would silently scale every correction by the proxy ratio.
    const display = plan.display ?? {
      width: demuxed.codedWidth,
      height: demuxed.codedHeight,
    };
    const factor = Math.max(1, Math.floor(Math.max(demuxed.codedWidth, demuxed.codedHeight) / STAB_MAX_DIM));
    // Flow-grid px → source DISPLAY px: undo the downsample, then coded→display.
    const scaleX = (factor * display.width) / demuxed.codedWidth;
    const scaleY = (factor * display.height) / demuxed.codedHeight;

    // One luma reader canvas, reused per frame.
    const canvas = document.createElement('canvas');
    canvas.width = demuxed.codedWidth;
    canvas.height = demuxed.codedHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('No 2D context for frame readback.');

    // Each analysis pass walks the source FORWARD once, so it streams through
    // a SequentialFrameReader (one decode per frame, frames closed as soon as
    // their luma is copied) instead of random-access frameAt — which was
    // quadratic in GOP length and pinned enough decoder-pool frames to hang
    // (the same freeze Track Motion had). Non-monotonic requests (a remapped
    // clip wiggling backwards) fall through to random access for that frame.
    const srcFromIdx = srcIndexAt(startFrame);
    const srcToIdx = srcIndexAt(endFrame);
    // Same prefer-software rationale as trackVideoLayer: dense flow reads
    // every pixel back, and software frames copy in ~2ms where hardware
    // frames pay a long GPU sync. Probed so unsupported degrades quietly.
    let softwareOk = false;
    try {
      const vd = (globalThis as unknown as {
        VideoDecoder?: { isConfigSupported?: (c: object) => Promise<{ supported?: boolean }> };
      }).VideoDecoder;
      const sup = await vd?.isConfigSupported?.({
        codec: demuxed.codec,
        codedWidth: demuxed.codedWidth,
        codedHeight: demuxed.codedHeight,
        ...(demuxed.description ? { description: demuxed.description } : {}),
        hardwareAcceleration: 'prefer-software',
      });
      softwareOk = sup?.supported === true;
    } catch {
      // probe unavailable — stay on the default
    }
    const makePass = (): { frameFor: (i: number) => Promise<unknown>; close: () => void } => {
      if (srcToIdx < srcFromIdx) {
        return { frameFor: (i) => source.frameAt(i), close: () => {} };
      }
      const reader = new SequentialFrameReader(
        demuxed, srcFromIdx, srcToIdx, undefined,
        softwareOk ? { hardwareAcceleration: 'prefer-software' } : {},
      );
      let last = -Infinity;
      return {
        frameFor: (i) => {
          if (i < last) return source.frameAt(i);
          last = i;
          return reader.frameAt(i);
        },
        close: () => reader.close(),
      };
    };
    pass = makePass();
    const canvasReader = (frame: CanvasImageSource): { data: Float32Array; width: number; height: number } => {
      ctx.drawImage(frame, 0, 0);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const full = new Float32Array(canvas.width * canvas.height);
      for (let i = 0, p = 0; i < full.length; i++, p += 4) {
        full[i] = img.data[p]! * 0.299 + img.data[p + 1]! * 0.587 + img.data[p + 2]! * 0.114;
      }
      return { data: full, width: canvas.width, height: canvas.height };
    };
    const lumaAt = async (srcIdx: number): Promise<{ data: Float32Array; w: number; h: number }> => {
      const frame = await pass!.frameFor(srcIdx);
      // Y-plane fast path (see lumaExtract): full-res RGBA readback per frame
      // was most of the analysis cost. Scale mismatch vs the canvas route
      // (0–1 vs 0–255, video range) is irrelevant — the flow is gradient-
      // based and every frame of a pass takes the same path.
      const plane = await lumaFromDecodedFrame(frame, canvas.width, canvas.height, canvasReader, 1);
      // scale=1 (not 'raw8') ⇒ always a Float32 plane: the flow math is
      // gradient-magnitude-based, NOT gain-invariant, so it keeps one range.
      return downsampleLuma(plane.data as Float32Array, plane.width, plane.height, factor);
    };

    // Comp-frame walk. Comp frames that resolve to the SAME source frame
    // (a slowed layer) contribute an identity pair — no motion between
    // identical frames, and the smoother rides through.
    const compFrames: number[] = [];
    for (let f = startFrame; f <= endFrame; f++) compFrames.push(f);
    const pairs: Array<Sim | null> = [];
    let fitted = 0;
    let prevIdx = srcIndexAt(startFrame);
    let prev = await lumaAt(prevIdx);
    for (let i = 1; i < compFrames.length; i++) {
      const idx = srcIndexAt(compFrames[i]!);
      if (idx === prevIdx) {
        pairs.push({ a: 1, b: 0, tx: 0, ty: 0 });
        fitted++;
      } else {
        const cur = await lumaAt(idx);
        const flow = computeFlow(prev.data, cur.data, prev.w, prev.h);
        const fit = fitSimilarity(flowSamplePoints(flow, scaleX, scaleY));
        pairs.push(fit);
        if (fit) fitted++;
        prev = cur;
        prevIdx = idx;
      }
      req.onProgress?.(i / (compFrames.length - 1));
    }

    const sigmaFrames = Math.max(1, (req.smoothnessSec ?? 0.5) * req.fps);
    const corrections = stabilizingCorrections(pairs, sigmaFrames);
    const variant = req.variant ?? 'similarity';

    if (variant === 'subspace' || variant === 'rolling-shutter') {
      // Full Warp Stabilizer–class path: per-frame subspace (or RS shear) mesh.
      // This is a SECOND forward walk from the start — fresh streaming pass.
      pass?.close();
      pass = makePass();
      const meshFrames: Array<{ cells: ReturnType<typeof fitSubspaceWarp>; compTime: number }> = [];
      let prevL = await lumaAt(srcIndexAt(compFrames[0]!));
      let prevI = srcIndexAt(compFrames[0]!);
      const fieldW0 = prevL.w * scaleX;
      const fieldH0 = prevL.h * scaleY;
      // Identity at first frame.
      meshFrames.push({
        cells: fitSubspaceWarp(
          computeFlow(prevL.data, prevL.data, prevL.w, prevL.h),
          4, 4, scaleX, scaleY,
        ).map((c) => ({ ...c, sim: IDENTITY_SIM })),
        compTime: compFrames[0]! / req.fps,
      });
      for (let i = 1; i < compFrames.length; i++) {
        const idx = srcIndexAt(compFrames[i]!);
        const cur = idx === prevI ? prevL : await lumaAt(idx);
        const flow = computeFlow(prevL.data, cur.data, prevL.w, prevL.h);
        let cells = fitSubspaceWarp(flow, 4, 4, scaleX, scaleY);
        if (variant === 'rolling-shutter') {
          const k = estimateRollingShutterShear(flow, scaleX, scaleY);
          const cy = fieldH0 / 2;
          cells = cells.map((c) => {
            const [tx] = applyRollingShutterRepair(c.cx, c.cy, cy, -k);
            return { ...c, sim: { ...c.sim, tx: c.sim.tx + (tx - c.cx) * 0.5 } };
          });
        }
        // Invert local motion ≈ stabilization correction (same idea as similarity path).
        cells = cells.map((c) => ({
          ...c,
          sim: {
            a: c.sim.a, b: -c.sim.b,
            tx: -c.sim.tx, ty: -c.sim.ty,
          },
        }));
        meshFrames.push({ cells, compTime: compFrames[i]! / req.fps });
        prevL = cur;
        prevI = idx;
        req.onProgress?.(i / (compFrames.length - 1));
      }
      // `display` already IS that answer, resolved once above and guaranteed to
      // describe the original rather than whatever was decoded.
      const keyframes = applySubspaceMeshSequence({
        targetNodeId: req.nodeId,
        frames: meshFrames,
        rows: 4,
        cols: 4,
        fieldW: fieldW0,
        fieldH: fieldH0,
        layerW: display.width,
        layerH: display.height,
      });
      return { keyframes, fittedPairs: fitted, totalPairs: pairs.length };
    }

    const keyframes = applySmoothStabilize({
      videoNodeId: req.nodeId,
      corrections,
      compFrames,
      fps: req.fps,
      sourceWidth: display.width,
      sourceHeight: display.height,
      comp: req.comp,
    });
    return { keyframes, fittedPairs: fitted, totalPairs: pairs.length };
  } finally {
    pass?.close();
    source.close();
  }
}
