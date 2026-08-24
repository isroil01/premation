/**
 * Auto-trace — a layer's alpha, as mask paths.
 *
 * AE's Layer ▸ Auto-trace: render the layer alone, threshold its alpha (or
 * luma), and turn the outline of what is left into mask paths on the layer —
 * one per frame when a range is traced, which is how a keyed shot becomes a
 * vector matte that can be feathered, expanded and edited point by point.
 *
 * ## How the layer is rendered alone
 *
 * Through the deterministic offline still renderer, with every other layer
 * suppressed by SOLO — the same mechanism the timeline's solo switch uses, so
 * what gets traced is what the renderer actually draws for this layer,
 * effects and masks included. The comp is rendered transparent so background
 * paint does not read as coverage. Solo state is restored afterwards whatever
 * happens; a trace that left the comp soloed would be worse than no trace.
 *
 * ## Coordinates
 *
 * The still is comp-sized, so traced points are in COMP space. Mask points
 * are in LAYER space (centre-origin, unscaled), so each vertex is pulled back
 * through the inverse of the layer's world affine at that frame.
 *
 * Holes become SUBTRACT paths. A mask path is one ring, so a letter's counter
 * cannot live inside its outer ring — but the mask stack composites in order,
 * and a subtract path after an add path cuts the hole back out. Outer rings
 * are emitted first (mode add), then every hole (mode subtract), which is
 * exactly how AE's own Auto-trace lays out a traced O.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useCompositionStore } from '@stores/compositionStore';
import { compSizeOf } from '@core/composition/compSizes';
import { renderOffline } from '@core/export/offlineRenderer';
import { world2DAt } from '@core/scene/layerSpace';
import { Matrix } from '@motion/scene';
import { traceBitmap, simplifyRing, type TracedContour } from '@core/geometry/traceBitmap';
import { addMaskPath, keyframeMask, type MaskPath, type MaskPoint } from './mask';
import { bumpScene } from '@stores/sceneStore';
import { flattenComposition } from '@core/scene/sceneDerive';

export interface AutoTraceOptions {
  nodeId: string;
  /** Comp seconds. A single frame when `endSec` is absent or equal. */
  startSec: number;
  endSec?: number;
  /** 0..255 alpha threshold. Default 128. */
  threshold?: number;
  /** Pixel tolerance for the outline simplification. Default 1.5. */
  tolerance?: number;
  /** Drop contours with less area than this, in comp pixels². Default 16. */
  minArea?: number;
  /** Return false to cancel. */
  onProgress?: (fraction: number) => boolean | void;
}

export interface AutoTraceResult {
  /** Mask paths written to the layer on the first traced frame. */
  pathsAdded: number;
  /** Frames that produced a mask keyframe (0 for a single-frame trace). */
  keyframes: number;
  status: 'completed' | 'cancelled';
}

/** Render one comp frame with only `nodeId` visible; returns its RGBA. */
async function renderLayerAlone(nodeId: string, frame: number): Promise<{ data: Uint8ClampedArray; w: number; h: number }> {
  const c = useCompositionStore.getState().comp();
  const nodes = flattenComposition(defaultSceneGraph, c.id);
  const previous = new Map<string, boolean | undefined>();
  for (const n of nodes) {
    previous.set(n.id, n.solo);
    n.solo = n.id === nodeId;
  }
  try {
    let out: { data: Uint8ClampedArray; w: number; h: number } | null = null;
    await renderOffline(
      {
        width: c.width, height: c.height, fps: c.fps, durationSec: c.durationSeconds,
        comp: { ...c, rootId: c.id, compSizeOf, transparent: true },
        startFrame: frame, endFrame: frame,
      },
      async (canvas) => {
        // The render canvas is GPU-backed (WebGL2 / WebGPU), so it has no 2D
        // context to read from. Blit it onto a scratch 2D canvas — the same
        // readback route `renderStillFrame`'s PNG encode takes via toBlob.
        const scratch = document.createElement('canvas');
        scratch.width = canvas.width;
        scratch.height = canvas.height;
        const g = scratch.getContext('2d', { willReadFrequently: true });
        if (!g) return;
        g.drawImage(canvas, 0, 0);
        const img = g.getImageData(0, 0, scratch.width, scratch.height);
        out = { data: img.data, w: scratch.width, h: scratch.height };
      },
    );
    if (!out) throw new Error('The frame could not be read back.');
    return out;
  } finally {
    for (const n of nodes) n.solo = previous.get(n.id);
  }
}

