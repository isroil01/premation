/**
 * Particle system — a deterministic, closed-form emitter (AE's CC Particle World
 * / Particle Playground family). The whole simulation is a PURE function of
 * (config, time): particle i is born at `i / birthRate`, its randoms come from a
 * hash of `i`, and its position at any age is the closed-form ballistic solution
 * `p0 + v0·age + ½g·age²`. So there is no frame stepping, no accumulated state —
 * scrubbing to t=5s gives the exact same frame every time, and it's fully
 * unit-testable with no canvas.
 *
 * Motion comes from keyframing the config (birth rate, gravity, direction…),
 * exactly like the rest of the effect catalogue.
 */

import { parseColorChannels, channelsToColor } from '@core/effects/effects';
import type { SceneNode } from '@core/types';

/** "#rgb" / "#rrggbb" → 0..255 channels; anything else reads as mid grey. */
function parseHex(hex: string): [number, number, number] {
  const s = hex.trim();
  let m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) {
    const n = parseInt(m[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) {
    const t = m[1]!;
    return [parseInt(t[0]! + t[0]!, 16), parseInt(t[1]! + t[1]!, 16), parseInt(t[2]! + t[2]!, 16)];
  }
  return [128, 128, 128];
}

/** `sphere` is a 3D VOLUME: uniform in a ball of diameter `emitterWidth`, so z is born with it. */
export type EmitterType = 'point' | 'box' | 'circle' | 'sphere';
/** `sprite` draws `spriteSrc` (an image asset, optionally a horizontal sheet of `spriteFrames`). */
export type ParticleShape = 'circle' | 'square' | 'line' | 'star' | 'sprite';
export type ParticleBlend = 'normal' | 'add';
/** `ballistic` = closed-form (default). `stateful` = SimulationCache + floor bounce. */
export type ParticleSimMode = 'ballistic' | 'stateful';

export interface ParticleConfig {
  emitterType: EmitterType;
  /** Emitter extent in px (box: full width/height; circle: diameter). */
  emitterWidth: number;
  emitterHeight: number;
  /** Particles emitted per second. */
  birthRate: number;
  /** Hard cap on simultaneously-alive particles (performance guard). */
  maxParticles: number;
  /** Lifetime in seconds, ± lifetimeRandom. */
  lifetime: number;
  lifetimeRandom: number; // 0..1
  /** Initial speed px/s, ± speedRandom. */
  speed: number;
  speedRandom: number; // 0..1
  /** Emission direction in degrees (0 = +x / right, 90 = +y / down). */
  direction: number;
  /** Cone spread in degrees around `direction`. */
  spread: number;
  /** Constant acceleration px/s². */
  gravityX: number;
  gravityY: number;
  /** Particle self-rotation deg/s. */
  spin: number;
  /** Size px at birth → death. */
  sizeStart: number;
  sizeEnd: number;
  /** Colour at birth → death (#rrggbb). */
  colorStart: string;
  colorEnd: string;
  /** Opacity 0..1 at birth → death. */
  opacityStart: number;
  opacityEnd: number;
  shape: ParticleShape;
  blend: ParticleBlend;
  /** Randomisation seed — changing it reshuffles every particle. */
  seed: number;
  /**
   * Simulation mode. Default `ballistic` keeps the closed-form emitter.
   * `stateful` uses frame-stepping with floor bounce (seeded-replay scrub).
   */
  simMode?: ParticleSimMode;
  /** Floor Y in emitter-local px (positive down). Used when simMode=stateful. */
  bounceFloor?: number;
  /** Bounce restitution 0..1 when simMode=stateful. */
  bounceRestitution?: number;
  /** Air damping per frame 0..1 when simMode=stateful. 1 = none. */
  bounceDamping?: number;
  /** Constant wind acceleration px/s² — folds into the ballistic closed form
   *  exactly as gravity does, so scrubbing stays free. */
  windX?: number;
  windY?: number;
  /** Turbulence amplitude. Ballistic mode: max wander displacement in px.
   *  Stateful mode: curl-noise force in px/s². Zero = off, byte-identical to
   *  configs that predate the field. */
  turbulence?: number;
  /** Spatial scale of the stateful curl field, px per noise cell. */
  turbulenceScale?: number;
  /** How fast the field evolves (both modes). 1 = normal. */
  turbulenceSpeed?: number;
  /**
   * Trail ghost points per particle (0 = off, capped at 24). NOT keyframeable
   * on purpose, unlike the field params: in stateful mode the trail is part of
   * the simulation STATE, so animating its length would change the state shape
   * and reset the sim cache on every frame of the ramp.
   */
  trailLength?: number;
  /** Seconds between trail points. */
  trailSpacing?: number;
  /** Emitter z spread in px (particles born in ±depth/2). 0 = flat. */
  emitterDepth?: number;
  /** ± initial z velocity px/s, hashed per particle. */
  speedZ?: number;
  /**
   * Perspective focal length in px; 0 = off (z is simulated but not
   * projected). This is 2.5D ON PURPOSE: particles project through a focal
   * length inside the field texture — making them fully camera-aware would
   * mean rasterizing the field per camera, which is a renderer subsystem,
   * not a particle option. Since 2026-09-09 a 3D particle layer under a scene
   * camera takes that camera's focal length here automatically when this is
   * 0 (buildSnapshot), so depth parallax follows the comp lens; the field
   * card itself is still placed and projected like any 3D layer.
   */
  perspective?: number;
  /** Particle-particle collisions (stateful only — contact is history). */
  collide?: boolean;
  /** Velocity kept on particle-particle contact, 0..1. */
  collideRestitution?: number;
  /**
   * Spawn a child burst per particle. `death` works in BOTH modes — a
   * ballistic particle's death time is known in advance, so its children are
   * still a closed form. `bounce` needs the stateful sim: a bounce is history.
   * Children never sub-emit (one generation), or a firework would cascade
   * unbounded.
   */
  subEmit?: 'off' | 'death' | 'bounce' | 'continuous';
  /** Children per event, capped hard — each child is a live particle. */
  subCount?: number;
  /** Child launch speed px/s (full 360° spread). */
  subSpeed?: number;
  /** Child lifetime seconds. */
  subLifetime?: number;
  /** Child size as a fraction of the config's size ramp. */
  subSizeScale?: number;
  /**
   * `subEmit: 'continuous'` — children per second per LIVING parent (sparks
   * off a spark, smoke off an ember). Closed-form: child k of parent i is
   * born at `birth_i + k / subRate` at the parent's position then, and flies
   * on its own; the count is bounded by `maxParticles`.
   */
  subRate?: number;
  /**
   * Linear drag, 1/s. Folded into the closed form EXACTLY —
   * `p = p0 + (v0 − a/k)(1 − e^{−kt})/k + (a/k)·t` — so a dragged particle
   * scrubs as freely as a ballistic one. 0 = the pre-drag formula, bit for bit.
   */
  drag?: number;
  /**
   * Per-age curves: a MID-POINT between birth and death for size, opacity and
   * colour at normalised age `midAge` (default 0.5). Absent → the straight
   * two-point ramp, byte-identical to before. A 3-point ramp is what makes a
   * spark flare then die, or smoke bloom then thin.
   */
  sizeMid?: number;
  opacityMid?: number;
  colorMid?: string;
  midAge?: number;
  /**
   * Velocity streaks, 0..1: each sprite is drawn stretched along its own
   * closed-form velocity by `|v| · shutterSec · motionBlur`. The shutter
   * comes from the comp's motion-blur settings via `shutterSec` (buildSnapshot
   * writes it when the layer's motion-blur switch is on); 0 = off.
   */
  motionBlur?: number;
  shutterSec?: number;
  /** Sprite image source (an asset's `src`) for `shape: 'sprite'`; resolved from `spriteAssetId` at snapshot time. */
  spriteAssetId?: string;
  spriteSrc?: string;
  /** Horizontal sheet frame count (1 = a single image). */
  spriteFrames?: number;
  /** Frames per second through the sheet; 0 = index the sheet by AGE instead (birth = first, death = last). */
  spriteFps?: number;
  /**
   * Plexus over the live particles: link every pair closer than
   * `plexusDistance` (field px, after projection) with a line whose opacity
   * falls with distance, optionally filling mutually-close triples. Drawn
   * after the sprites by `drawPlexusLinks`; 0 distance = off.
   */
  plexusDistance?: number;
  plexusWidth?: number;
  /** 0..1. */
  plexusOpacity?: number;
  plexusColor?: string;
  plexusTriangles?: boolean;
  /** 0..1. */
  plexusTriangleOpacity?: number;
}

export interface Particle {
  /** Position in emitter-local px (emitter origin at 0,0). */
  x: number;
  y: number;
  size: number;
  /** Resolved `rgba(...)` colour including opacity. */
  color: string;
  opacity: number;
  /** Self-rotation in degrees. */
  rotation: number;
  /** Normalised age 0..1 (0 = just born). */
  age01: number;
  shape: ParticleShape;
  /** Depth in px, +z away from the viewer. Projected only when the config's
   *  `perspective` is on; always simulated so turning perspective on does not
   *  change trajectories, only their projection. */
  z: number;
  /**
   * Past positions, NEWEST FIRST, for the trail renderer. Absent when trails
   * are off, so pre-trail outputs compare byte-identical. Ballistic mode
   * evaluates its own closed form at trailing ages — exact and stateless;
   * stateful mode records real history, which is what lets a trail show the
   * path from BEFORE a bounce.
   */
  trail?: Array<{ x: number; y: number }>;
  /**
   * Stable identity across frames — the particle's BIRTH INDEX.
   *
   * The renderer never needs it: it paints whatever is alive at t and the
   * array is rebuilt every frame. The BAKE does, because "one layer per
   * particle" is a claim about a particle persisting through time, and without
   * an id the only thing linking frame f's list to frame f+1's is array
   * position — which shifts the moment one particle dies.
   *
   * Ballistic: the emission index `i` (children of a death burst carry
   * `-(parentIndex·977 + k) - 1`, negative so a child can never collide with a
   * parent index). Stateful: the slot's `id`, which the SoA already keeps.
   * Optional so every existing producer and consumer is untouched.
   */
  index?: number;
  /**
   * Closed-form velocity at this instant, px/s — what the velocity streak is
   * drawn along. Absent when streaks are off, so pre-streak outputs compare
   * byte-identical.
   */
  vx?: number;
  vy?: number;
  /** Sheet frame for `shape: 'sprite'` (0-based). */
  spriteFrame?: number;
}

export const DEFAULT_PARTICLE_CONFIG: ParticleConfig = {
  emitterType: 'point',
  emitterWidth: 40,
  emitterHeight: 40,
  birthRate: 80,
  // A CEILING, not a density: alive count is birthRate × lifetime (160 by
  // default), so this only binds when the user pushes birth rate past
  // ~2500/s. 5000 (was 1500) lets a Particular-style dense emitter actually
  // get dense before silently plateauing — the old cap kicked in at exactly
  // the settings people reach for in a snow/sparks comp, and read as
  // "birth rate stopped working". The sim is O(alive) per frame and 5000
  // simple sprites is well inside a frame budget on the Canvas2D path.
  maxParticles: 5000,
  lifetime: 2,
  lifetimeRandom: 0.35,
  speed: 180,
  speedRandom: 0.4,
  direction: -90, // upward fountain by default
  spread: 45,
  gravityX: 0,
  gravityY: 220,
  spin: 0,
  sizeStart: 10,
  sizeEnd: 2,
  colorStart: '#ffd166',
  colorEnd: '#ff3d6e',
  opacityStart: 1,
  opacityEnd: 0,
  shape: 'circle',
  blend: 'add',
  seed: 1,
  simMode: 'ballistic',
  bounceFloor: 160,
  bounceRestitution: 0.65,
  bounceDamping: 0.998,
  windX: 0,
  windY: 0,
  turbulence: 0,
  turbulenceScale: 100,
  turbulenceSpeed: 1,
  trailLength: 0,
  trailSpacing: 1 / 30,
  emitterDepth: 0,
  speedZ: 0,
  perspective: 0,
  collide: false,
  collideRestitution: 0.7,
  subEmit: 'off',
  subCount: 8,
  subSpeed: 120,
  subLifetime: 0.6,
  subSizeScale: 0.5,
  subRate: 10,
  drag: 0,
  midAge: 0.5,
  motionBlur: 0,
  spriteFrames: 1,
  spriteFps: 0,
  plexusDistance: 0,
  plexusWidth: 1,
  plexusOpacity: 0.6,
  plexusColor: '#9fd0ff',
  plexusTriangles: false,
  plexusTriangleOpacity: 0.15,
};

/** Read a node's particle config off its `fx` component, filling in every
 *  default so an old/partial config still simulates. Returns null when the node
 *  is not a particle emitter. */
export function readNodeParticle(node: SceneNode): ParticleConfig | null {
  const fx = node.components.find((c) => c.type === 'fx');
  const raw = fx?.props.particle;
  if (!raw || typeof raw !== 'object') return null;
  return { ...DEFAULT_PARTICLE_CONFIG, ...(raw as Partial<ParticleConfig>) };
}

/** The numeric config fields that keyframe under `particle.<key>` tracks. */
export const PARTICLE_NUMERIC_KEYS = [
  'emitterWidth', 'emitterHeight', 'birthRate', 'lifetime', 'lifetimeRandom',
  'speed', 'speedRandom', 'direction', 'spread', 'gravityX', 'gravityY',
  'spin', 'sizeStart', 'sizeEnd', 'opacityStart', 'opacityEnd',
  // The field params. Being in this list is what makes them KEYFRAMEABLE —
  // `resolveParticleConfig` samples `particle.<key>` generically, so a wind
  // that rises over the shot needs nothing beyond this entry.
  'windX', 'windY', 'turbulence', 'turbulenceScale', 'turbulenceSpeed',
  'emitterDepth', 'speedZ', 'perspective',
  // Particles v2 (2026-09-09): drag, the mid-point curves, continuous
  // sub-emission rate and the streak amount are all keyframeable numbers.
  'drag', 'sizeMid', 'opacityMid', 'midAge', 'subRate', 'motionBlur',
  'plexusDistance', 'plexusWidth', 'plexusOpacity', 'plexusTriangleOpacity',
] as const;
export type ParticleNumericKey = (typeof PARTICLE_NUMERIC_KEYS)[number];

/** The color config fields — keyframed via decomposed channel tracks
 *  (`particle.colorStart_r` …), the same pattern effect colors use. */
export const PARTICLE_COLOR_KEYS = ['colorStart', 'colorEnd', 'colorMid'] as const;
export type ParticleColorKey = (typeof PARTICLE_COLOR_KEYS)[number];

/** Animation prop-path for a particle config field (`particle.birthRate`). */
export function particlePropPath(key: string): string {
  return `particle.${key}`;
}

/**
 * Resolve the config's animated values at the current frame: every numeric
 * field samples its `particle.<key>` track, colors recompose from channel
 * tracks. Pure — the snapshot layer supplies `sample`. Falls through to the
 * stored static value per field, so a partially-keyframed config behaves.
 *
 * Note on `birthRate`: particle birth times derive from the CURRENT rate
 * (`i / rate`), so keyframing it re-times existing particles rather than
 * changing only the emission going forward — acceptable for ramps, but not a
 * per-particle-accurate emission integral.
 */
export function resolveParticleConfig(
  cfg: ParticleConfig,
  sample: (propPath: string) => number | undefined,
): ParticleConfig {
  let out: ParticleConfig | null = null;
  const touch = (): ParticleConfig => (out ??= { ...cfg });

  for (const key of PARTICLE_NUMERIC_KEYS) {
    const v = sample(particlePropPath(key));
    if (v !== undefined) touch()[key] = v;
  }
  for (const key of PARTICLE_COLOR_KEYS) {
    const r = sample(particlePropPath(`${key}_r`));
    const g = sample(particlePropPath(`${key}_g`));
    const b = sample(particlePropPath(`${key}_b`));
    const a = sample(particlePropPath(`${key}_a`));
    if (r !== undefined || g !== undefined || b !== undefined || a !== undefined) {
      // The mid colour is optional; an animated track on an unset one starts
      // from the start colour rather than from nothing.
      const base = parseColorChannels(cfg[key] ?? cfg.colorStart);
      touch()[key] = channelsToColor(r ?? base[0], g ?? base[1], b ?? base[2], a ?? base[3]);
    }
  }
  return out ?? cfg;
}

/** Deterministic hash of (index, salt, seed) → [0,1). */
function hash01(i: number, salt: number, seed: number): number {
  let n = (i | 0) * 374761393 + (salt | 0) * 668265263 + (seed | 0) * 2246822519;
  n = (n ^ (n >>> 13)) * 1274126177;
  n = n ^ (n >>> 16);
  return (n >>> 0) / 4294967296;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Lerp two `#rrggbb` colours at `t` → `rgba(r,g,b,a)`. */
function lerpColor(a: string, b: string, t: number, alpha: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  const r = Math.round(lerp(ca[0], cb[0], t));
  const g = Math.round(lerp(ca[1], cb[1], t));
  const bl = Math.round(lerp(ca[2], cb[2], t));
  const al = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
  return `rgba(${r},${g},${bl},${al})`;
}

// ── Particles v2: the closed forms the sim, the bursts and the trails share ──

/**
 * A 3-point ramp over normalised age: `start` → `mid` at `midAge` → `end`.
 * With no `mid` it is the plain two-point lerp, so configs that predate the
 * curves render byte-identically.
 */
export function rampAt(start: number, end: number, age01: number, mid: number | undefined, midAge: number): number {
  if (mid === undefined) return lerp(start, end, age01);
  const m = Math.min(0.999, Math.max(0.001, midAge));
  return age01 <= m ? lerp(start, mid, age01 / m) : lerp(mid, end, (age01 - m) / (1 - m));
}

/** The colour ramp with the same optional mid-point. */
export function colorRampAt(cfg: ParticleConfig, age01: number, alpha: number): string {
  const mid = cfg.colorMid;
  if (!mid) return lerpColor(cfg.colorStart, cfg.colorEnd, age01, alpha);
  const m = Math.min(0.999, Math.max(0.001, cfg.midAge ?? 0.5));
  return age01 <= m
    ? lerpColor(cfg.colorStart, mid, age01 / m, alpha)
    : lerpColor(mid, cfg.colorEnd, (age01 - m) / (1 - m), alpha);
}

/**
 * Position and velocity after `t` seconds from `o` with initial velocity
 * `v0`, constant acceleration `a` and linear drag `k` (1/s). The exact
 * solution of `v' = a − k·v`:
 *   v(t) = a/k + (v0 − a/k)·e^{−kt}
 *   p(t) = o + (a/k)·t + (v0 − a/k)·(1 − e^{−kt})/k
 * and, at k = 0, the ballistic `o + v0·t + ½·a·t²` — reached by the SAME
 * code path (the k→0 limit is taken literally), so drag-free configs are
 * bit-identical to the pre-drag sim.
 */
export function flightAt(
  ox: number, oy: number, v0x: number, v0y: number, ax: number, ay: number, t: number, k: number,
): { x: number; y: number; vx: number; vy: number } {
  if (!(k > 1e-6)) {
    return { x: ox + v0x * t + 0.5 * ax * t * t, y: oy + v0y * t + 0.5 * ay * t * t, vx: v0x + ax * t, vy: v0y + ay * t };
  }
  const e = Math.exp(-k * t);
  const s = (1 - e) / k;
  const tx = ax / k; const ty = ay / k;
  return {
    x: ox + tx * t + (v0x - tx) * s,
    y: oy + ty * t + (v0y - ty) * s,
    vx: tx + (v0x - tx) * e,
    vy: ty + (v0y - ty) * e,
  };
}

/** Where particle `i` is born: point, box, disc or ball (the ball has depth). */
export function emitterOrigin(
  cfg: ParticleConfig, i: number, seed: number,
  /** The caller's hash — the stateful sim has its own recipe, and its box/disc origins must not move. */
  h: (i: number, salt: number, seed: number) => number = hash01,
): { x: number; y: number; z: number } {
  let ox = 0; let oy = 0; let oz = 0;
  if (cfg.emitterType === 'box') {
    ox = (h(i, 4, seed) - 0.5) * cfg.emitterWidth;
    oy = (h(i, 5, seed) - 0.5) * cfg.emitterHeight;
  } else if (cfg.emitterType === 'circle') {
    const ang = h(i, 4, seed) * Math.PI * 2;
    const rad = Math.sqrt(h(i, 5, seed)) * (cfg.emitterWidth / 2);
    ox = Math.cos(ang) * rad;
    oy = Math.sin(ang) * rad;
  } else if (cfg.emitterType === 'sphere') {
    // Uniform in the ball: cube-root radius, cosine-uniform latitude.
    const ang = h(i, 4, seed) * Math.PI * 2;
    const cosLat = h(i, 9, seed) * 2 - 1;
    const sinLat = Math.sqrt(Math.max(0, 1 - cosLat * cosLat));
    const rad = Math.cbrt(h(i, 5, seed)) * (cfg.emitterWidth / 2);
    ox = Math.cos(ang) * sinLat * rad;
    oy = Math.sin(ang) * sinLat * rad;
    oz = cosLat * rad;
  }
  // The flat emitters' depth spread stays what it was; the ball adds its own.
  oz += (h(i, 6, seed) - 0.5) * (cfg.emitterDepth ?? 0);
  return { x: ox, y: oy, z: oz };
}
