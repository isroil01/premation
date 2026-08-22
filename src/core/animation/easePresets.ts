/**
 * The ease-curve library — named starting points over the bezier handles.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * Until now the only easings you could apply by name were Easy Ease and its two
 * one-sided variants: three points on a continuum, all of them gentle. Anything
 * with actual character — a hard Expo departure, a Back overshoot, the snap of
 * a Quint — had to be dialled in by dragging handles in the graph editor, one
 * keyframe pair at a time, with no way to reproduce it on the next layer. That
 * is the single biggest gap between this and the Flow / Motion 4 workflow, and
 * it is a registry rather than a feature.
 *
 * ── What a cubic bezier CAN and CANNOT express ───────────────────────────────
 *
 * Every curve here is a single cubic bezier, because that is what a keyframe
 * stores (`BezierHandles`, consumed by `cubicBezierEase`). That admits more than
 * it looks like: `cubicBezierEase` clamps the bezier PARAMETER to [0,1] but not
 * the sampled Y, so a control point above 1 or below 0 overshoots — which is
 * exactly what Back is, and why it belongs here.
 *
 * What a single cubic bezier cannot be is NON-MONOTONIC IN X or oscillating.
 * So **Elastic and Bounce are deliberately absent**: both cross their target
 * repeatedly with decaying amplitude, which no single cubic segment can trace.
 * Adding `elastic-out` here as "the closest bezier" would be a curve that is
 * not elastic wearing the name of one. They are GENERATORS — they must write
 * several keyframes — and they already exist as such in `bounce.ts` (Drop,
 * Elastic, Rubber, Spring), whose home is the Graph panel. Send people there
 * rather than growing a lookalike here.
 *
 * ── Where the numbers come from ──────────────────────────────────────────────
 *
 * The standard Penner approximations, the same set CSS authors and every motion
 * tool use, so a curve named Expo Out here matches Expo Out everywhere else.
 * Every X stays inside [0,1] — `cubicBezierEase`'s Newton solve assumes a
 * function of x, and a control point outside that range makes it multi-valued.
 * `easeCurveWellFormed` pins that invariant for the whole table.
 */

import type { BezierHandles } from '@motion/animation';

/** The shape of the acceleration, independent of which end it applies to. */
export type EaseFamily =
  | 'sine' | 'quad' | 'cubic' | 'quart' | 'quint' | 'expo' | 'circ' | 'back';

/** Which end of the segment the easing shapes. */
export type EaseDirection = 'in' | 'out' | 'inOut';

/** `${family}-${direction}` — the stable id used by commands, menus and undo. */
export type EasePresetId = `${EaseFamily}-${EaseDirection}`;

export interface EasePreset {
  id: EasePresetId;
  /** Display name, e.g. "Expo Out". */
  label: string;
  family: EaseFamily;
  direction: EaseDirection;
  bezier: BezierHandles;
  /**
   * True when the curve leaves [0,1] and so passes its target before settling.
   * Surfaced because overshoot is a property people choose deliberately — and
   * because it is the one thing here that can look like a bug on a property
   * that must not exceed its bounds (opacity, a 0..1 slider).
   */
  overshoots: boolean;
}

/** Families in increasing severity — the order they are offered in. */
const FAMILY_ORDER: ReadonlyArray<{ family: EaseFamily; label: string }> = [
  { family: 'sine', label: 'Sine' },
  { family: 'quad', label: 'Quad' },
  { family: 'cubic', label: 'Cubic' },
  { family: 'quart', label: 'Quart' },
  { family: 'quint', label: 'Quint' },
  { family: 'expo', label: 'Expo' },
  { family: 'circ', label: 'Circ' },
  { family: 'back', label: 'Back' },
];

const DIRECTION_LABEL: Record<EaseDirection, string> = {
  in: 'In',
  out: 'Out',
  inOut: 'In Out',
};

/** The raw table: family → direction → handles. */
const CURVES: Record<EaseFamily, Record<EaseDirection, BezierHandles>> = {
  sine:  { in: [0.12, 0, 0.39, 0],    out: [0.61, 1, 0.88, 1],    inOut: [0.37, 0, 0.63, 1] },
  quad:  { in: [0.11, 0, 0.5, 0],     out: [0.5, 1, 0.89, 1],     inOut: [0.45, 0, 0.55, 1] },
  cubic: { in: [0.32, 0, 0.67, 0],    out: [0.33, 1, 0.68, 1],    inOut: [0.65, 0, 0.35, 1] },
  quart: { in: [0.5, 0, 0.75, 0],     out: [0.25, 1, 0.5, 1],     inOut: [0.76, 0, 0.24, 1] },
  quint: { in: [0.64, 0, 0.78, 0],    out: [0.22, 1, 0.36, 1],    inOut: [0.83, 0, 0.17, 1] },
  expo:  { in: [0.7, 0, 0.84, 0],     out: [0.16, 1, 0.3, 1],     inOut: [0.87, 0, 0.13, 1] },
  circ:  { in: [0.55, 0, 1, 0.45],    out: [0, 0.55, 0.45, 1],    inOut: [0.85, 0, 0.15, 1] },
  back:  { in: [0.36, 0, 0.66, -0.56], out: [0.34, 1.56, 0.64, 1], inOut: [0.68, -0.6, 0.32, 1.6] },
};

function buildPresets(): EasePreset[] {
  const out: EasePreset[] = [];
  for (const { family, label } of FAMILY_ORDER) {
    for (const direction of ['in', 'out', 'inOut'] as const) {
      const bezier = CURVES[family][direction];
      out.push({
        id: `${family}-${direction}`,
        label: `${label} ${DIRECTION_LABEL[direction]}`,
        family,
        direction,
        bezier,
        // Y is the value axis; X is time. Only Y may leave [0,1].
        overshoots: bezier[1] < 0 || bezier[1] > 1 || bezier[3] < 0 || bezier[3] > 1,
      });
    }
  }
  return out;
}

/** Every curve in the library, grouped by family, gentlest family first. */
export const EASE_PRESETS: ReadonlyArray<EasePreset> = buildPresets();

const BY_ID: ReadonlyMap<string, EasePreset> = new Map(EASE_PRESETS.map((p) => [p.id, p]));

/** Look up a curve by id. Undefined for the legacy names (Ease, Hold, …), which
 *  are not in this table — see `presetCurve` in `keyframeAssistants`. */
export function easePresetById(id: string): EasePreset | undefined {
  return BY_ID.get(id);
}

/** True when `id` names a curve in this library. Narrows for the apply path. */
export function isEasePresetId(id: string): id is EasePresetId {
  return BY_ID.has(id);
}

/** The library grouped for display: one row per family. */
export function easePresetsByFamily(): ReadonlyArray<{ family: EaseFamily; label: string; presets: EasePreset[] }> {
  return FAMILY_ORDER.map(({ family, label }) => ({
    family,
    label,
    presets: EASE_PRESETS.filter((p) => p.family === family),
  }));
}
