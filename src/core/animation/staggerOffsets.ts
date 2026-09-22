/**
 * Distribution patterns for a multi-row time offset — the shape a selection
 * takes when you move it as a group instead of as a block.
 *
 * Moving twenty selected bars by the same delta keeps them in a flat column,
 * which is almost never the edit anyone wants: the whole reason to select
 * twenty rows is usually to make them fire in sequence. After Effects gets
 * part of the way there with Sequence Layers, but that lays bars strictly
 * END TO END — it can only build a relay, never a 2-frame trail, never a fan
 * out of the centre, and it destroys whatever spacing you already had.
 *
 * This module is the missing half: given N rows in display order, produce N
 * time offsets in a chosen pattern. It knows nothing about layers, keyframes
 * or the timeline — the same offsets drive a bar drag, a keyframe stagger and
 * the Stagger dialog, which is why they are computed in exactly one place.
 *
 * `balance` is the option that makes these usable as a LIVE drag modifier: an
 * unbalanced cascade pushes the whole selection later as you increase the
 * step, so the group crawls away from where you put it. Balanced, the offsets
 * sum to zero and the selection fans out around its own centre, staying put.
 */

export type StaggerMode = 'cascade' | 'zigzag' | 'center' | 'wave' | 'random';

/** The modes in menu order, with the labels the UI shows. */
export const STAGGER_MODES: ReadonlyArray<{ id: StaggerMode; label: string; hint: string }> = [
  { id: 'cascade', label: 'Cascade', hint: 'Each row one step after the row above' },
  { id: 'zigzag', label: 'Zigzag', hint: 'Alternate rows forward and back' },
  { id: 'center', label: 'From Center', hint: 'Fan out from the middle row' },
  { id: 'wave', label: 'Wave', hint: 'Ease out and back across the selection' },
  { id: 'random', label: 'Random', hint: 'Scattered, but the same every time' },
];

export interface StaggerOptions {
  mode: StaggerMode;
  /** Time between adjacent rows, in seconds. Negative runs the pattern backwards. */
  step: number;
  /** Walk the rows bottom-to-top instead of top-to-bottom. */
  reverse?: boolean;
  /**
   * Subtract the mean so the offsets sum to zero — the selection spreads
   * around where it already is instead of drifting later as `step` grows.
   */
  balance?: boolean;
  /** Seed for `random`, so a given selection always scatters the same way. */
  seed?: number;
}

/**
 * A small integer hash → [0, 1). Deterministic and dependency-free: a stagger
 * that re-randomised on every render would jump under the pointer mid-drag,
 * and one that re-randomised on undo/redo would not be undoable at all.
 */
function hash01(i: number, seed: number): number {
  let x = (i + 1) * 374761393 + seed * 668265263;
  x = (x ^ (x >>> 13)) >>> 0;
  x = Math.imul(x, 1274126177) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

/** The raw pattern, in units of `step`, before reverse / balance / scaling. */
function patternUnit(index: number, count: number, mode: StaggerMode, seed: number): number {
  const last = Math.max(1, count - 1);
  switch (mode) {
    case 'cascade':
      return index;

    case 'zigzag':
      // Even rows stay, odd rows shift by one step — the bar edges read as a
      // zigzag down the column. Deliberately NOT a growing sawtooth: the point
      // is a constant-amplitude alternation you can see at a glance.
      return index % 2 === 0 ? 0 : 1;

    case 'center': {
      // Distance from the middle, so the selection opens outward. A fractional
      // middle (an even count) is correct — rows 3 and 4 of 8 both sit half a
      // step out, which is the symmetric answer.
      const middle = (count - 1) / 2;
      return Math.abs(index - middle);
    }

    case 'wave':
      // One full sine period across the selection: out, back, under, back.
      // Scaled by `last` so the amplitude is comparable to a cascade's reach
      // rather than being stuck at ±1 step however many rows there are.
      return (Math.sin((index / last) * Math.PI * 2) * last) / 2;

    case 'random':
      return hash01(index, seed) * last;

    default:
      return index;
  }
}

/**
 * `count` time offsets in seconds, one per row in display order.
 *
 * Returns all zeros for a step of 0 or a single row — "no pattern" must be
 * representable, because that is what a group drag with the modifier released
 * is, and because a one-row selection has nothing to stagger against.
 */
export function staggerOffsets(count: number, opts: StaggerOptions): number[] {
  if (count <= 0) return [];
  const { mode, step, reverse = false, balance = false, seed = 1 } = opts;
  if (count === 1 || step === 0) return new Array<number>(count).fill(0);

  const out = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    const row = reverse ? count - 1 - i : i;
    // `+ 0` normalizes the -0 that a zero term times a negative step produces.
    // It compares equal to 0 but formats as "-0", and these offsets are shown
    // in the drag read-out and written into keyframe times.
    out[i] = patternUnit(row, count, mode, seed) * step + 0;
  }

  if (balance) {
    let sum = 0;
    for (const v of out) sum += v;
    const mean = sum / count;
    for (let i = 0; i < count; i++) out[i]! -= mean;
  }
  return out;
}

/**
 * Snap offsets to whole frames.
 *
 * Applied AFTER the pattern rather than inside it so the shape is computed at
 * full precision and only the result is quantized — rounding each term as it
 * is produced makes a wave with a sub-frame amplitude collapse to all zeros
 * instead of to its nearest representable shape.
 */
export function quantizeOffsets(offsets: ReadonlyArray<number>, frameDuration: number): number[] {
  if (!(frameDuration > 0)) return [...offsets];
  return offsets.map((t) => Math.round(t / frameDuration) * frameDuration);
}

/**
 * Shift the whole set so nothing lands before `minTime`, preserving every
 * relative offset. Returns the offsets unchanged when they already clear it.
 *
 * The group is moved as ONE — clamping each row individually would silently
 * flatten the pattern against t=0, which is the one place a stagger is most
 * likely to be aimed at.
 */
export function clampOffsetsToStart(
  starts: ReadonlyArray<number>,
  offsets: ReadonlyArray<number>,
  minTime = 0,
): number[] {
  let worst = Infinity;
  for (let i = 0; i < starts.length; i++) {
    worst = Math.min(worst, (starts[i] ?? 0) + (offsets[i] ?? 0));
  }
  if (!Number.isFinite(worst) || worst >= minTime) return [...offsets];
  const push = minTime - worst;
  return offsets.map((t) => t + push);
}
