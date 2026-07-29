/**
 * TRANSITIONS and BACKGROUNDS — presets whose payload is an EFFECT stack.
 *
 * Everything else in the library animates properties a layer already has.
 * These install an effect and then keyframe its parameters, which is a third
 * shape of preset alongside keyframed tracks and behaviours, and the reason
 * `AnimationPreset.effects` exists.
 *
 * ── Why transitions are single-layer here ──────────────────────────
 *
 * In an NLE a transition is a relationship BETWEEN two clips. This editor has
 * no clip-adjacency model, so a two-clip transition has nothing to attach to.
 * What it does have is per-layer effects and a stack order, so these are
 * authored as single-layer wipes and dissolves: apply the "out" half to the
 * outgoing layer and the "in" half to the incoming one, and the crossover is
 * the stack. That is honest about the mechanism rather than pretending an
 * adjacency exists — and it is also how AE's own Transition presets work, since
 * they too are per-layer effects and not clip relationships.
 *
 * ── Backgrounds are full-frame generators ──────────────────────────
 *
 * A background preset expects to be applied to a solid or a full-comp shape:
 * the effect generates the pixels, so the layer's own fill is irrelevant. They
 * animate slowly and loop-ish, because a background that resolves and stops is
 * a background that draws attention to itself.
 *
 * Effect ids are the preset's own namespace (`fx0`) and are rewritten on apply;
 * see `installEffects` / `remapEffectTracks`.
 */

import type { Keyframe } from '@motion/animation';
import type { AnimationPreset, PresetTrack } from './animationPresets';

/** Even, symmetric — a wipe should not favour either end of its travel. */
const EVEN: [number, number, number, number] = [0.65, 0, 0.35, 1];
/** Soft start, decisive finish. */
const LEAVE: [number, number, number, number] = [0.4, 0, 0.9, 0.4];

const kfb = (t: number, value: number, bezier?: [number, number, number, number]): Keyframe => ({
  t,
  value,
  ...(bezier ? { easing: 'bezier' as const, bezier } : {}),
});

const TRANSITIONS = 'Transitions';
const BACKGROUNDS = 'Backgrounds';

interface ScenerySpec {
  name: string;
  folder: string;
  description: string;
  effects: NonNullable<AnimationPreset['effects']>;
  tracks: PresetTrack[];
}

const scenery = (s: ScenerySpec): AnimationPreset => ({
  name: s.name,
  builtin: true,
  folder: s.folder,
  category: s.folder,
  description: s.description,
  requires: 'any',
  effects: s.effects,
  tracks: s.tracks,
});

/** A wipe, parameterised by angle and direction. The mechanism is identical
 *  across all four, so they are generated rather than copy-pasted — the only
 *  thing that differs is which way the edge travels. */
function wipe(
  name: string,
  description: string,
  angle: number,
  dir: 'in' | 'out',
  feather: number,
): AnimationPreset {
  return scenery({
    name,
    folder: TRANSITIONS,
    description,
    effects: [{ id: 'fx0', type: 'linear-wipe', params: { wipeAngle: angle, feather } }],
    tracks: [
      {
        prop: 'effect.fx0.completion',
        keyframes:
          dir === 'in'
            ? [kfb(0, 100, EVEN), kfb(0.8, 0)]
            : [kfb(0, 0, EVEN), kfb(0.8, 100)],
      },
      // Feather scales with the frame: a 40px soft edge is a broad gradient at
      // 720p and a hairline at 4K.
      { prop: 'effect.fx0.feather', unit: 'compMin', keyframes: [kfb(0, feather / 1080)] },
    ],
  });
}

export const SCENERY_PRESETS: ReadonlyArray<AnimationPreset> = [
  // ── Transitions ───────────────────────────────────────────────────
  wipe('Wipe In', 'A hard-edged wipe reveals the layer left to right.', 90, 'in', 0),
  wipe('Wipe Out', 'A hard-edged wipe clears the layer left to right.', 90, 'out', 0),
  wipe('Soft Wipe In', 'A wide feathered edge sweeps the layer in — a gradient wipe, not a hard line.', 90, 'in', 120),
  wipe('Diagonal Wipe Out', 'A feathered edge clears the layer on the diagonal.', 45, 'out', 60),

  scenery({
    name: 'Dissolve In',
    folder: TRANSITIONS,
    description: 'Resolves out of noise rather than simply fading — grain thins as opacity rises.',
    // Distinct from a plain opacity fade, which the Entrances folder already
    // has: the noise scale collapsing is what makes it read as a dissolve.
    effects: [{ id: 'fx0', type: 'noise', params: { amount: 100, monochrome: true } }],
    tracks: [
      { prop: 'effect.fx0.amount', keyframes: [kfb(0, 100, EVEN), kfb(0.9, 0)] },
      { prop: 'opacity', keyframes: [kfb(0, 0, EVEN), kfb(0.9, 100)] },
    ],
  }),

  scenery({
    name: 'Blur Dissolve Out',
    folder: TRANSITIONS,
    description: 'Defocuses into nothing — the layer leaves by losing definition, not by sliding.',
    effects: [{ id: 'fx0', type: 'blur', params: { amount: 0 } }],
    tracks: [
      { prop: 'effect.fx0.amount', unit: 'compMin', keyframes: [kfb(0, 0, LEAVE), kfb(0.9, 0.05)] },
      { prop: 'opacity', keyframes: [kfb(0.2, 100, LEAVE), kfb(0.9, 0)] },
    ],
  }),

  // ── Backgrounds ───────────────────────────────────────────────────
  scenery({
    name: 'Gradient Drift',
    folder: BACKGROUNDS,
    description: 'A two-colour ramp whose angle rotates slowly. Apply to a solid.',
    effects: [
      { id: 'fx0', type: 'gradient-ramp', params: { colorA: '#1b2a6b', colorB: '#c2417a', blend: 100 } },
    ],
    tracks: [{ prop: 'effect.fx0.angle', keyframes: [kfb(0, 0), kfb(12, 360)] }],
  }),

  scenery({
    name: 'Aurora',
    folder: BACKGROUNDS,
    description: 'Four colours bleeding into each other, breathing. Apply to a solid.',
    effects: [
      {
        id: 'fx0',
        type: 'four-color-gradient',
        params: {
          colorTL: '#0f2557', colorTR: '#1f8a8c',
          colorBL: '#6b2d8f', colorBR: '#e05a8a', blend: 100,
        },
      },
    ],
    // Only the blend animates: moving the colours would fight the effect's own
    // interpolation and read as strobing rather than as drift.
    tracks: [
      { prop: 'effect.fx0.blend', keyframes: [kfb(0, 70, EVEN), kfb(5, 100, EVEN), kfb(10, 70)] },
    ],
  }),

  scenery({
    name: 'Drifting Noise',
    folder: BACKGROUNDS,
    description: 'Slow organic fractal texture — a film-grain-ish bed rather than a flat colour.',
    effects: [{ id: 'fx0', type: 'fractal-noise', params: { scale: 10 } }],
    tracks: [{ prop: 'effect.fx0.scale', keyframes: [kfb(0, 8, EVEN), kfb(8, 16, EVEN), kfb(16, 8)] }],
  }),
];

export default SCENERY_PRESETS;
