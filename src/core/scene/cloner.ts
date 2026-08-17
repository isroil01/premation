/**
 * Cloners — one layer, laid out many times, shaped by effectors.
 *
 * The MoGraph/Cavalry idea: instead of duplicating a layer forty times and
 * keyframing each, you place it once and describe the ARRANGEMENT. Everything
 * downstream — a stagger, a wave, a random scatter — then comes from modifying
 * that description rather than from forty sets of keyframes.
 *
 * ── Why a pure plan ─────────────────────────────────────────────────────────
 *
 * This module answers exactly one question — "where does clone `i` sit, and
 * what does it look like?" — and answers it as a pure function of the config.
 * Nothing here touches the scene graph, the renderer or time. That matters
 * because every interesting bug in a system like this is arithmetic that looks
 * plausible on screen: a radial ring that double-counts its last clone and
 * overlaps the first, a grid that centres on its corner instead of its middle,
 * a stagger that runs backwards, a falloff that inverts. Those are all
 * assertable here and nearly invisible once composited.
 *
 * ── Determinism ─────────────────────────────────────────────────────────────
 *
 * Randomness is HASHED FROM THE CLONE INDEX, never accumulated, so clone 30
 * has the same offset whether you scrubbed to it or played through — the same
 * contract `particleSim` holds, for the same reason. A cloner that reshuffles
 * on scrub is unusable for anything you intend to render.
 */

/** How the clones are arranged before any effector runs. */
export type ClonerMode = 'linear' | 'grid' | 'radial';

/** Which clones an effector reaches, and how strongly. */
export type FalloffShape = 'none' | 'linear' | 'radial';

export interface ClonerRandom {
  seed: number;
  /** Max ± offset in px, applied independently per axis. */
  position: number;
  /** Max ± rotation in degrees. */
  rotation: number;
  /** Max ± scale as a FRACTION (0.2 = ±20%). */
  scale: number;
}

/** A linear ramp across the clone order — MoGraph's Step effector. */
export interface ClonerStep {
  x: number;
  y: number;
  rotation: number;
  /** Added to scale as a fraction across the range (0.5 → last clone +50%). */
  scale: number;
  /** Added to opacity in PERCENT across the range (-100 → last clone gone). */
  opacity: number;
}

export interface ClonerFalloff {
  shape: FalloffShape;
  /** 0..1 position of the falloff centre along the clone order. */
  position: number;
  /** 0..1 half-width. At 0 only the exact centre is affected. */
  width: number;
  /** Invert, so the falloff masks OUT the middle instead of in. */
  invert: boolean;
}

export interface ClonerConfig {
  enabled: boolean;
  mode: ClonerMode;
  /** linear + radial. */
  count: number;
  countX: number;
  countY: number;
  /** linear: per-step offset. grid: cell size. */
  offsetX: number;
  offsetY: number;
  radius: number;
  /** Degrees. Where the ring starts. */
  startAngle: number;
  /** Degrees of ring to fill. 360 wraps. */
  arc: number;
  /** Rotate each clone to face out along the ring. */
  alignToRadius: boolean;
  step: ClonerStep;
  random: ClonerRandom;
  falloff: ClonerFalloff;
}

export const DEFAULT_CLONER: ClonerConfig = {
  enabled: false,
  mode: 'linear',
  count: 5,
  countX: 3,
  countY: 3,
  offsetX: 120,
  offsetY: 0,
  radius: 200,
  startAngle: -90,
  arc: 360,
  alignToRadius: false,
  step: { x: 0, y: 0, rotation: 0, scale: 0, opacity: 0 },
  random: { seed: 1, position: 0, rotation: 0, scale: 0 },
  falloff: { shape: 'none', position: 0.5, width: 0.5, invert: false },
};

/** Where one clone sits, relative to the cloner layer's own transform. */
export interface CloneTransform {
  index: number;
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  /** 0..100, matching the layer opacity scale. */
  opacity: number;
}

/** Hard cap. Each clone is a real renderable, so this is a performance cliff,
 *  not a taste limit — 1000 layers will not play back. */
export const MAX_CLONES = 500;

const DEG = Math.PI / 180;

/** Deterministic hash of (index, salt, seed) → [0,1). Same construction as
 *  `particleSim.hash01`; duplicated rather than shared because that one is
 *  private to the simulation and this must not couple to it. */
function hash01(i: number, salt: number, seed: number): number {
  let n = (i | 0) * 374761393 + (salt | 0) * 668265263 + (seed | 0) * 2246822519;
  n = (n ^ (n >>> 13)) * 1274126177;
  n = n ^ (n >>> 16);
  return (n >>> 0) / 4294967296;
}

/** Hash to [-1, 1). */
const hash11 = (i: number, salt: number, seed: number): number => hash01(i, salt, seed) * 2 - 1;

