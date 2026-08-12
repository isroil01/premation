/**
 * LOOKS and round-four TRANSITIONS — presets whose payload is an effect stack
 * built from the fifty effects added in round four.
 *
 * Same shape as `sceneryPresets.ts` and for the same reasons: the preset
 * installs effects under its own `fx*` namespace and keyframes their params
 * through `effect.<id>.<param>` tracks, and both are rewritten on apply so
 * applying to a layer that already has effects cannot collide.
 *
 * ## Why a LOOKS folder rather than more Backgrounds
 *
 * A background generates pixels; a look GRADES pixels that are already there.
 * They are applied to different layers by different people at different points
 * in a project, so filing them together would make both harder to find. The
 * looks here are all static grades — no keyframes — which is deliberate: a
 * grade that animates on its own fights the shot. They are starting points to
 * be dialled, which is exactly what AE's own Looks presets are.
 *
 * ## Why the transitions here keyframe `completion` and nothing else
 *
 * Round four's wipes take completion 0→100 meaning "how much is gone", matching
 * every wipe already in the tree. Keeping the animated parameter to that one
 * control is what lets an editor retime a transition by dragging two keyframes
 * instead of unpicking a rig.
 *
 * One thing deliberately NOT used here: `strobe-light`. It is the only round-four
 * effect bound to the clock, so it opts its layer out of raster caching. A
 * preset that shipped it by default would quietly make every layer it touched
 * re-bake every frame. It stays available in the effects browser, where the
 * cost is a choice someone makes knowingly.
 */

import type { Keyframe } from '@motion/animation';
import type { AnimationPreset, PresetTrack } from './animationPresets';

/** Even, symmetric — a wipe should not favour either end of its travel. */
const EVEN: [number, number, number, number] = [0.65, 0, 0.35, 1];
/** Soft start, decisive finish. */
const LEAVE: [number, number, number, number] = [0.4, 0, 0.9, 0.4];
/** Snappy settle, for anything that should feel mechanical rather than floaty. */
const SNAP: [number, number, number, number] = [0.16, 1, 0.3, 1];

const kfb = (t: number, value: number, bezier?: [number, number, number, number]): Keyframe => ({
  t,
  value,
  ...(bezier ? { easing: 'bezier' as const, bezier } : {}),
});

const LOOKS = 'Looks';
const TRANSITIONS = 'Transitions';
const STYLIZE = 'Stylize';

interface Spec {
  name: string;
  folder: string;
  description: string;
  effects: NonNullable<AnimationPreset['effects']>;
  tracks?: PresetTrack[];
}

const preset = (s: Spec): AnimationPreset => ({
  name: s.name,
  builtin: true,
  folder: s.folder,
  category: s.folder,
  description: s.description,
  requires: 'any',
  effects: s.effects,
  // A look is a stack with no animation. `tracks` is required by the interface,
  // so it is an empty list rather than optional — which also means `minTime`
  // and the offset maths below treat it as zero-length and anchor it at the
  // playhead without shifting anything.
  tracks: s.tracks ?? [],
});

