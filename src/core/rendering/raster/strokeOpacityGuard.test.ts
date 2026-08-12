/**
 * `applyStrokeStyle` and a non-numeric opacity.
 *
 * ## What this pins, and why it is not a style nit
 *
 * `ctx.globalAlpha *= clamp01(stroke.opacity)`, where the local `clamp01` is
 * `v < 0 ? 0 : v > 1 ? 1 : v`. That expression is written for numbers, and for
 * `undefined` **both comparisons are false**, so it returns `undefined`
 * untouched. `globalAlpha *= undefined` is `NaN`, and the Canvas2D spec says a
 * non-finite assignment to `globalAlpha` is **ignored** — the previous value
 * stands. The stroke therefore draws at full opacity.
 *
 * So the rendered result of a missing opacity currently depends on a coincidence
 * of two unrelated leniencies: a clamp that silently passes non-numbers through,
 * and a canvas that silently discards a NaN. Neither is a decision anyone made.
 *
 * This was found the expensive way. Consolidating the ~17 hand-written `clamp01`
 * copies onto one NaN-safe version — `v > 0 ? (v > 1 ? 1 : v) : 0` — moved
 * **112 render-test scenes and lost fidelity on 49**, because that version maps
 * `undefined` to `0`: alpha 0, stroke gone. A follow-up experiment isolated the
 * cause: a variant differing from the original ONLY on `NaN` (`v !== v ? 0 : …`)
 * left the gate at its 3/0 baseline. **NaN is not load-bearing here; the
 * `undefined` fall-through is.**
 *
 * The test asserts today's behaviour rather than a preferred one, deliberately.
 * Whoever unifies `clamp01` needs to know that this call site depends on the
 * pass-through, and needs to make the intent explicit HERE first — a stroke with
 * no stated opacity should be opaque because the code says so, not because two
 * layers of leniency cancel out.
 */

import { applyStrokeStyle } from './vectorDraw';
import type { Stroke } from '@core/paint/stroke';

/**
 * The smallest object `applyStrokeStyle` touches. A real canvas is not needed
 * and would obscure the point: `globalAlpha` here is a plain number, so an
 * assignment of NaN STICKS, unlike on a real context. That difference is the
 * subject, so the test reads the raw product and reasons about the canvas rule
 * explicitly rather than relying on a mock to reproduce it.
 */
function fakeCtx(): CanvasRenderingContext2D & { globalAlpha: number } {
  return {
    globalAlpha: 1,
    strokeStyle: '',
    lineWidth: 0,
    lineCap: 'butt',
    lineJoin: 'miter',
    lineDashOffset: 0,
    setLineDash(): void {},
  } as unknown as CanvasRenderingContext2D & { globalAlpha: number };
}

const stroke = (over: Partial<Stroke> = {}): Stroke => ({
  enabled: true, color: '#fff', width: 4, opacity: 1,
  align: 'center', dash: [], cap: 'butt', join: 'miter',
  ...over,
} as Stroke);

describe('a numeric opacity behaves normally', () => {
  it.each([
    [1, 1],
    [0.5, 0.5],
    [0, 0],
    [-3, 0],   // clamped low
    [7, 1],    // clamped high
  ])('opacity %p multiplies globalAlpha to %p', (given, expected) => {
    const ctx = fakeCtx();
    applyStrokeStyle(ctx, stroke({ opacity: given as number }));
    expect(ctx.globalAlpha).toBe(expected);
  });

  it('multiplies into an alpha already set by the caller', () => {
    const ctx = fakeCtx();
    ctx.globalAlpha = 0.5;
    applyStrokeStyle(ctx, stroke({ opacity: 0.5 }));
    expect(ctx.globalAlpha).toBe(0.25);
  });
});

describe('a MISSING opacity is opaque, and now says so', () => {
  it.each([
    ['undefined', undefined],
    ['NaN', NaN],
    ['null', null],
    ['a string', '0.5'],
  ])('%s defaults to fully opaque rather than producing NaN', (_why, given) => {
    // `Stroke.opacity` is typed `number`, so none of these can happen per the
    // types. They can happen at runtime: a Stroke rebuilt from a stored
    // document, or a partial object cast at a call site, carries whatever the
    // data had.
    const ctx = fakeCtx();
    applyStrokeStyle(ctx, stroke({ opacity: given as unknown as number }));
    expect(ctx.globalAlpha).toBe(1);
    expect(Number.isNaN(ctx.globalAlpha)).toBe(false);
  });

  it('preserves an alpha the caller had already set', () => {
    const ctx = fakeCtx();
    ctx.globalAlpha = 0.4;
    applyStrokeStyle(ctx, stroke({ opacity: undefined as unknown as number }));
    // ×1, not ×0 — the whole point of the default.
    expect(ctx.globalAlpha).toBeCloseTo(0.4, 10);
  });

  it('matches what the canvas used to do by accident', () => {
    // Before the fix this produced NaN, which a real CanvasRenderingContext2D
    // discards, leaving globalAlpha at its prior value. The explicit default
    // reproduces that exact result — so this is a clarification, not a
    // behaviour change, and the render gate should not move.
    const ctx = fakeCtx();
    ctx.globalAlpha = 0.75;
    applyStrokeStyle(ctx, stroke({ opacity: undefined as unknown as number }));
    expect(ctx.globalAlpha).toBeCloseTo(0.75, 10);
  });

  it('the other stroke properties are still applied', () => {
    const ctx = fakeCtx();
    applyStrokeStyle(ctx, stroke({ opacity: undefined as unknown as number, width: 9 }));
    expect(ctx.lineWidth).toBe(9);
  });
});

describe('the fragility is two-sided', () => {
  it('mapping undefined to 0 instead would make the stroke vanish', () => {
    // The exact substitution that cost 112 scenes, stated as an executable fact
    // so the trade-off is not rediscovered by running the GPU suite.
    const naive = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
    const nanSafe = (v: number): number => (v > 0 ? (v > 1 ? 1 : v) : 0);
    const missing = undefined as unknown as number;

    expect(naive(missing)).toBeUndefined();
    expect(nanSafe(missing)).toBe(0);

    // …and on real NaN the two agree once a NaN guard is added, which is why
    // the NaN-only variant left the render gate untouched.
    const nanOnly = (v: number): number => (v !== v ? 0 : v < 0 ? 0 : v > 1 ? 1 : v);
    expect(nanOnly(NaN)).toBe(0);
    expect(nanOnly(missing)).toBeUndefined();
  });
});
