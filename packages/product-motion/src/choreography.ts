/**
 * Product-motion choreography — the timing rules, as constants.
 *
 * ## Why this is a separate package
 *
 * Product motion and editorial motion have rules that **directly contradict**.
 * Not "differ by taste" — contradict:
 *
 * |                | Editorial      | Product UI                  |
 * |----------------|----------------|-----------------------------|
 * | Curve model    | cubic bezier   | **spring**                  |
 * | Enter          | 400–900ms      | **200–300ms**               |
 * | Exit           | ≈ enter        | **150–200ms, always faster**|
 * | List stagger   | 60–120ms       | **30–50ms**                 |
 * | Overshoot      | large          | **≤ 2%; large reads as toy**|
 * | Travel         | 20–60px        | **8–24px**                  |
 * | Transition     | cut / wipe     | **shared element**          |
 * | Motion blur    | heavy          | **off** — real UI doesn't   |
 *
 * Applying an editorial technique to a card produces output that anyone who has
 * shipped a product reads as wrong immediately, and usually cannot say why. The
 * LookPack's `forbid` list is what keeps the two apart, and this file is what the
 * product side measures itself against.
 *
 * Pure.
 */

/** How an element is classed. Timing budgets differ per class. */
export type UiElementClass =
  | 'surface'   // sheets, modals, drawers — the largest, slowest things
  | 'container' // cards, panels, list rows
  | 'control'   // buttons, toggles, inputs
  | 'content'   // text, icons inside a container
  | 'overlay'   // toasts, tooltips, popovers
  | 'indicator';// spinners, badges, cursors

export interface Budget {
  enterMs: number;
  exitMs: number;
  /** Max travel in px at 1× density. */
  travelPx: number;
  /** Spring preset the class should use. */
  spring: 'gentle' | 'snappy' | 'bouncy' | 'stiff' | 'molasses';
}

/**
 * Per-class timing budgets.
 *
 * **Exits are always faster than entries.** This is the rule most often broken
 * and the one users feel most: an element leaving is acknowledging an action the
 * user already took, so any time it spends is time the interface feels slow. An
 * element arriving is new information, and needs long enough to be read.
 */
export const BUDGETS: Record<UiElementClass, Budget> = {
  surface:   { enterMs: 300, exitMs: 200, travelPx: 24, spring: 'gentle' },
  container: { enterMs: 260, exitMs: 170, travelPx: 16, spring: 'snappy' },
  control:   { enterMs: 200, exitMs: 150, travelPx: 8,  spring: 'snappy' },
  content:   { enterMs: 220, exitMs: 150, travelPx: 12, spring: 'gentle' },
  overlay:   { enterMs: 260, exitMs: 160, travelPx: 20, spring: 'snappy' },
  indicator: { enterMs: 180, exitMs: 120, travelPx: 8,  spring: 'stiff' },
};

/** Hard limits the UI-motion linter enforces. */
export const UI_LIMITS = {
  /** Above this, a list stagger reads as a wave rather than as a list appearing. */
  maxStaggerMs: 60,
  /** The band that reads as responsive. */
  minStaggerMs: 20,
  /** Above this, UI motion looks like a title sequence. */
  maxTravelPx: 32,
  /** Above this, an overshoot reads as a toy. */
  maxOvershoot: 0.04,
  /** Below this after cursor arrival, a click looks pre-recorded. */
  minCursorDwellMs: 120,
  /** A click firing sooner than this after arrival is simultaneous. */
  minCursorSettleMs: 80,
  /** Press feedback depth. Deeper reads as a squash toy. */
  pressScale: 0.97,
  pressMs: 80,
} as const;

/**
 * List stagger — 30–50ms, not 60–120.
 *
 * A UI list is not a title sequence. The stagger exists to show that rows are
 * *distinct*, not to give each one a moment. Above ~60ms the list stops feeling
 * like it appeared and starts feeling like it is loading.
 *
 * It also SHORTENS as the list grows: twenty rows at 40ms is 800ms of waiting for
 * the last one. Real implementations cap the total, which is what this does.
 */
export function listStagger(count: number, base = 40): number {
  if (count <= 1) return 0;
  const total = Math.min(base * (count - 1), 320);
  return Math.max(UI_LIMITS.minStaggerMs, total / (count - 1));
}

/**
 * Where element `index` starts, in ms.
 *
 * Slightly non-uniform — later rows compress — because a perfectly even list
 * stagger is as recognisable in UI as it is in editorial. The deviation is small:
 * UI motion should not draw attention to its own rhythm.
 */
export const MAX_TOTAL_STAGGER_MS = 320;

/** Deceleration exponent. Below 1, so gaps shrink down the list. */
const LIST_CURVE = 0.88;

export function listStaggerAt(index: number, count: number, base = 40): number {
  if (index <= 0 || count <= 1) return 0;
  const n = count - 1;

  // The curve FRONT-LOADS: with an exponent below 1 the first gap is the
  // largest, and it can exceed `maxStaggerMs` even when the average is well
  // inside it. Measured on `ui.type_on` with six lines at a 55ms base: the first
  // gap came out 67ms, over the limit, while every later one was under it.
  //
  // So the step is solved backwards from the guarantee — the largest gap the
  // curve will produce must clear the ceiling — rather than being applied and
  // hoped about. A function whose bound only holds on average has no bound.
  const largestUnitGap = Math.pow(1 / n, LIST_CURVE) * n;
  const stepCeiling = UI_LIMITS.maxStaggerMs / Math.max(largestUnitGap, 1e-6);
  const step = Math.min(listStagger(count, base), stepCeiling);

  const raw = Math.pow(index / n, LIST_CURVE) * step * n;

  // Cap the TOTAL, not the per-step gap.
  //
  // `listStagger` floors each gap at `minStaggerMs` so rows never land on the
  // same frame — but that floor silently defeated the total cap: a hundred rows
  // at the 20ms floor is two seconds of waiting for the last one, which is a
  // list that appears to be loading. The cap has to be applied here, after the
  // floor, or it does not hold either.
  return Math.min(raw, MAX_TOTAL_STAGGER_MS);
}

/** Does this element class allow motion blur? Never — real interfaces do not blur. */
export function allowsMotionBlur(): boolean {
  return false;
}

/** Enter/exit budget for a class, scaled by the frame's pixel density. */
export function budgetFor(cls: UiElementClass, densityScale = 1): Budget {
  const b = BUDGETS[cls];
  return { ...b, travelPx: Math.round(b.travelPx * densityScale) };
}
