/**
 * The text preset library.
 *
 * These are CONTENT, not code: an animator holding static property offsets plus
 * a selector whose Offset is keyframed to sweep the string. Once the animator
 * mechanism exists, a preset is a literal.
 *
 * ── Three rules every entry follows ──────────────────────────────────
 *
 * 1. **Relative units, always.** Position offsets are fractions of the comp,
 *    type metrics are multiples of the font size. AE's own library bakes pixels
 *    from a 720×480 comp, which is why its presets throw text off-screen in a
 *    4K project. See presetUnits.ts.
 *
 * 2. **A reveal sweeps one EDGE, and the window is parked outside the string.**
 *    The window is `[start, end]` and the animator holds the HIDDEN state, so
 *    covered = not yet arrived. Two mistakes are easy here and both look bad:
 *
 *    Sweeping the whole window across with `offset` -100 → 100 passes it
 *    STRAIGHT OVER the string: the text starts visible, blinks out entirely in
 *    the middle, and comes back. It reads as a glitch, not a reveal.
 *
 *    Using a window of exactly [0, 100] leaves the first and last characters
 *    permanently part-animated, because a soft edge is centred ON the boundary
 *    and so bleeds half its width past it. The reveal then never quite starts
 *    from nothing, and never quite finishes.
 *
 *    So: park the window well outside the string (see MARGIN / FAR) and animate
 *    its leading edge across. One parameter, one direction, clean at both ends.
 *
 * 3. **Smoothness, not shape, is what makes a stagger flow.** With a square
 *    window, `smoothness` is how many characters are mid-transition at once
 *    (100 ≈ one character). Low values pop each character on and off, which is
 *    what amateurish kinetic type looks like; ~130–220 keeps a soft band of
 *    characters in flight and reads as motion rather than as switching. The
 *    hard cut is only correct where it IS the effect — typewriter, decode.
 *
 * Every preset here is a distinct MECHANISM, not a different axis of the same
 * one. Mirror-image variants (slide left vs right, rise vs drop) and
 * near-identical pairs were deliberately cut rather than shipped as filler.
 */

import type { Keyframe } from '@motion/animation';
import type { AnimationPreset, PresetTrack } from './animationPresets';
import { defaultAnimator, type TextAnimatorData } from '@core/text/textAnimators';
import {
  defaultRangeSelector,
  defaultWigglySelector,
  defaultExpressionSelector,
  type RangeSelectorData,
  type SelectorData,
  type WigglySelectorData,
} from '@core/text/textSelectors';

// ── Easing vocabulary ───────────────────────────────────────────────
//
// These ease the reveal FRONT as it travels; the per-character curve comes from
// the selector's shape and ease high/low. All monotone — an overshoot here
// would drag the front backwards and un-reveal characters.
//
// They are all far gentler than the usual expo-out reach, and deliberately so.
// The front travels from MARGIN before the string to MARGIN past it, so a
// strong ease-out spends its speed crossing dead margin and covers the actual
// string in the first third of the duration — every character then arrives
// almost at once and the stagger, which is the entire point, is invisible.
// Measured on a 6-character string: an expo-out front is on-string for 28% of
// its duration, these for ~50%.

/** The default reveal front: a soft start, even middle, gentle settle. */
const GLIDE: [number, number, number, number] = [0.3, 0.1, 0.5, 0.95];
/** Flatter still, for long titles where any acceleration reads as a snatch. */
const DRIFT: [number, number, number, number] = [0.35, 0.1, 0.65, 0.9];
/** Symmetric ease — for travelling emphasis that should not favour either end. */
const EVEN: [number, number, number, number] = [0.65, 0, 0.35, 1];
/** Slightly back-loaded, so an exit gathers pace as it leaves. */
const GATHER: [number, number, number, number] = [0.45, 0.05, 0.7, 0.85];
/** Near-linear, for a mechanical front (typewriter, decode). */
const STEADY: [number, number, number, number] = [0.35, 0.1, 0.65, 0.9];

const kfb = (t: number, value: number, bezier?: [number, number, number, number]): Keyframe => ({
  t,
  value,
  ...(bezier ? { easing: 'bezier' as const, bezier } : {}),
});

// ── Builders ────────────────────────────────────────────────────────

function animator(
  props: Partial<TextAnimatorData>,
  selectors: SelectorData[] = [range()],
): TextAnimatorData {
  return { ...defaultAnimator(), ...props, selectors };
}

function range(patch: Partial<RangeSelectorData> = {}): RangeSelectorData {
  return { ...defaultRangeSelector(), ...patch };
}

