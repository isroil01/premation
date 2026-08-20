/**
 * 3:2 pulldown (telecine) detection — the missing half of Interpret Footage ▸
 * Separate Fields.
 *
 * Film at 24fps becomes 29.97i video by dealing frames onto fields in a
 * 2-3 cadence. Worked through at field granularity (film frames A B C D onto
 * the alternating field stream): the five video frames of one cycle are
 * A/A, B/B, B/C, C/D, D/D — so across the five frame TRANSITIONS of a cycle,
 * the top field repeats exactly once (B/B → B/C) and the bottom field repeats
 * exactly once (C/D → D/D), at fixed, different phases. Progressive video
 * repeats neither; true interlaced video repeats neither; a still repeats
 * everything and has no cadence. Two same-parity repeats per five
 * transitions, one per parity, each locked to its phase mod 5 — that
 * signature IS telecine, and finding it is the entire detector.
 *
 * Pure functions over field-luma arrays: the caller (the Interpret Footage
 * modal's Detect button) decodes a short window through the exact decoder and
 * splits rows; nothing here touches a decoder, a canvas, or a clock, so the
 * detector is testable on synthetic telecine and deterministic on real.
 *
 * What detection DRIVES today: the Separate Fields setting (killing the comb)
 * and the conform hint (the content is 23.976 under a 29.97 wrapper). Full
 * inverse telecine — re-weaving the five frames back into four progressive
 * ones — changes frame indexing in the decode path and remains open;
 * detection is what makes even that future work honest, and is the part a
 * user can act on now.
 */

export interface FieldPair {
  /** Rows 0,2,4… of the frame's luma, packed. */
  top: Float32Array;
  /** Rows 1,3,5… */
  bottom: Float32Array;
}

export interface PulldownReport {
  /** True when a 3:2 cadence was found with enough margin to act on. */
  telecine: boolean;
  /** 0..1 — how much of the expected, PHASE-LOCKED cadence was found. */
  confidence: number;
  /** Raw counts, for the modal to show its work. */
  repeats: number;
  transitions: number;
}

/** Mean absolute difference of two equal-length luma planes. */
function meanAbsDiff(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return Infinity;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / n;
}

/**
 * Split a full-frame luma plane into its two fields, horizontally decimated
 * by `xStep` (field comparison needs the ROW structure, not horizontal
 * detail, and a 4× decimation quarters the cost).
 */
export function splitFields(
  luma: Float32Array,
  width: number,
  height: number,
  xStep = 4,
): FieldPair {
  const cols = Math.max(1, Math.floor(width / xStep));
  const topRows = Math.ceil(height / 2);
  const bottomRows = Math.floor(height / 2);
  const top = new Float32Array(cols * topRows);
  const bottom = new Float32Array(cols * bottomRows);
  for (let y = 0; y < height; y++) {
    const dst = y % 2 === 0 ? top : bottom;
    const row = Math.floor(y / 2);
    for (let c = 0; c < cols; c++) {
      dst[row * cols + c] = luma[y * width + c * xStep]!;
    }
  }
  return { top, bottom };
}

/**
 * The detector. `frames` is a run of CONSECUTIVE frames' fields, ~25+ for a
 * confident answer (five full cadence cycles).
 *
 * A transition is a REPEAT EVENT for a parity when that parity's field
 * difference is both near-zero in absolute terms relative to the clip's own
 * motion level, and a small fraction of the OTHER parity's difference — the
 * asymmetry is what separates telecine from a still shot, where both fields
 * repeat and there is no cadence to find (reported non-telecine: separating
 * fields on a still changes nothing anyway).
 */
export function detectPulldown(frames: readonly FieldPair[]): PulldownReport {
  const none: PulldownReport = { telecine: false, confidence: 0, repeats: 0, transitions: 0 };
  if (frames.length < 10) return none;

  const transitions = frames.length - 1;
  const topDiff = new Float64Array(transitions);
  const botDiff = new Float64Array(transitions);
  for (let i = 0; i < transitions; i++) {
    topDiff[i] = meanAbsDiff(frames[i]!.top, frames[i + 1]!.top);
    botDiff[i] = meanAbsDiff(frames[i]!.bottom, frames[i + 1]!.bottom);
  }

  // The clip's own motion level: the median of all field differences. Repeat
  // thresholds are RELATIVE to it, so a noisy VHS transfer and a clean
  // digital telecine both detect.
  const all = [...topDiff, ...botDiff].sort((a, b) => a - b);
  const motion = all[Math.floor(all.length / 2)]!;
  if (motion < 1e-3) return none; // a still — nothing moves, no cadence exists

  // A repeat: this parity's difference is near-zero against the clip's own
  // motion level AND a small fraction of the other parity's — the asymmetry
  // is what separates a telecine repeat from a quiet moment.
  const isRepeat = (own: number, other: number): boolean =>
    own < motion * 0.25 && own < other * 0.35;

  const topPhases: number[] = [];
  const botPhases: number[] = [];
  for (let i = 0; i < transitions; i++) {
    if (isRepeat(topDiff[i]!, botDiff[i]!)) topPhases.push(i % 5);
    if (isRepeat(botDiff[i]!, topDiff[i]!)) botPhases.push(i % 5);
  }

  // The cadence check: each parity's repeats must CLUSTER at one phase mod 5
  // (the weave locks them there). Count the best residue class per parity —
  // scattered repeats (cuts, noise, hard motion pauses) spread across phases
  // and score low, which is exactly the discrimination a period test buys
  // over a bare repeat count.
  const bestPhaseCount = (phases: number[]): number => {
    const hist = [0, 0, 0, 0, 0];
    for (const p of phases) hist[p]!++;
    return Math.max(...hist);
  };
  const lockedTop = bestPhaseCount(topPhases);
  const lockedBot = bestPhaseCount(botPhases);
  const repeats = topPhases.length + botPhases.length;

  // One repeat per parity per 5-transition cycle.
  const cycles = transitions / 5;
  const confidence = Math.min(1, (lockedTop + lockedBot) / (2 * cycles));

  // Accept at 60% of the expected phase-locked cadence, with BOTH parities
  // participating — a single-parity repeat train is a slideshow or a
  // duplicated-frame encode, not telecine.
  const telecine = confidence >= 0.6 && lockedTop >= cycles * 0.5 && lockedBot >= cycles * 0.5;
  return { telecine, confidence, repeats, transitions };
}