export const FILM_LOOK_PRESETS: ReadonlyArray<AnimationPreset> = [
  // ══ Looks — static grades ═════════════════════════════════════════
  preset({
    name: 'Teal & Orange',
    folder: LOOKS,
    description: 'The blockbuster grade — cool shadows, warm skin, gentle corner falloff.',
    effects: [
      // Toner does the split-tone in one pass because it maps by LUMINANCE:
      // shadows go teal and highlights go warm without touching the midtones
      // where skin lives. Two Tints could not express that.
      {
        id: 'fx0',
        type: 'toner',
        params: {
          blackTone: '#04131a', shadowTone: '#0e3c4a', midTone: '#8a7f70',
          highlightTone: '#f0c9a0', whiteTone: '#fff6ec', blend: 35,
        },
      },
      { id: 'fx1', type: 'vignette', params: { amount: 38, size: 62, feather: 75, roundness: 30 } },
    ],
  }),

  preset({
    name: 'Bleach Bypass',
    folder: LOOKS,
    description: 'Silver-retention look — crushed contrast, drained colour, hot highlights.',
    effects: [
      { id: 'fx0', type: 'auto-contrast', params: { blackClip: 0.5, whiteClip: 0.2, blend: 20 } },
      // Leave Color with a tolerance wide enough to catch nothing in
      // particular is the cheapest global desaturate that still keeps a hint
      // of the dominant hue, which is what separates bleach bypass from mono.
      { id: 'fx1', type: 'leave-color', params: { targetColor: '#c08050', tolerance: 30, softness: 70, amount: 65 } },
      { id: 'fx2', type: 'vignette', params: { amount: 25, size: 70, feather: 90, roundness: 0 } },
    ],
  }),

  preset({
    name: 'Faded Film',
    folder: LOOKS,
    description: 'Lifted blacks and milky highlights — the look of a print left in the sun.',
    effects: [
      {
        id: 'fx0',
        type: 'toner',
        params: {
          // Black stop lifted well off zero IS the effect: faded stock has no
          // true black left in it.
          blackTone: '#2b2a33', shadowTone: '#4a4650', midTone: '#8f8880',
          highlightTone: '#ddd2c0', whiteTone: '#f2ece0', blend: 25,
        },
      },
      { id: 'fx1', type: 'noise-alpha', params: { amount: 6, uniformNoise: false, seed: 4, clipResult: true } },
    ],
  }),

  preset({
    name: 'Night Grade',
    folder: LOOKS,
    description: 'Day-for-night — cool, dim, contrast pulled into the shadows.',
    effects: [
      {
        id: 'fx0',
        type: 'toner',
        params: {
          blackTone: '#01040c', shadowTone: '#0a1630', midTone: '#28405f',
          highlightTone: '#6f88ab', whiteTone: '#b9c9de', blend: 15,
        },
      },
      { id: 'fx1', type: 'vignette', params: { amount: 55, size: 45, feather: 85, roundness: 20 } },
    ],
  }),

  preset({
    name: 'Cross Process',
    folder: LOOKS,
    description: 'C-41 in E-6 chemistry — hue-twisted midtones and a hard contrast curve.',
    effects: [
      // Equalize in RGB mode is the honest way to get the cross-process twist:
      // per-channel equalization moves the channels by different amounts, and
      // that hue shift IS the look rather than a side effect to be corrected.
      { id: 'fx0', type: 'equalize', params: { equalizeMode: 0, amount: 45, blend: 30 } },
      { id: 'fx1', type: 'change-color', params: { targetColor: '#3aa0d0', hueTolerance: 22, satTolerance: 80, lightTolerance: 80, softness: 60, hueShift: -25, satScale: 35, lightScale: 0 } },
    ],
  }),

  preset({
    name: 'Selective Colour Pop',
    folder: LOOKS,
    description: 'One hue stays saturated, everything else goes monochrome.',
    effects: [
      { id: 'fx0', type: 'leave-color', params: { targetColor: '#d32020', tolerance: 14, softness: 45, amount: 100 } },
      { id: 'fx1', type: 'auto-contrast', params: { blackClip: 0.2, whiteClip: 0.2, blend: 40 } },
    ],
  }),

  preset({
    name: 'Anamorphic Bokeh',
    folder: LOOKS,
    description: 'Shallow depth with a bladed iris — highlights bloom into hexagons.',
    effects: [
      // Blades + gain together are what make this read as a lens rather than a
      // blur: the polygon shapes the highlight, the gain lets it survive being
      // averaged. Either alone looks like a smear.
      { id: 'fx0', type: 'camera-lens-blur', params: { radius: 9, blades: 6, irisRotation: 15, gain: 4, highlightThreshold: 62 } },
      { id: 'fx1', type: 'vignette', params: { amount: 30, size: 60, feather: 80, roundness: 100 } },
    ],
  }),

  preset({
    name: 'Clean Skin',
    folder: LOOKS,
    description: 'Edge-preserving smoothing — texture goes, features stay sharp.',
    effects: [
      // Bilateral rather than any Gaussian: the whole point is that eyes and
      // hairline survive at a radius that would otherwise destroy them.
      { id: 'fx0', type: 'bilateral-blur', params: { radius: 7, colorSigma: 26, preserveAlpha: true } },
      { id: 'fx1', type: 'unsharp-mask', params: { amount: 40, radius: 1.5, threshold: 12 } },
    ],
  }),

  preset({
    name: 'Restore Old Footage',
    folder: LOOKS,
    description: 'Removes specks and scratches, then re-levels the contrast.',
    effects: [
      // Threshold well above zero is what makes this different from a Median:
      // specks go, grain and texture stay.
      { id: 'fx0', type: 'dust-scratches', params: { radius: 2, threshold: 28 } },
      { id: 'fx1', type: 'auto-levels', params: { blackClip: 0.3, whiteClip: 0.3, blend: 25 } },
    ],
  }),

  // ══ Stylize — static, but not grades ══════════════════════════════
  preset({
    name: 'Comic Book',
    folder: STYLIZE,
    description: 'Flat cel shading with inked edges over a rotated dot screen.',
    effects: [
      { id: 'fx0', type: 'cartoon', params: { smoothness: 3, levels: 5, edgeThreshold: 22, edgeWidth: 1, edgeOpacity: 100 } },
      // Screened at 15°, not 0 — an axis-aligned screen moirés against the
      // cartoon's own flat bands.
      { id: 'fx1', type: 'halftone', params: { cellSize: 5, screenAngle: 15, contrast: 120, colorize: true, blendWithOriginal: 45 } },
    ],
  }),

  preset({
    name: 'Newsprint',
    folder: STYLIZE,
    description: 'Coarse black-and-white halftone on off-white paper.',
    effects: [
      { id: 'fx0', type: 'halftone', params: { cellSize: 7, screenAngle: 45, contrast: 140, inkColor: '#141210', paperColor: '#efe9dc', colorize: false, blendWithOriginal: 0 } },
    ],
  }),

  preset({
    name: 'Oil Painting',
    folder: STYLIZE,
    description: 'Directional brushwork with the palette flattened behind it.',
    effects: [
      { id: 'fx0', type: 'smart-blur', params: { radius: 6, threshold: 30, mode: 0 } },
      { id: 'fx1', type: 'brush-strokes', params: { strokeAngle: 38, strokeLength: 9, randomness: 55, cellSize: 14, density: 85 } },
    ],
  }),

  preset({
    name: 'Kaleidoscope Mandala',
    folder: STYLIZE,
    description: 'Eight mirrored wedges, slowly rotating.',
    effects: [
      { id: 'fx0', type: 'kaleidoscope', params: { segments: 8, zoom: 130 } },
    ],
    tracks: [
      // The rotation is the animation; the fold is static. Keyframed rather
      // than clock-bound so it retimes with the layer.
      { prop: 'effect.fx0.rotation', keyframes: [kfb(0, 0), kfb(8, 360)] },
    ],
  }),

  preset({
    name: 'Chromatic Lens',
    folder: STYLIZE,
    description: 'Barrel distortion with a bladed defocus — a cheap-glass look.',
    effects: [
      { id: 'fx0', type: 'warp', params: { style: 4, bend: 22, warpAxis: 0 } },
      { id: 'fx1', type: 'camera-lens-blur', params: { radius: 4, blades: 5, gain: 2.5, highlightThreshold: 70 } },
      { id: 'fx2', type: 'vignette', params: { amount: 45, size: 55, feather: 70, roundness: 100 } },
    ],
  }),

  preset({
    name: 'Broadcast Interference',
    folder: STYLIZE,
    description: 'Rolling-shutter skew and torn coverage — a signal losing lock.',
    effects: [
      { id: 'fx0', type: 'rolling-shutter', params: { sweep: 18, wobble: 9, scanDirection: 0 } },
      { id: 'fx1', type: 'noise-alpha', params: { amount: 22, uniformNoise: true, seed: 11, clipResult: true } },
    ],
    tracks: [
      // Both the skew and the noise field are driven by keyframes rather than
      // by the clock, so the glitch lands where the editor puts it.
      { prop: 'effect.fx0.sweep', keyframes: [kfb(0, 0, SNAP), kfb(0.12, 34, SNAP), kfb(0.3, 0)] },
      { prop: 'effect.fx1.noisePhase', keyframes: [kfb(0, 0), kfb(0.3, 12)] },
    ],
  }),

  // ══ Transitions ═══════════════════════════════════════════════════
  preset({
    name: 'Iris In',
    folder: TRANSITIONS,
    description: 'A circular aperture opens from the centre.',
    effects: [{ id: 'fx0', type: 'iris-wipe', params: { irisPoints: 0, feather: 3 } }],
    tracks: [{ prop: 'effect.fx0.completion', keyframes: [kfb(0, 100, EVEN), kfb(0.7, 0)] }],
  }),

  preset({
    name: 'Hex Iris Out',
    folder: TRANSITIONS,
    description: 'A six-sided aperture closes the frame down.',
    effects: [{ id: 'fx0', type: 'iris-wipe', params: { irisPoints: 6, rotation: 15, feather: 2 } }],
    tracks: [{ prop: 'effect.fx0.completion', keyframes: [kfb(0, 0, LEAVE), kfb(0.7, 100)] }],
  }),

  preset({
    name: 'Light Wipe In',
    folder: TRANSITIONS,
    description: 'A glowing edge sweeps across and leaves the layer behind it.',
    effects: [
      { id: 'fx0', type: 'light-wipe', params: { wipeShape: 0, angle: 0, lightWidth: 90, lightColor: '#ffffff', intensity: 85, feather: 3 } },
    ],
    tracks: [{ prop: 'effect.fx0.completion', keyframes: [kfb(0, 100, EVEN), kfb(0.9, 0)] }],
  }),

  preset({
    name: 'Grid Dissolve Out',
    folder: TRANSITIONS,
    description: 'The frame breaks into tiles that open from their own centres.',
    effects: [
      { id: 'fx0', type: 'grid-wipe', params: { columns: 14, rows: 9, tileShape: 2, randomSeed: 55, feather: 8 } },
    ],
    tracks: [{ prop: 'effect.fx0.completion', keyframes: [kfb(0, 0, EVEN), kfb(1.0, 100)] }],
  }),

  preset({
    name: 'Line Sweep Out',
    folder: TRANSITIONS,
    description: 'Parallel lines clear in sequence — a travelling comb.',
    effects: [
      { id: 'fx0', type: 'line-sweep', params: { lineCount: 28, angle: 0, stagger: 65, feather: 3 } },
    ],
    tracks: [{ prop: 'effect.fx0.completion', keyframes: [kfb(0, 0, EVEN), kfb(0.9, 100)] }],
  }),

  preset({
    name: 'Burn Away',
    folder: TRANSITIONS,
    description: 'The frame chars and blows out from a point, like film in the gate.',
    effects: [
      { id: 'fx0', type: 'burn-film', params: { burn: 0, burnColor: '#fff6e0', charColor: '#3d1f0a', randomness: 65, seed: 3 } },
    ],
    tracks: [{ prop: 'effect.fx0.burn', keyframes: [kfb(0, 0, LEAVE), kfb(1.1, 100)] }],
  }),

  preset({
    name: 'Page Turn Out',
    folder: TRANSITIONS,
    description: 'The layer peels back over a curl and lifts away.',
    effects: [
      { id: 'fx0', type: 'page-turn', params: { angle: 45, curlRadius: 70, backOpacity: 55, shading: 60 } },
    ],
    tracks: [{ prop: 'effect.fx0.amount', keyframes: [kfb(0, 0, EVEN), kfb(1.0, 100)] }],
  }),

  preset({
    name: 'Ripple Through',
    folder: TRANSITIONS,
    description: 'A shock ring crosses the frame and settles.',
    effects: [
      { id: 'fx0', type: 'ripple', params: { amplitude: 0, frequency: 3, decay: 1.5 } },
    ],
    tracks: [
      // Amplitude in and out, phase travelling throughout — two tracks because
      // the ring must keep moving while it dies away, and one cannot express
      // both.
      { prop: 'effect.fx0.amplitude', keyframes: [kfb(0, 0, SNAP), kfb(0.25, 34, EVEN), kfb(1.1, 0)] },
      { prop: 'effect.fx0.phase', keyframes: [kfb(0, 0), kfb(1.1, 540)] },
    ],
  }),

  preset({
    name: 'Split Apart',
    folder: TRANSITIONS,
    description: 'The frame cuts in two and the halves separate.',
    effects: [
      { id: 'fx0', type: 'split', params: { splitOffset: 0, angle: 0 } },
    ],
    tracks: [
      // Measured against the comp width so the halves clear the frame at any
      // resolution — a fixed pixel offset would only just part at 4K.
      { prop: 'effect.fx0.splitOffset', unit: 'compW', keyframes: [kfb(0, 0, LEAVE), kfb(0.8, 1.1)] },
      { prop: 'opacity', keyframes: [kfb(0, 100, EVEN), kfb(0.8, 0)] },
    ],
  }),

  preset({
    name: 'Radial Light Burst',
    folder: TRANSITIONS,
    description: 'Rays fan out from the centre and fade — a flash cut that is not just white.',
    effects: [
      { id: 'fx0', type: 'light-rays', params: { rayCount: 64, rayLength: 0, spread: 100, color: '#fff3c4', opacity: 0, falloff: 45, seed: 5, composite: 1 } },
    ],
    tracks: [
      { prop: 'effect.fx0.rayLength', unit: 'compMin', keyframes: [kfb(0, 0, SNAP), kfb(0.5, 1.4)] },
      { prop: 'effect.fx0.opacity', keyframes: [kfb(0, 0, SNAP), kfb(0.14, 90, LEAVE), kfb(0.6, 0)] },
      { prop: 'effect.fx0.rotation', keyframes: [kfb(0, 0), kfb(0.6, 25)] },
    ],
  }),
];