function wiggly(patch: Partial<WigglySelectorData> = {}): WigglySelectorData {
  return { ...defaultWigglySelector(), ...patch };
}

function expr(expression: string, patch: Record<string, unknown> = {}): SelectorData {
  return { ...defaultExpressionSelector(), mode: 'add', expression, ...patch } as SelectorData;
}

/**
 * Margin the reveal window keeps outside the string, in percent.
 *
 * A soft edge is centred ON the window boundary, so it bleeds half its width
 * PAST it. A window of exactly [0, 100] therefore never fully covers the first
 * and last characters — they sit inside the bleed — and a sweep that stops at
 * 100 leaves the last character permanently part-way through its animation.
 * Parking the boundary this far outside the string means the reveal genuinely
 * starts at nothing and genuinely finishes.
 *
 * 60% covers a soft edge up to `smoothness` 240 even on a two-character string,
 * which is why the presets below cap smoothness there.
 */
const MARGIN = 60;
const FAR = 200;

/** Selector geometry for a reveal: the window starts well clear of both ends of
 *  the string so the leading edge has somewhere to travel from and to. */
const revealWindow = (smoothness: number): Partial<RangeSelectorData> => ({
  start: -MARGIN,
  end: FAR,
  smoothness,
});
const concealWindow = (smoothness: number): Partial<RangeSelectorData> => ({
  start: -FAR,
  end: -MARGIN,
  smoothness,
});

/**
 * Entrance: every character starts covered — holding the animator's hidden
 * state — and the window's LEADING EDGE sweeps up the string, uncovering them
 * left to right.
 *
 * Sweeping the edge rather than the whole window is what makes this robust: one
 * parameter, one direction, and the trailing edge stays parked far off the end
 * where it cannot bleed back over the last characters.
 */
function revealIn(duration: number, bezier = GLIDE): PresetTrack[] {
  return [{ prop: 'ta.0.start', keyframes: [kfb(0, -MARGIN, bezier), kfb(duration, FAR - MARGIN)] }];
}

/** Exit: the mirror — the window's trailing edge sweeps in from before the
 *  string, covering characters left to right. */
function revealOut(duration: number, bezier = GATHER): PresetTrack[] {
  return [{ prop: 'ta.0.end', keyframes: [kfb(0, -MARGIN, bezier), kfb(duration, FAR - MARGIN)] }];
}

/** Emphasis: a narrow window crosses the string and leaves it as it found it.
 *  `width` is the window's own span, so it must start and end fully clear. */
function travel(duration: number, width: number, bezier = EVEN): PresetTrack[] {
  return [{ prop: 'ta.0.offset', keyframes: [kfb(0, -width, bezier), kfb(duration, 100)] }];
}

interface TextPresetSpec {
  name: string;
  folder: string;
  description: string;
  animators: TextAnimatorData[];
  tracks: PresetTrack[];
}

const preset = (s: TextPresetSpec): AnimationPreset => ({
  name: s.name,
  builtin: true,
  folder: s.folder,
  category: s.folder.split('/').pop(),
  description: s.description,
  requires: 'text',
  animators: s.animators,
  tracks: s.tracks,
});

const IN = 'Text/Animate In';
const OUT = 'Text/Animate Out';
const EMPH = 'Text/Emphasis';
const ORGANIC = 'Text/Organic';
const EXPR = 'Text/Expressions';

// ── The library ─────────────────────────────────────────────────────

