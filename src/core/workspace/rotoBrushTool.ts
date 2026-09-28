/**
 * Roto Brush TOOL glue — turns the strokes painted on the viewport
 * (`rotoBrushStore`) into a matte on the layer, and hands "propagate
 * forward" to the engine.
 *
 * Both halves are ENGINE jobs (docs/TS_ENGINE_REMOVAL.md phase 4; the page
 * segmenter and propagator that ran on the TypeScript engine are gone):
 *
 *   segment     the `objectMatte` job — SAM on the real frame, the strokes'
 *               points as foreground / background prompts — written as the
 *               tool's "Roto Brush" Add mask, replacing the tool's previous
 *               outline in the same history entry.
 *   propagate   the `rotoBrush` job, seeded at the first foreground point.
 *
 * ## Spaces
 *
 *   stroke points   layer-local px, centre origin (the mask path's space)
 *   job prompts     layer px, top-left origin (the footage's display size)
 */

import { secondsToFlicks } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import { requireEngineJob, runEngineJob, startEngineJob } from '@core/engine/engineJobs';
import { documentMirror } from '@stores/documentMirror';
import { mirrorMaskHeaders } from '@core/mirror/effects';
import type { RotoStroke } from '@stores/rotoBrushStore';

/** The name every path this tool writes carries, so a re-segment replaces it. */
export const ROTO_PATH_NAME = 'Roto Brush';

export interface RotoPrompts {
  fg: Array<{ x: number; y: number }>;
  bg: Array<{ x: number; y: number }>;
}

/** What a propagation did (`frames` walked, `keyframes` written). */
export interface RotoBrushResult {
  keyframes: number;
  frames: number;
  status: 'completed' | 'cancelled';
}

/**
 * Stroke points → the job's prompts in layer px (top-left origin). Every
 * point of a stroke is a prompt: a stroke is how a brush says "all of this".
 */
export function strokesToPrompts(strokes: readonly RotoStroke[], layer: { width: number; height: number }): RotoPrompts {
  const out: RotoPrompts = { fg: [], bg: [] };
  for (const s of strokes) {
    // Thin dense strokes to at most ~24 prompts each — the segmenter's cost is
    // per prompt, and a slow drag records hundreds of near-identical points.
    const step = Math.max(1, Math.ceil(s.points.length / 24));
    for (let i = 0; i < s.points.length; i += step) {
      const p = s.points[i]!;
      const x = p.x + layer.width / 2;
      const y = p.y + layer.height / 2;
      if (x < 0 || y < 0 || x >= layer.width || y >= layer.height) continue;
      (s.kind === 'fg' ? out.fg : out.bg).push({ x, y });
    }
  }
  return out;
}

/** The footage's display size — the layer px the strokes and prompts live in. */
async function layerSize(nodeId: string): Promise<{ width: number; height: number } | null> {
  const res = await engine().query({ type: 'getSourceSize', layers: [nodeId] });
  const s = res.ok ? res.value.sizes[0] : undefined;
  return s && s.width > 0 && s.height > 0 ? { width: s.width, height: s.height } : null;
}

export interface SegmentStrokesOptions {
  featherPx?: number;
  /** Replace this path id if it is still on the layer. */
  replacePathId?: string | null;
}

/**
 * Segment from the strokes and write the matte as the layer's roto mask
 * (replacing the tool's previous path; one undo entry). Resolves to the new
 * mask's id, or null when nothing usable came back or the layer is not
 * addressable. Throws when the engine does not run the job.
 */
export async function segmentStrokesToMask(
  nodeId: string,
  strokes: readonly RotoStroke[],
  timeSec: number,
  opts: SegmentStrokesOptions = {},
): Promise<string | null> {
  if (!strokes.some((s) => s.kind === 'fg' && s.points.length > 0)) return null;
  const size = await layerSize(nodeId);
  if (!size) return null;
  const prompts = strokesToPrompts(strokes, size);
  if (prompts.fg.length === 0) return null;
  // The tool's previous paths go: the one it wrote last (by id) and any other it left (by name).
  const replace = new Set<string>(opts.replacePathId ? [opts.replacePathId] : []);
  for (const m of mirrorMaskHeaders(documentMirror().tree(nodeId))) if (m.name === ROTO_PATH_NAME) replace.add(m.id);
  const out = requireEngineJob(await runEngineJob<{ mask?: string }>({
    kind: 'objectMatte',
    value: {
      layer: nodeId,
      range: { start: secondsToFlicks(timeSec), duration: secondsToFlicks(1 / 30) },
      prompts: prompts.fg,
      backgroundPrompts: prompts.bg,
      encoderModel: '',
      decoderModel: '',
      maskName: ROTO_PATH_NAME,
      maskMode: 'add',
      feather: opts.featherPx ?? 2,
      replaceMasks: [...replace],
    },
  }), 'Roto Brush');
  if (out.status !== 'done') {
    if (out.status === 'failed') throw new Error(out.error?.message ?? 'Roto Brush failed');
    return null;
  }
  return out.result?.mask ?? null;
}

/**
 * Propagate the matte forward from `fromSec` to `toSec` in the engine,
 * seeded at the first foreground stroke's first point (layer px).
 */
export async function propagateRotoForward(
  nodeId: string,
  strokes: readonly RotoStroke[],
  fromSec: number,
  toSec: number,
  fps: number,
  featherPx: number,
  onProgress?: (f: number) => boolean | void,
): Promise<RotoBrushResult> {
  const size = await layerSize(nodeId);
  if (!size) throw new Error('Layer has no sized video source.');
  const fg = strokes.find((s) => s.kind === 'fg' && s.points.length > 0);
  const p0 = fg?.points[0];
  if (!p0) throw new Error('Paint a foreground stroke first.');
  const seed = { x: p0.x + size.width / 2, y: p0.y + size.height / 2 };
  const startF = Math.round(fromSec * fps);
  const endF = Math.round(toSec * fps);
  let cancel: (() => void) | null = null;
  const handle = requireEngineJob(await startEngineJob<{ frames: number; keyframes: number }>(
    {
      kind: 'rotoBrush',
      value: {
        layer: nodeId,
        range: {
          start: secondsToFlicks(startF / Math.max(1, fps)),
          duration: secondsToFlicks(Math.max(1, endF - startF + 1) / Math.max(1, fps)),
        },
        seed,
        feather: featherPx,
      },
    },
    {
      onProgress: (f) => {
        if (onProgress?.(f) === false) cancel?.();
      },
    },
  ), 'Roto Brush');
  cancel = handle.cancel;
  const out = await handle.done;
  if (out.status === 'cancelled') return { keyframes: 0, frames: 0, status: 'cancelled' };
  if (out.status !== 'done') throw new Error(out.error?.message ?? 'Roto Brush failed');
  return { keyframes: out.result?.keyframes ?? 0, frames: out.result?.frames ?? 0, status: 'completed' };
}
