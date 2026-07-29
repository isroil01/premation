/**
 * The filmstrip — Phase 4.2.
 *
 * ## Why three stills cannot work
 *
 * The old critique pass rendered frames at 35%, 70% and the last frame. Timing,
 * spacing, easing, overshoot, flicker and pacing are all *differences between
 * adjacent frames*, and three samples an average of five seconds apart contain
 * none of that information. The most expensive stage of the loop was
 * structurally blind to the only dimension that mattered, and no amount of
 * prompt tuning fixes a missing signal.
 *
 * ## Two changes
 *
 * **Sample where things happen.** Keyframe times, not fixed percentages. A
 * 0.9-second light sweep on a 15-second composition falls entirely between a
 * 35% and a 70% sample; sampling at the keyframes means an event cannot be
 * missed, because its own endpoints are in the set.
 *
 * **Composite into one image.** 16–24 frames in a labelled grid. Frame spacing
 * in a strip *is* velocity, visually — a vision model can see acceleration in a
 * contact sheet that it cannot infer from three separate images, and one image
 * costs a fraction of what twenty attachments would.
 *
 * The velocity graphs are the other half: a critic can read "this curve is
 * linear" off a plotted line instantly and cannot read it off a still at all.
 */

import type { AiImage } from '@motion/ai-tools';
import type { ToolContext } from '@motion/ai-tools';
import { useCompositionStore } from '@stores/compositionStore';
import { renderStillFrame } from '@core/export/offlineRenderer';

/** Target frames in a strip. Enough to show a curve; few enough to stay legible. */
export const STRIP_MIN = 16;
export const STRIP_MAX = 24;

/** A render can hang in a backgrounded tab — never let it stall the run. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}

/**
 * Composition times to sample, clustered around keyframe events.
 *
 * Three sources, merged and thinned:
 *  1. **Every keyframe time**, so no event is missed;
 *  2. **The midpoint of every keyframe pair**, which is where the easing shows —
 *     the endpoints of an eased segment look the same whatever curve joins them;
 *  3. **A sparse uniform grid**, so long still passages are still represented and
 *     the reader can see that nothing is happening there.
 *
 * Thinned to `STRIP_MAX` by dropping the most closely-spaced samples first, so
 * a dense cluster loses members before an isolated event does.
 */
export function filmstripTimes(ctx: ToolContext, durationSec: number): number[] {
  const times = new Set<number>();
  const clamp = (t: number): number => Math.max(0, Math.min(durationSec, t));

  for (const node of ctx.scene.all()) {
    for (const track of ctx.anim.tracks(node.id)) {
      const kfs = track.keyframes;
      for (let i = 0; i < kfs.length; i++) {
        const t = ctx.time.toCompTime(node.id, kfs[i]!.t);
        times.add(Number(clamp(t).toFixed(3)));
        if (i > 0) {
          const prev = ctx.time.toCompTime(node.id, kfs[i - 1]!.t);
          times.add(Number(clamp((prev + t) / 2).toFixed(3)));
        }
      }
    }
  }

  // The sparse grid, plus the final held frame — a piece is judged partly on
  // where it comes to rest.
  const gridCount = 6;
  for (let i = 0; i < gridCount; i++) {
    times.add(Number(clamp((durationSec * i) / (gridCount - 1)).toFixed(3)));
  }

  const sorted = [...times].sort((a, b) => a - b);
  if (sorted.length <= STRIP_MAX) return sorted;

  // Thin by dropping whichever sample has the smallest gap to its neighbours.
  // Uniform decimation would drop half of a tight cluster AND half of an
  // isolated event; this drops from the cluster, where the redundancy is.
  const kept = [...sorted];
  while (kept.length > STRIP_MAX) {
    let worstIdx = 1;
    let worstGap = Infinity;
    for (let i = 1; i < kept.length - 1; i++) {
      const gap = kept[i + 1]! - kept[i - 1]!;
      if (gap < worstGap) {
        worstGap = gap;
        worstIdx = i;
      }
    }
    kept.splice(worstIdx, 1);
  }
  return kept;
}

// ── Compositing ───────────────────────────────────────────────────────