export const TEXT_PRESETS: ReadonlyArray<AnimationPreset> = [
  // ── Animate In ────────────────────────────────────────────────────
  preset({
    name: 'Typewriter',
    folder: IN,
    description: 'Characters land one at a time with a hard edge, left to right.',
    // Smoothness 0 is the effect here: a typewriter switches characters on, it
    // does not fade them.
    animators: [animator({ opacity: 0 }, [range({ ...revealWindow(0) })])],
    tracks: revealIn(1.4, STEADY),
  }),
  preset({
    name: 'Cascade',
    folder: IN,
    description: 'A long soft stagger — characters rise, untwist and settle in a flowing band.',
    // The showcase reveal. A wide soft edge keeps ~3 characters in flight at
    // once, and easeLow flattens the start of each character's own curve so
    // they arrive rather than snap.
    animators: [
      animator({ opacity: 0, y: 0.07, rotation: -14, scale: 72, scaleY: 72 }, [
        range({ ...revealWindow(210), easeLow: 60, easeHigh: 20 }),
      ]),
    ],
    tracks: [
      ...revealIn(2.0, DRIFT),
      { prop: 'ta.0.y', unit: 'compH', keyframes: [kfb(0, 0.07)] },
    ],
  }),
  preset({
    name: 'Decode',
    folder: IN,
    description: 'Characters scramble through their own alphabet, then resolve.',
    // Character Offset is the only property that can do this — it substitutes
    // the glyph rather than transforming it, so no transform can fake it.
    animators: [animator({ characterOffset: 22 }, [range({ ...revealWindow(0) })])],
    tracks: revealIn(1.8, STEADY),
  }),
  preset({
    name: 'Focus Pull',
    folder: IN,
    description: 'Text resolves out of defocus. No movement at all — only blur and fill.',
    animators: [
      animator({ blur: 0.55, fillOpacity: 0 }, [range({ ...revealWindow(200), easeLow: 40 })]),
    ],
    tracks: [
      ...revealIn(1.6, DRIFT),
      { prop: 'ta.0.blur', unit: 'fontSize', keyframes: [kfb(0, 0.55)] },
    ],
  }),
  preset({
    name: 'Word Rise',
    folder: IN,
    description: 'Whole words lift into place — calmer than per-character on long lines.',
    animators: [
      animator({ opacity: 0, y: 0.05, scale: 88, scaleY: 88 }, [
        range({ ...revealWindow(130), basedOn: 'words', easeLow: 45 }),
      ]),
    ],
    tracks: [
      ...revealIn(1.5, GLIDE),
      { prop: 'ta.0.y', unit: 'compH', keyframes: [kfb(0, 0.05)] },
    ],
  }),
  preset({
    name: 'Scatter In',
    folder: IN,
    description: 'Characters assemble in a shuffled order, not left to right.',
    // Randomize Order is the mechanism: the same sweep, but which character it
    // reaches when is scrambled.
    animators: [
      animator({ opacity: 0, x: -0.04, y: 0.05, rotation: 25, scale: 60, scaleY: 60 }, [
        range({ ...revealWindow(200), randomizeOrder: true, randomSeed: 12, easeLow: 50 }),
      ]),
    ],
    tracks: [
      ...revealIn(1.7, DRIFT),
      { prop: 'ta.0.x', unit: 'compW', keyframes: [kfb(0, -0.04)] },
      { prop: 'ta.0.y', unit: 'compH', keyframes: [kfb(0, 0.05)] },
    ],
  }),
  preset({
    name: 'Spring In',
    folder: IN,
    description: 'Each character overshoots and settles on its own damped spring.',
    // A real per-character settle needs the expression selector: a monotone
    // sweep cannot overshoot without dragging the reveal front backwards.
    animators: [
      animator({ y: -0.06, scale: 135, scaleY: 135 }, [
        expr(
          'Math.max(0, Math.sin((time - textIndex * 0.055) * 9) * Math.exp(-(time - textIndex * 0.055) * 3.6)) * 100',
        ),
      ]),
    ],
    tracks: [{ prop: 'ta.0.y', unit: 'compH', keyframes: [kfb(0, -0.06)] }],
  }),

  // ── Animate Out ───────────────────────────────────────────────────
  preset({
    name: 'Type Out',
    folder: OUT,
    description: 'The typewriter in reverse — characters delete left to right.',
    animators: [animator({ opacity: 0 }, [range({ ...concealWindow(0) })])],
    tracks: revealOut(1.1, STEADY),
  }),
  preset({
    name: 'Dissolve Out',
    folder: OUT,
    description: 'Characters defocus and fade away in a soft travelling band.',
    animators: [
      animator({ opacity: 0, blur: 0.7 }, [range({ ...concealWindow(210), easeHigh: 45 })]),
    ],
    tracks: [
      ...revealOut(1.4),
      { prop: 'ta.0.blur', unit: 'fontSize', keyframes: [kfb(0, 0.7)] },
    ],
  }),
  preset({
    name: 'Fall Away',
    folder: OUT,
    description: 'Characters tip over and drop out of frame under gravity.',
    animators: [
      animator({ opacity: 0, y: 0.18, rotation: 52, skew: 18 }, [
        range({ ...concealWindow(180), easeHigh: 55 }),
      ]),
    ],
    tracks: [
      ...revealOut(1.3),
      { prop: 'ta.0.y', unit: 'compH', keyframes: [kfb(0, 0.18)] },
    ],
  }),
  preset({
    name: 'Converge Out',
    folder: OUT,
    description: 'Letter spacing collapses inward until the word folds into itself.',
    // Tracking-driven, so nothing moves on its own axis — the string eats
    // itself. Distinct from every other exit here, which translate or fade.
    animators: [
      animator({ opacity: 0, tracking: -0.45, scale: 80, scaleY: 80 }, [
        range({ ...concealWindow(210) }),
      ]),
    ],
    tracks: [
      ...revealOut(1.2),
      { prop: 'ta.0.tracking', unit: 'fontSize', keyframes: [kfb(0, -0.45)] },
    ],
  }),

  // ── Emphasis ──────────────────────────────────────────────────────
  preset({
    name: 'Wave',
    folder: EMPH,
    description: 'A smooth vertical wave travels through the line and leaves it as it was.',
    animators: [
      animator({ y: -0.032 }, [range({ shape: 'smooth', start: 0, end: 30 })]),
    ],
    tracks: [
      ...travel(2.2, 30),
      { prop: 'ta.0.y', unit: 'compH', keyframes: [kfb(0, -0.032)] },
    ],
  }),
  preset({
    name: 'Colour Sweep',
    folder: EMPH,
    description: 'A colour highlight glides across the text.',
    animators: [
      animator({ color: '#ffcc00' }, [range({ shape: 'smooth', start: 0, end: 26 })]),
    ],
    tracks: travel(2.0, 26),
  }),
  preset({
    name: 'Spotlight',
    folder: EMPH,
    description: 'Everything dims except a travelling window — built by subtracting one selector from another.',
    // The only preset that uses a COMBINE mode as its mechanism: selector 0
    // covers the whole string (dim), selector 1 subtracts a moving window back
    // out of it (bright).
    animators: [
      animator({ opacity: 28 }, [
        range({ start: -FAR, end: FAR, smoothness: 0 }),
        range({ shape: 'smooth', start: 0, end: 24, mode: 'subtract' }),
      ]),
    ],
    tracks: [
      { prop: 'ta.0.s1.offset', keyframes: [kfb(0, -24, EVEN), kfb(2.4, 100)] },
    ],
  }),
  preset({
    name: 'Flicker',
    folder: EMPH,
    description: 'Characters flicker in a scrambled order, like a failing sign.',
    animators: [
      animator({ opacity: 15 }, [
        wiggly({ mode: 'add', correlation: 0, wigglesPerSecond: 9, minAmount: -40, lockDimensions: true }),
      ]),
    ],
    // Purely behavioural — no keyframes. The animator value alone is the look.
    tracks: [{ prop: 'ta.0.opacity', keyframes: [kfb(0, 15)] }],
  }),

  // ── Organic (behavioural — no keyframes needed) ───────────────────
  preset({
    name: 'Jitter',
    folder: ORGANIC,
    description: 'Continuous uncorrelated per-character noise — reads as static.',
    animators: [
      animator({ x: 0.005, y: 0.005, rotation: 5 }, [
        wiggly({ mode: 'add', correlation: 0, wigglesPerSecond: 11, lockDimensions: false }),
      ]),
    ],
    tracks: [
      { prop: 'ta.0.x', unit: 'compW', keyframes: [kfb(0, 0.005)] },
      { prop: 'ta.0.y', unit: 'compH', keyframes: [kfb(0, 0.005)] },
    ],
  }),
  preset({
    name: 'Sway',
    folder: ORGANIC,
    description: 'Slow correlated drift — neighbouring characters move together, like cloth.',
    // Same wiggly selector as Jitter; correlation alone is the difference
    // between noise and a wave, which is why both are worth shipping.
    animators: [
      animator({ y: 0.018, rotation: 3.5 }, [
        wiggly({ mode: 'add', correlation: 88, wigglesPerSecond: 0.8, lockDimensions: true }),
      ]),
    ],
    tracks: [{ prop: 'ta.0.y', unit: 'compH', keyframes: [kfb(0, 0.018)] }],
  }),

  // ── Expressions ───────────────────────────────────────────────────
  preset({
    name: 'Inch Worm',
    folder: EXPR,
    description: 'A compression wave crawls along the line, squeezing tracking as it goes.',
    animators: [
      animator({ tracking: 0.45, scale: 118, scaleY: 88 }, [
        expr('Math.max(0, Math.sin(time * 3.4 - textIndex * 0.85)) * 100'),
      ]),
    ],
    tracks: [{ prop: 'ta.0.tracking', unit: 'fontSize', keyframes: [kfb(0, 0.45)] }],
  }),
];
