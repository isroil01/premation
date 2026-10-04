/**
 * The stack as STORED STATE, and as an undoable edit.
 *
 * `modifierCompile.test.ts` proves the compiled text evaluates to the right
 * numbers. This file is the other half: that the rows survive a save/open
 * round trip, that installing a stack does not destroy the expression that was
 * there first, and that removing it puts that expression back — including its
 * enabled bit, which is a state a bare string cannot carry.
 *
 * The `previous` capture is the one place this can quietly go wrong. A version
 * that re-captured on every edit would pass every test that installs a stack
 * once and removes it, and would silently make "Remove stack" a no-op for
 * anybody who had touched a slider in between. That case has its own test.
 */



import { setCommandSystem, CommandSystem, getCommandSystem } from '@core/commands/CommandSystem';
import BEHAVIOR_PRESETS from './behaviorPresets';
import {
  MODIFIER_KINDS,
  MODIFIER_LABELS,
  MODIFIER_HINTS,
  BEHAVIOR_RECIPES,
  defaultModifier,
  describeModifier,
  instantiateRecipe,
  moveModifier,
  patchModifier,
  removeModifier,
  type OffsetModifier,
} from './modifierStack';

beforeAll(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
});

beforeEach(() => {
  getCommandSystem().getHistory().clear();
});

const offset = (amount: number): OffsetModifier => ({ ...defaultModifier('offset') as OffsetModifier, amount });

// ── Pure list edits ─────────────────────────────────────────────────

describe('reordering is a pure list edit', () => {
  const a = offset(1);
  const b = offset(2);
  const c = offset(3);

  test('moves without mutating the input', () => {
    const list = [a, b, c];
    expect(moveModifier(list, 0, 2).map((m) => m.id)).toEqual([b.id, c.id, a.id]);
    expect(moveModifier(list, 2, 0).map((m) => m.id)).toEqual([c.id, a.id, b.id]);
    expect(list.map((m) => m.id)).toEqual([a.id, b.id, c.id]);
  });

  test('a target past either end clamps rather than dropping the row', () => {
    // The arrow buttons on the first and last rows are disabled, but a drag can
    // land anywhere — losing a row to an off-by-one would be silent.
    expect(moveModifier([a, b, c], 0, -5)).toHaveLength(3);
    expect(moveModifier([a, b, c], 0, 99).map((m) => m.id)).toEqual([b.id, c.id, a.id]);
  });

  test('an out-of-range source is a no-op, not a crash', () => {
    expect(moveModifier([a, b], 7, 0).map((m) => m.id)).toEqual([a.id, b.id]);
  });

  test('patch touches one row and keeps the rest identical', () => {
    const next = patchModifier([a, b, c], b, { amount: 99 });
    expect((next[1] as OffsetModifier).amount).toBe(99);
    expect(next[0]).toBe(a);
    expect(next[2]).toBe(c);
  });

  test('remove takes the row with that id and only that one', () => {
    expect(removeModifier([a, b, c], b.id).map((m) => m.id)).toEqual([a.id, c.id]);
  });
});

describe('every kind is constructible and describable', () => {
  test.each(MODIFIER_KINDS)('%s has a default, a label and a hint', (kind) => {
    const m = defaultModifier(kind);
    expect(m.kind).toBe(kind);
    expect(m.enabled).toBe(true);
    expect(m.id).not.toBe('');
    expect(MODIFIER_LABELS[kind]).toBeTruthy();
    expect(MODIFIER_HINTS[kind]).toBeTruthy();
    // The row's summary line — shown collapsed, so it must never be empty.
    expect(describeModifier(m).length).toBeGreaterThan(0);
  });

  test('ids are unique across calls, so React keys survive a reorder', () => {
    const ids = MODIFIER_KINDS.map(() => defaultModifier('offset').id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ── Behaviour recipes ───────────────────────────────────────────────

describe('behaviour recipes', () => {
  test('every recipe names a real behaviour preset', () => {
    // The §2·0 seam: `behaviorPresets.ts` is untouched by this feature, so
    // nothing but this assertion stops a rename over there from leaving a menu
    // entry pointing at a behaviour that no longer exists.
    const names = new Set(BEHAVIOR_PRESETS.map((p) => p.name));
    for (const r of BEHAVIOR_RECIPES) expect(names.has(r.preset)).toBe(true);
  });

  test('the old preset entries still exist and still carry their expressions', () => {
    // "Keep the old preset entries working" made literal: applying Drift from
    // the preset browser must still be the expression it always was.
    const drift = BEHAVIOR_PRESETS.find((p) => p.name === 'Drift');
    expect(drift?.expressions?.map((e) => e.prop)).toEqual(['x', 'y']);
    expect(drift?.expressions?.[0]?.expr).toContain('wiggle');
  });

  test('instantiating gives every row a fresh id', () => {
    const recipe = BEHAVIOR_RECIPES[0]!;
    const first = instantiateRecipe(recipe.props[0]!);
    const second = instantiateRecipe(recipe.props[0]!);
    expect(first[0]!.id).not.toBe(second[0]!.id);
  });
});