function makeCanvas(width: number, height: number): { canvas: HTMLCanvasElement; c2d: CanvasRenderingContext2D } | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const c2d = canvas.getContext('2d');
  return c2d ? { canvas, c2d } : null;
}

function toImage(canvas: HTMLCanvasElement): AiImage | null {
  try {
    const url = canvas.toDataURL('image/jpeg', 0.82);
    const comma = url.indexOf(',');
    if (comma < 0) return null;
    return { mediaType: 'image/jpeg', dataBase64: url.slice(comma + 1) };
  } catch {
    return null;
  }
}

/**
 * Render the times into one labelled contact sheet.
 *
 * Each cell carries its timestamp, because "the third frame" is not a thing a
 * critic can refer to usefully — "at 1.4s" is. Cells are laid out in reading
 * order and the sheet is capped at ~1600px wide so it survives the provider's
 * downscale with the labels still readable.
 */
export async function renderFilmstrip(timesSec: number[]): Promise<AiImage | null> {
  if (!timesSec.length) return null;
  try {
    const c = useCompositionStore.getState().comp();
    const params = {
      width: c.width,
      height: c.height,
      fps: c.fps,
      durationSec: c.durationSeconds,
      comp: { ...c, rootId: c.id },
    };
    const lastFrame = Math.max(0, Math.round(c.durationSeconds * c.fps) - 1);

    const cols = timesSec.length <= 8 ? 4 : timesSec.length <= 15 ? 5 : 6;
    const rows = Math.ceil(timesSec.length / cols);
    const cellW = Math.floor(1600 / cols);
    const cellH = Math.round((cellW * c.height) / Math.max(1, c.width));
    const labelH = 18;
    const pad = 4;

    const made = makeCanvas(cols * (cellW + pad) + pad, rows * (cellH + labelH + pad) + pad);
    if (!made) return null;
    const { canvas, c2d } = made;

    // A mid-grey sheet, not black or white — a black sheet hides a dark
    // composition's edges and a white one hides a light composition's.
    c2d.fillStyle = '#2a2a2e';
    c2d.fillRect(0, 0, canvas.width, canvas.height);
    c2d.font = '12px system-ui, sans-serif';
    c2d.textBaseline = 'middle';

    let drawn = 0;
    for (const [i, t] of timesSec.entries()) {
      const frame = Math.max(0, Math.min(Math.round(t * c.fps), lastFrame));
      const blob = await withTimeout(renderStillFrame(params, frame, 'image/jpeg', 0.8), 8000);
      if (!blob) continue;

      const bitmap = await withTimeout(createImageBitmap(blob), 4000);
      if (!bitmap) continue;

      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = pad + col * (cellW + pad);
      const y = pad + row * (cellH + labelH + pad);
      c2d.drawImage(bitmap, x, y, cellW, cellH);
      bitmap.close?.();

      c2d.fillStyle = '#cfcfd4';
      c2d.fillText(`${t.toFixed(2)}s`, x + 2, y + cellH + labelH / 2);
      drawn++;
    }

    // A sheet with one or two cells is not a filmstrip; it is a still with
    // decoration, and it would mislead the critic about what it is seeing.
    if (drawn < 3) return null;
    return toImage(canvas);
  } catch {
    return null;
  }
}

// ── Velocity graphs ───────────────────────────────────────────────────

export interface VelocityTrack {
  label: string;
  /** Sampled speed, value-units per second. */
  samples: number[];
}

/**
 * Sample the SPEED of the hero properties over time.
 *
 * Speed rather than value, because value is what a still already shows and speed
 * is what it cannot. A flat speed plateau is linear easing; a speed curve that
 * rises and falls smoothly is an eased move; a speed spike is a pop. All three
 * are instantly legible on a plot and invisible in a frame.
 */