/** Comp-space contours → layer-space mask rings, outer rings first, then holes. */
function contoursToMaskRings(
  contours: ReadonlyArray<TracedContour>,
  nodeId: string,
  time: number,
  scaleX: number,
  scaleY: number,
): Array<{ points: MaskPoint[]; hole: boolean }> {
  const inv = Matrix.invert(world2DAt(nodeId, time));
  const toRing = (c: TracedContour): MaskPoint[] =>
    c.points.map((p) => {
      const l = Matrix.transformPoint(inv, { x: p.x * scaleX, y: p.y * scaleY });
      return { x: l.x, y: l.y, inX: l.x, inY: l.y, outX: l.x, outY: l.y };
    });
  const usable = contours.filter((c) => c.points.length >= 3);
  return [
    ...usable.filter((c) => !c.hole).map((c) => ({ points: toRing(c), hole: false })),
    ...usable.filter((c) => c.hole).map((c) => ({ points: toRing(c), hole: true })),
  ];
}

/**
 * Trace the layer at one frame (or every frame of a range, as mask keyframes).
 */
export async function autoTraceLayer(opts: AutoTraceOptions): Promise<AutoTraceResult> {
  const node = defaultSceneGraph.getNode(opts.nodeId);
  if (!node) throw new Error('Layer is gone.');
  const c = useCompositionStore.getState().comp();
  const fps = c.fps || 30;
  const first = Math.round(opts.startSec * fps);
  const last = opts.endSec !== undefined ? Math.max(first, Math.round(opts.endSec * fps)) : first;
  const threshold = opts.threshold ?? 128;
  const tolerance = opts.tolerance ?? 1.5;
  const minArea = opts.minArea ?? 16;

  let pathsAdded = 0;
  let keyframes = 0;
  for (let f = first; f <= last; f++) {
    const t = f / fps;
    const frame = await renderLayerAlone(opts.nodeId, f);
    // The still may be rendered at a different pixel size than the comp
    // (device pixel ratio); map back to comp units.
    const sx = c.width / frame.w, sy = c.height / frame.h;
    const contours = traceBitmap(frame.data, frame.w, frame.h, 4, { threshold, tolerance, minArea: minArea / (sx * sy) });
    const rings = contoursToMaskRings(contours, opts.nodeId, t, sx, sy)
      .map((r) => ({
        hole: r.hole,
        points: simplifyRing(r.points, 0.25).map((p) => ({ ...p, inX: p.x, inY: p.y, outX: p.x, outY: p.y })),
      }));

    if (f === first) {
      let outer = 0, holes = 0;
      for (let i = 0; i < rings.length; i++) {
        const { hole, points } = rings[i]!;
        const path: MaskPath = {
          id: `trace_${opts.nodeId}_${f}_${i}`,
          name: hole ? `Auto-trace hole ${++holes}` : `Auto-trace ${++outer}`,
          mode: hole ? 'subtract' : 'add',
          closed: true,
          points,
          feather: 0,
          opacity: 1,
          expansion: 0,
          inverted: false,
        };
        addMaskPath(opts.nodeId, path);
        pathsAdded++;
      }
    }
    if (last > first) {
      // A range trace keys the WHOLE mask per frame (that is what the mask
      // track holds). On later frames the ring count may differ; the mask
      // interpolator snaps to the nearer keyframe when point counts disagree,
      // so every frame still shows its own outline exactly.
      if (f !== first) {
        replaceMaskRings(opts.nodeId, rings, f);
      }
      keyframeMask(opts.nodeId, t);
      keyframes++;
    }
    if (opts.onProgress?.((f - first + 1) / (last - first + 1)) === false) {
      bumpScene();
      return { pathsAdded, keyframes, status: 'cancelled' };
    }
  }
  bumpScene();
  return { pathsAdded, keyframes, status: 'completed' };
}

/** Overwrite the traced paths' points with this frame's rings, keeping add/subtract roles. */
function replaceMaskRings(
  nodeId: string,
  rings: ReadonlyArray<{ points: MaskPoint[]; hole: boolean }>,
  frame: number,
): void {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;
  const fx = node.components.find((c) => c.type === 'fx');
  const mask = fx?.props.mask as { paths: MaskPath[] } | undefined;
  if (!mask) return;
  const traced = mask.paths.filter((p) => p.id.startsWith(`trace_${nodeId}_`));
  rings.forEach((ring, i) => {
    const target = traced[i];
    if (target) {
      target.points = ring.points;
      target.mode = ring.hole ? 'subtract' : 'add';
    } else {
      mask.paths.push({
        id: `trace_${nodeId}_${frame}_${i}`,
        name: ring.hole ? 'Auto-trace hole' : 'Auto-trace',
        mode: ring.hole ? 'subtract' : 'add',
        closed: true,
        points: ring.points, feather: 0, opacity: 1, expansion: 0, inverted: false,
      });
    }
  });
}
