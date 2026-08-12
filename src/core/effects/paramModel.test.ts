/**
 * The two additions to the effect parameter model, and the invariants that make
 * them safe to build the rest of the AE parity work on.
 *
 * WHY THIS EXISTS. `EffectParamDef` was flat and had no named-choice type, so
 * two things AE shows in its own Effect Controls were simply not expressible:
 * Colorama's five collapsible sections, and any dropdown at all — which is why
 * our Echo carried four parameters where AE's carries five (Echo Operator was
 * the missing one).
 *
 * Both additions are the kind that fail SILENTLY if malformed: an `'enum'`
 * without `options` renders an empty menu the user cannot pick anything from,
 * and a group name repeated in two non-adjacent runs quietly draws two sections
 * with the same title. Neither is a type error.
 */

import { EFFECT_DEFS } from './effects';
import type { EffectParamDef } from './effects';
import { splitParamGroups } from '@/layout/Effects/EffectStack';

describe('enum params', () => {
  const enums = EFFECT_DEFS.flatMap((d) =>
    d.params.filter((p) => p.type === 'enum').map((p) => ({ effect: d.type, param: p })),
  );

  it('there is at least one, so the rules below are not vacuous', () => {
    expect(enums.length).toBeGreaterThan(0);
  });

  it('every enum declares options', () => {
    // An enum with no options renders an empty menu — a control the user can
    // look at and not use. Reported as {effect, key} so a failure names it.
    const bare = enums
      .filter(({ param }) => (param.options?.length ?? 0) < 2)
      .map(({ effect, param }) => `${effect}.${param.key}`);
    expect(bare).toEqual([]);
  });

  it('every enum default names one of its own options', () => {
    // Otherwise the control opens showing a value the effect never receives.
    for (const { effect, param } of enums) {
      const values = (param.options ?? []).map((o) => o.value);
      expect({ effect, key: param.key, default: param.default, values })
        .toMatchObject({ values: expect.arrayContaining([param.default as number]) });
    }
  });

  it('option values are unique within a param', () => {
    // A duplicate value makes two menu entries indistinguishable to the reader
    // that maps index → behaviour, so one of them is unreachable.
    const dupes = enums
      .filter(({ param }) => {
        const values = (param.options ?? []).map((o) => o.value);
        return new Set(values).size !== values.length;
      })
      .map(({ effect, param }) => `${effect}.${param.key}`);
    expect(dupes).toEqual([]);
  });

  it('non-enum params never carry options', () => {
    for (const d of EFFECT_DEFS) {
      for (const p of d.params) {
        if (p.type !== 'enum') expect(p.options).toBeUndefined();
      }
    }
  });
});

describe('param groups', () => {
  it('a group name is one CONTIGUOUS run, so it draws as one section', () => {
    // splitParamGroups walks the list in order, so a name that reappears after
    // an interruption becomes a SECOND section with the same title — two
    // identical twisties, which reads as a rendering bug.
    for (const d of EFFECT_DEFS) {
      const names = splitParamGroups(d.params).map((s) => s.group).filter(Boolean);
      expect({ effect: d.type, names }).toEqual({ effect: d.type, names: [...new Set(names)] });
    }
  });
});

describe('splitParamGroups', () => {
  const p = (key: string, group?: string): EffectParamDef =>
    ({ key, label: key, type: 'number', default: 0, ...(group ? { group } : {}) });

  it('keeps ungrouped params at top level', () => {
    expect(splitParamGroups([p('a'), p('b')])).toEqual([{ group: undefined, params: [p('a'), p('b')] }]);
  });

  it('gathers a contiguous run into one section', () => {
    const out = splitParamGroups([p('a'), p('b', 'Shape'), p('c', 'Shape'), p('d')]);
    expect(out.map((s) => [s.group, s.params.map((x) => x.key)])).toEqual([
      [undefined, ['a']],
      ['Shape', ['b', 'c']],
      [undefined, ['d']],
    ]);
  });

  it('preserves author order rather than gathering a split run', () => {
    // Deliberate: silently reordering the author's list to merge two runs would
    // move controls away from where they wrote them.
    const out = splitParamGroups([p('a', 'X'), p('b'), p('c', 'X')]);
    expect(out.map((s) => s.group)).toEqual(['X', undefined, 'X']);
  });
});