/** How many clones a config produces, capped. */
export function cloneCount(cfg: ClonerConfig): number {
  if (!cfg.enabled) return 0;
  const n = cfg.mode === 'grid'
    ? Math.max(0, Math.floor(cfg.countX)) * Math.max(0, Math.floor(cfg.countY))
    : Math.max(0, Math.floor(cfg.count));
  return Math.min(MAX_CLONES, n);
}

/**
 * Effector weight for clone `i` — 1 where the effector applies fully, 0 where
 * it does not.
 *
 * `t` is the clone's normalised position in the order, NOT its distance in
 * pixels: a falloff that measured pixels would behave differently on a grid
 * than on a ring for the same settings, and the control would stop meaning one
 * thing. Position-in-order is what MoGraph's plain effectors use too.
 */
export function falloffWeight(i: number, total: number, f: ClonerFalloff): number {
  if (f.shape === 'none') return 1;
  const t = total <= 1 ? 0 : i / (total - 1);
  const d = Math.abs(t - f.position);
  const w = Math.max(0, Math.min(1, f.width));
  let weight: number;
  if (w <= 0) {
    // A zero width still has to be reachable, or the control has a dead end at
    // one extreme — only the exact centre clone is affected.
    weight = d < 1e-6 ? 1 : 0;
  } else if (f.shape === 'linear') {
    weight = Math.max(0, 1 - d / w);
  } else {
    // Radial: a smooth cosine shoulder rather than a straight ramp, so a
    // scatter driven by it does not show the seam at the falloff edge.
    const k = Math.max(0, Math.min(1, 1 - d / w));
    weight = 0.5 - 0.5 * Math.cos(k * Math.PI);
  }
  return f.invert ? 1 - weight : weight;
}

/** The base arrangement, before effectors. */
function basePosition(i: number, cfg: ClonerConfig, total: number): { x: number; y: number; rot: number } {
  if (cfg.mode === 'grid') {
    const cols = Math.max(1, Math.floor(cfg.countX));
    const rows = Math.max(1, Math.floor(cfg.countY));
    const cx = i % cols;
    const cy = Math.floor(i / cols);
    // Centred on the cloner, not growing from its corner: a grid that grew
    // from the origin would drift off-centre as the count changed, so every
    // count tweak would need a position tweak to undo it.
    return {
      x: (cx - (cols - 1) / 2) * cfg.offsetX,
      y: (cy - (rows - 1) / 2) * cfg.offsetY,
      rot: 0,
    };
  }

  if (cfg.mode === 'radial') {
    // A full 360° ring must not place a clone at both 0° and 360° — the last
    // would sit exactly on the first. A partial arc SHOULD reach its end
    // angle, so the divisor differs: wrap divides by n, an arc by n-1.
    const wraps = Math.abs(cfg.arc) >= 360 - 1e-6;
    const denom = wraps ? total : Math.max(1, total - 1);
    const deg = cfg.startAngle + (cfg.arc * i) / denom;
    const rad = deg * DEG;
    return {
      x: Math.cos(rad) * cfg.radius,
      y: Math.sin(rad) * cfg.radius,
      rot: cfg.alignToRadius ? deg + 90 : 0,
    };
  }

  // Linear, also centred so the run grows both ways from the cloner.
  const mid = (total - 1) / 2;
  return { x: (i - mid) * cfg.offsetX, y: (i - mid) * cfg.offsetY, rot: 0 };
}

/**
 * Every clone's transform, in order.
 *
 * Effectors are applied AFTER the arrangement and are scaled by the falloff, so
 * "random position" scatters the layout rather than replacing it.
 */
export function clonerPlan(cfg: ClonerConfig): CloneTransform[] {
  const total = cloneCount(cfg);
  if (total === 0) return [];
  const out: CloneTransform[] = [];
  const seed = cfg.random.seed | 0;

  for (let i = 0; i < total; i++) {
    const base = basePosition(i, cfg, total);
    const w = falloffWeight(i, total, cfg.falloff);
    // Normalised position in the order drives the step ramp. With one clone
    // there is no ramp to speak of, and dividing by zero would make it NaN.
    const t = total <= 1 ? 0 : i / (total - 1);

    const rx = hash11(i, 1, seed) * cfg.random.position;
    const ry = hash11(i, 2, seed) * cfg.random.position;
    const rr = hash11(i, 3, seed) * cfg.random.rotation;
    const rs = hash11(i, 4, seed) * cfg.random.scale;

    const scale = 1 + (cfg.step.scale * t + rs) * w;
    out.push({
      index: i,
      x: base.x + (cfg.step.x * t + rx) * w,
      y: base.y + (cfg.step.y * t + ry) * w,
      rotation: base.rot + (cfg.step.rotation * t + rr) * w,
      // Scale is clamped at zero: a negative scale mirrors the layer, which is
      // never what a "smaller towards the end" ramp meant, and reads as clones
      // flipping inside out partway along.
      scaleX: Math.max(0, scale),
      scaleY: Math.max(0, scale),
      opacity: Math.max(0, Math.min(100, 100 + cfg.step.opacity * t * w)),
    });
  }
  return out;
}
