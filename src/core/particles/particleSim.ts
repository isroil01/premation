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

import { parseHex } from '@core/effects/canvas2dEffects';
import { wanderOffset } from './particleField';
import { parseColorChannels, channelsToColor } from '@core/effects/effects';
import type { SceneNode } from '@core/types';

export type EmitterType = 'point' | 'box' | 'circle';
export type ParticleShape = 'circle' | 'square' | 'line' | 'star';
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
}

export const DEFAULT_PARTICLE_CONFIG: ParticleConfig = {
  emitterType: 'point',
  emitterWidth: 40,
  emitterHeight: 40,
  birthRate: 80,
  maxParticles: 1500,
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
] as const;
export type ParticleNumericKey = (typeof PARTICLE_NUMERIC_KEYS)[number];

/** The color config fields — keyframed via decomposed channel tracks
 *  (`particle.colorStart_r` …), the same pattern effect colors use. */
export const PARTICLE_COLOR_KEYS = ['colorStart', 'colorEnd'] as const;
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
      const base = parseColorChannels(cfg[key]);
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

/**
 * All particles alive at `time` (seconds), in emitter-local space. Newest last.
 * Capped at `maxParticles` (keeps the youngest — AE drops the oldest overflow).
 */
export function simulateParticles(cfg: ParticleConfig, time: number): Particle[] {
  const rate = cfg.birthRate;
  if (rate <= 0 || time <= 0) return [];

  const maxLife = Math.max(0.05, cfg.lifetime * (1 + Math.max(0, cfg.lifetimeRandom)));
  let iStart = Math.max(0, Math.ceil((time - maxLife) * rate));
  const iEnd = Math.floor(time * rate);
  if (iEnd - iStart > cfg.maxParticles) iStart = iEnd - cfg.maxParticles;

  const out: Particle[] = [];
  const seed = cfg.seed | 0;
  const dirBase = (cfg.direction * Math.PI) / 180;
  const spreadRad = (cfg.spread * Math.PI) / 180;

  for (let i = iStart; i <= iEnd; i++) {
    const birth = i / rate;
    const age = time - birth;
    if (age < 0) continue;

    const life = Math.max(
      0.05,
      cfg.lifetime * (1 + cfg.lifetimeRandom * (hash01(i, 1, seed) * 2 - 1)),
    );
    if (age >= life) continue;
    const age01 = age / life;

    const speed = cfg.speed * (1 + cfg.speedRandom * (hash01(i, 2, seed) * 2 - 1));
    const dir = dirBase + spreadRad * (hash01(i, 3, seed) - 0.5);
    const v0x = Math.cos(dir) * speed;
    const v0y = Math.sin(dir) * speed;

    // Emitter origin sample.
    let ox = 0;
    let oy = 0;
    if (cfg.emitterType === 'box') {
      ox = (hash01(i, 4, seed) - 0.5) * cfg.emitterWidth;
      oy = (hash01(i, 5, seed) - 0.5) * cfg.emitterHeight;
    } else if (cfg.emitterType === 'circle') {
      const ang = hash01(i, 4, seed) * Math.PI * 2;
      const rad = Math.sqrt(hash01(i, 5, seed)) * (cfg.emitterWidth / 2);
      ox = Math.cos(ang) * rad;
      oy = Math.sin(ang) * rad;
    }

    // Wind is just more constant acceleration, so it lives inside the same
    // closed form as gravity — scrubbing stays free. Turbulence is a seeded
    // wander displacement, zero at birth (see particleField.ts).
    const ax = cfg.gravityX + (cfg.windX ?? 0);
    const ay = cfg.gravityY + (cfg.windY ?? 0);
    const wander = wanderOffset(i, age, cfg);
    const x = ox + v0x * age + 0.5 * ax * age * age + wander.x;
    const y = oy + v0y * age + 0.5 * ay * age * age + wander.y;
    const size = Math.max(0, lerp(cfg.sizeStart, cfg.sizeEnd, age01));
    const opacity = lerp(cfg.opacityStart, cfg.opacityEnd, age01);
    const rotation = cfg.spin * age;

    out.push({
      x,
      y,
      size,
      color: lerpColor(cfg.colorStart, cfg.colorEnd, age01, opacity),
      opacity,
      rotation,
      age01,
      shape: cfg.shape,
    });
  }

  return out;
}
