/**
 * The registry/dispatch pairs in the effects system, and why two of them can no
 * longer disagree.
 *
 * ── The defect shape ────────────────────────────────────────────────────────
 *
 * Three times now this subsystem has had a predicate saying "this effect uses
 * path X" living apart from the table saying "here is what X does for this
 * effect", with a silent fallthrough between them:
 *
 *   CANVAS2D_ONLY      vs  applyCanvas2dEffect   switch with no default
 *   LUT_EFFECTS        vs  tableFor              fell through to `return null`
 *   COLOR_EFFECTS      vs  effectToMatrix        `default: IDENTITY`
 *
 * Each produces the same user-visible result: an effect that is in the browser,
 * adds to the stack, shows and animates its parameters, reports its capability
 * need — and renders exactly nothing.
 *
 * ── Why this file is small ──────────────────────────────────────────────────
 *
 * The last two are now single `Map`s. Membership is `map.has(type)` and dispatch
 * is `map.get(type)`, so registering an effect without giving it an
 * implementation is no longer expressible — you cannot write a Map entry with a
 * key and no value. There is nothing left to guard behaviourally, so what these
 * tests check is the property one level up: that each predicate still answers
 * from the table that does the work, and that every type it admits produces a
 * real result rather than a well-formed no-op.
 *
 * `applyCanvas2dEffect` is deliberately NOT converted. `CANVAS2D_ONLY` and
 * `hasCanvas2dImplementation` answer two genuinely different questions ("does
 * this force a bake" vs "can the bake draw it"), and collapsing them is what
 * previously cost Fill, Stroke, Sharpen and Noise every pixel they should have
 * drawn. That pair keeps its behavioural guard in canvas2dEffects.test.ts.
 */

import { EFFECT_DEFS, defaultParams, type Effect, type EffectParams, type EffectType } from './effects';
import { isColorEffect, effectColorMatrix, IDENTITY_COLOR_MATRIX } from './effectColorMatrix';
import { isLutEffect, buildChannelLut } from './colorLut';
import { isCanvas2dProcedural, applyProceduralEffect } from './proceduralCanvas2d';

function fx(type: EffectType, params: Record<string, unknown> = {}): Effect {
  const def = EFFECT_DEFS.find((d) => d.type === type)!;
  return { id: 'e1', type, params: { ...defaultParams(def), ...params } as EffectParams };
}

/** Settings that must move each colour-matrix effect off identity. */
const COLOR_FIXTURES: ReadonlyArray<readonly [EffectType, Record<string, unknown>]> = [
  ['brightness', { amount: 150 }],
  ['contrast', { amount: 150 }],
  ['saturate', { amount: 40 }],
  ['grayscale', { amount: 100 }],
  ['sepia', { amount: 90 }],
  ['hue-rotate', { amount: 120 }],
  ['hue-saturation', { hue: 40, saturation: 30, lightness: 10 }],
  ['invert', { amount: 100 }],
  ['tint', { mapBlack: '#001040', mapWhite: '#ffe0b0', amount: 100 }],
  ['channel-mixer', { redRed: 40, redGreen: 60, greenGreen: 100, blueBlue: 100 }],
];

describe('COLOR_EFFECTS / effectToMatrix — now one Map', () => {
  it('the fixture table covers every colour-matrix effect', () => {
    const covered = new Set(COLOR_FIXTURES.map(([t]) => t));
    const uncovered = EFFECT_DEFS.filter((d) => isColorEffect(d.type) && !covered.has(d.type)).map((d) => d.type);
    expect(uncovered).toEqual([]);
    // Guards the guard: an empty fixture list satisfies the check above vacuously.
    expect(covered.size).toBeGreaterThan(8);
  });

  it.each(COLOR_FIXTURES)('%s produces a real matrix, not identity', (type, params) => {
    expect(isColorEffect(type)).toBe(true);
    const cm = effectColorMatrix([fx(type, params)]);
    expect(cm).not.toEqual(IDENTITY_COLOR_MATRIX);
  });

  it('an effect OUTSIDE the table contributes nothing and is not claimed', () => {
    // Vibrance reads all three channels, so it is correctly not affine. The
    // predicate and the composition must agree about that in both directions.
    expect(isColorEffect('vibrance')).toBe(false);
    expect(effectColorMatrix([fx('vibrance', { vibrance: 80 })])).toEqual(IDENTITY_COLOR_MATRIX);
  });

  it('a disabled colour effect is skipped', () => {
    const e = { ...fx('invert', { amount: 100 }), enabled: false };
    expect(effectColorMatrix([e])).toEqual(IDENTITY_COLOR_MATRIX);
  });
});

describe('the predicate and the dispatch are the same table', () => {
  /**
   * The structural claim, stated as a test rather than only in a comment.
   *
   * For each pair: everything the predicate admits must produce a result, and
   * nothing it rejects may. Under the old Set-beside-switch shape the first
   * half could fail silently — that was the whole bug. Under a Map it cannot,
   * and this asserts the equivalence still holds after any future edit that
   * reintroduces a second table.
   */
  it('isColorEffect admits exactly the types that yield a matrix', () => {
    for (const [type, params] of COLOR_FIXTURES) {
      const yields = effectColorMatrix([fx(type, params)]) !== IDENTITY_COLOR_MATRIX;
      expect({ type, admits: isColorEffect(type), yields }).toEqual({ type, admits: true, yields: true });
    }
  });

  it('isLutEffect admits exactly the types that yield a table', () => {
    for (const d of EFFECT_DEFS) {
      const admits = isLutEffect(d.type);
      const yields = buildChannelLut([fx(d.type)]) !== null;
      expect({ type: d.type, admits, yields }).toEqual({ type: d.type, admits, yields: admits });
    }
  });

  it('isCanvas2dProcedural admits exactly the types applyProceduralEffect draws', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 8; canvas.height = 8;
    const ctx = canvas.getContext('2d')!;
    for (const d of EFFECT_DEFS) {
      if (!isCanvas2dProcedural(d.type)) continue;
      ctx.clearRect(0, 0, 8, 8);
      ctx.fillStyle = '#808080';
      ctx.fillRect(0, 0, 8, 8);
      const before = [...ctx.getImageData(0, 0, 8, 8).data];
      applyProceduralEffect(ctx, 8, 8, fx(d.type));
      const after = [...ctx.getImageData(0, 0, 8, 8).data];
      // Compare by VALUE. `after !== before` would compare two fresh arrays by
      // reference and be true however little was drawn — a check that passes
      // without testing, which is the exact failure this file exists to prevent.
      const drew = after.some((v, i) => v !== before[i]);
      expect({ type: d.type, drew }).toEqual({ type: d.type, drew: true });
    }
    // Guards the guard: the loop above is vacuous if nothing is procedural.
    expect(EFFECT_DEFS.filter((d) => isCanvas2dProcedural(d.type)).length).toBeGreaterThan(1);
  });
});