export function sampleVelocities(
  ctx: ToolContext,
  durationSec: number,
  o: { maxTracks?: number; samples?: number } = {},
): VelocityTrack[] {
  const sampleCount = o.samples ?? 120;
  const maxTracks = o.maxTracks ?? 6;
  const HERO_PROPS = new Set(['x', 'y', 'scale', 'scaleX', 'scaleY', 'rotation', 'opacity', 'z']);

  const candidates: { label: string; nodeId: string; prop: string; range: number }[] = [];
  for (const node of ctx.scene.all()) {
    for (const track of ctx.anim.tracks(node.id)) {
      if (!HERO_PROPS.has(track.prop) || track.keyframes.length < 2) continue;
      const values = track.keyframes.map((k) => k.value);
      const range = Math.max(...values) - Math.min(...values);
      if (range <= 0) continue;
      candidates.push({ label: `${node.name}.${track.prop}`, nodeId: node.id, prop: track.prop, range });
    }
  }
  // The tracks that MOVE most, since a graph of a 2px drift tells nobody
  // anything and crowds out the one that matters.
  candidates.sort((a, b) => b.range - a.range);

  const dt = durationSec / Math.max(1, sampleCount - 1);
  return candidates.slice(0, maxTracks).map((c) => {
    const samples: number[] = [];
    for (let i = 0; i < sampleCount; i++) {
      const t = i * dt;
      const a = ctx.anim.evaluate(c.nodeId, ctx.time.toLayerTime(c.nodeId, Math.max(0, t - dt / 2)))[c.prop] ?? 0;
      const b = ctx.anim.evaluate(c.nodeId, ctx.time.toLayerTime(c.nodeId, Math.min(durationSec, t + dt / 2)))[c.prop] ?? 0;
      samples.push(Math.abs(b - a) / Math.max(1e-6, dt));
    }
    return { label: c.label, samples };
  });
}

/**
 * Plot the velocity tracks as one image.
 *
 * Each track is normalised to its own peak — the question is the SHAPE of the
 * curve, not how it compares to a different property in different units, and
 * sharing one axis would flatten every curve but the largest into a line.
 */
export function renderVelocityGraphs(tracks: readonly VelocityTrack[], durationSec: number): AiImage | null {
  if (!tracks.length) return null;
  const rowH = 76;
  const width = 900;
  const padL = 130;
  const made = makeCanvas(width, tracks.length * rowH + 24);
  if (!made) return null;
  const { canvas, c2d } = made;

  c2d.fillStyle = '#1c1c20';
  c2d.fillRect(0, 0, canvas.width, canvas.height);
  c2d.font = '12px system-ui, sans-serif';
  c2d.textBaseline = 'middle';

  tracks.forEach((track, i) => {
    const top = 12 + i * rowH;
    const h = rowH - 22;
    const plotW = width - padL - 16;

    c2d.fillStyle = '#8a8a92';
    c2d.fillText(track.label.slice(0, 22), 8, top + h / 2);

    // Baseline, so a flat curve is visibly flat AT zero rather than just flat.
    c2d.strokeStyle = '#3a3a42';
    c2d.lineWidth = 1;
    c2d.beginPath();
    c2d.moveTo(padL, top + h);
    c2d.lineTo(padL + plotW, top + h);
    c2d.stroke();

    const peak = Math.max(...track.samples, 1e-6);
    c2d.strokeStyle = '#5ba8ff';
    c2d.lineWidth = 1.6;
    c2d.beginPath();
    track.samples.forEach((v, n) => {
      const x = padL + (n / Math.max(1, track.samples.length - 1)) * plotW;
      const y = top + h - (v / peak) * h;
      if (n === 0) c2d.moveTo(x, y);
      else c2d.lineTo(x, y);
    });
    c2d.stroke();

    c2d.fillStyle = '#5c5c66';
    c2d.fillText(`0–${durationSec.toFixed(1)}s`, padL + plotW - 54, top + h + 8);
  });

  return toImage(canvas);
}

/**
 * Everything the fit critic sees: one contact sheet plus one graph sheet.
 *
 * Best-effort throughout. A render failure means a critique with less evidence,
 * never a failed run — the linters have already established the craft floor, and
 * this pass is about fit.
 */
export async function renderCritiqueEvidence(
  ctx: ToolContext,
  durationSec: number,
): Promise<AiImage[]> {
  const out: AiImage[] = [];
  try {
    const times = filmstripTimes(ctx, durationSec);
    const strip = await renderFilmstrip(times);
    if (strip) out.push(strip);

    const graphs = renderVelocityGraphs(sampleVelocities(ctx, durationSec), durationSec);
    if (graphs) out.push(graphs);
  } catch {
    return out;
  }
  return out;
}
