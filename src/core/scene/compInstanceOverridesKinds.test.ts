/**
 * Essential Properties beyond numbers: text and colour.
 *
 * The module header explains why widening this set is not just adding a name to
 * a list — a property whose ANIMATED half is missed produces a control that
 * works on a static layer and silently does nothing the moment that layer is
 * keyframed. Colour is the sharp case, because it does not animate under its
 * own name: it is stored as `fill` and keyframed as `fill_r/_g/_b`, so
 * suppressing `fill` alone leaves the track live and it repaints over the
 * override on every frame.
 *
 * These tests exist so that trap stays closed, and so the next property added
 * here has a worked example of what "check both halves" means.
 */

import {
  OVERRIDE_PROP_KINDS,
  OVERRIDABLE_PROPS,
  isOverridableProp,
  overrideKindOf,
  isValidOverrideValue,
  overrideKey,
  overriddenPropsFor,
  applyOverridesToComponents,
  type OverrideValue,
} from './compInstanceOverrides';
import type { SceneNode } from '@core/types';
import { readSource } from '@/__testHelpers__/readSource';

const comps = (props: Record<string, unknown>, type = 'Transform'): SceneNode['components'] =>
  [{ id: 'c1', type, props }] as unknown as SceneNode['components'];

const ov = (pairs: Array<[string, OverrideValue]>): Map<string, OverrideValue> =>
  new Map(pairs.map(([p, v]) => [overrideKey('n', p), v]));

describe('the property set', () => {
  it('still carries the whole numeric Transform set', () => {
    // Widening must not have dropped anything: these were the original six and
    // every existing document's overrides are keyed by them.
    for (const p of ['x', 'y', 'rotation', 'scaleX', 'scaleY', 'opacity']) {
      expect(isOverridableProp(p)).toBe(true);
      expect(overrideKindOf(p)).toBe('number');
    }
  });

  it('adds text and the two colour properties', () => {
    expect(overrideKindOf('text')).toBe('text');
    expect(overrideKindOf('fill')).toBe('color');
    expect(overrideKindOf('color')).toBe('color');
  });

  it('rejects anything else', () => {
    expect(isOverridableProp('blendMode')).toBe(false);
    expect(overrideKindOf('blendMode')).toBeNull();
    // A channel is not itself overridable — you override `fill`, and the
    // channels are what gets SUPPRESSED.
    expect(isOverridableProp('fill_r')).toBe(false);
  });

  it('every listed property has a kind', () => {
    for (const p of OVERRIDABLE_PROPS) expect(OVERRIDE_PROP_KINDS[p]).toBeTruthy();
  });
});

describe('value validation', () => {
  it('numbers only for numeric props', () => {
    expect(isValidOverrideValue('x', 12)).toBe(true);
    expect(isValidOverrideValue('x', '12')).toBe(false);
    expect(isValidOverrideValue('x', NaN)).toBe(false);
    expect(isValidOverrideValue('x', Infinity)).toBe(false);
  });

  it('strings only for text and colour props', () => {
    expect(isValidOverrideValue('text', 'Hello')).toBe(true);
    expect(isValidOverrideValue('text', 3)).toBe(false);
    expect(isValidOverrideValue('fill', '#ff0000')).toBe(true);
    expect(isValidOverrideValue('fill', 0xff0000)).toBe(false);
  });

  it('an empty string is a legitimate text override', () => {
    // Blanking a text layer on one instance is a real thing to want, and a
    // falsy-check would silently refuse it.
    expect(isValidOverrideValue('text', '')).toBe(true);
  });

  it('rejects any value for an unknown property', () => {
    expect(isValidOverrideValue('blendMode', 'screen')).toBe(false);
  });
});

describe('suppressing the animated half', () => {
  it('a numeric override suppresses its own prop', () => {
    expect([...overriddenPropsFor(ov([['x', 5]]), 'n')!]).toEqual(['x']);
  });

  it('a FILL override suppresses fill_r/_g/_b as well as fill', () => {
    // The whole reason colour needed a trace. Without the channels, a keyframed
    // fill repaints over the override every frame: wired control, no effect,
    // no error.
    expect([...overriddenPropsFor(ov([['fill', '#abc']]), 'n')!].sort())
      .toEqual(['fill', 'fill_g', 'fill_b', 'fill_r'].sort());
  });

  it('a COLOR override suppresses color_r/_g/_b', () => {
    expect([...overriddenPropsFor(ov([['color', '#abc']]), 'n')!].sort())
      .toEqual(['color', 'color_g', 'color_b', 'color_r'].sort());
  });

  it('a TEXT override suppresses only text', () => {
    // Text has no numeric track — `evaluateNode` returns Map<PropPath, number>
    // — so there is nothing else to suppress. Inventing channels here would
    // delete entries that never exist.
    expect([...overriddenPropsFor(ov([['text', 'hi']]), 'n')!]).toEqual(['text']);
  });

  it('suppresses nothing for another node', () => {
    expect(overriddenPropsFor(ov([['fill', '#abc']]), 'other')).toBeNull();
  });
});

describe('patching the clone', () => {
  it('writes a text override onto the component that declares text', () => {
    const out = applyOverridesToComponents(
      comps({ text: 'Original', x: 0 }),
      ov([['text', 'Overridden']]),
      'n',
    );
    expect((out[0]!.props as Record<string, unknown>).text).toBe('Overridden');
  });

  it('writes a colour override as the string it is', () => {
    const out = applyOverridesToComponents(comps({ fill: '#000000' }), ov([['fill', '#ff0000']]), 'n');
    expect((out[0]!.props as Record<string, unknown>).fill).toBe('#ff0000');
  });

  it('writes each property to the LAST component that declares it', () => {
    // Same last-write-wins rule `readBase` uses. Text on a Text component and
    // fill on a Style one must not both be forced onto Transform.
    const list = [
      { id: 'tr', type: 'Transform', props: { x: 0 } },
      { id: 'st', type: 'Style', props: { fill: '#000000' } },
    ] as unknown as SceneNode['components'];
    const out = applyOverridesToComponents(list, ov([['fill', '#00ff00'], ['x', 9]]), 'n');
    expect((out[1]!.props as Record<string, unknown>).fill).toBe('#00ff00');
    expect((out[0]!.props as Record<string, unknown>).x).toBe(9);
    // …and did not smear fill onto Transform on the way past.
    expect((out[0]!.props as Record<string, unknown>).fill).toBeUndefined();
  });

  it('falls back to Transform for a property no component declares', () => {
    const out = applyOverridesToComponents(comps({ x: 0 }), ov([['text', 'New']]), 'n');
    expect((out[0]!.props as Record<string, unknown>).text).toBe('New');
  });

  it('mixes kinds in one patch without confusing them', () => {
    const out = applyOverridesToComponents(
      comps({ x: 0, text: 'a', fill: '#000000', opacity: 100 }),
      ov([['x', 5], ['text', 'b'], ['fill', '#123456'], ['opacity', 50]]),
      'n',
    );
    const p = out[0]!.props as Record<string, unknown>;
    expect(p).toMatchObject({ x: 5, text: 'b', fill: '#123456', opacity: 50 });
  });

  it('leaves the array identity alone when only a wrong-kind value is present', () => {
    // Nothing applied ⇒ nothing allocated, same contract as before widening.
    const list = comps({ x: 1 });
    expect(applyOverridesToComponents(list, ov([['fill', 5 as unknown as string]]), 'n')).toBe(list);
  });
});

describe('the new properties are PROMOTABLE, not just overridable', () => {
  // Widening the set without wiring promotion would leave colour and text
  // reachable only through the pre-promotion fallback list — so the moment a
  // user promoted any single property, they would vanish. Tests-green,
  // feature-absent, which this repo has shipped before.

  it('the colour row offers the Essential Properties entry', () => {
    const ui = readSource('layout/Inspector/ColorKfRow.tsx');
    expect(ui).toMatch(/essentialPropMenuItems/);
    expect(ui).toMatch(/onContextMenu/);
  });

  it('promotion is built in ONE place, shared by both surfaces', () => {
    // The colour row cannot use `buildPropertyMenu` (it is shaped for a
    // numeric, keyframeable property), so the entry was extracted rather than
    // rebuilt — a second copy is how the label and the storage key drift.
    const menu = readSource('core/inspector/propertyMenu.ts');
    expect(menu).toMatch(/export function essentialPropMenuItems/);
    expect(menu).toMatch(/items\.push\(\.\.\.essentialPropMenuItems\(nodeId, prop\)\)/);
  });

  it('the instance inspector edits each kind with the right control', () => {
    const ui = readSource('layout/Inspector/CompOverridesSection.tsx');
    expect(ui).toMatch(/ColorPicker/);  // colour
    expect(ui).toMatch(/<Input/);       // text
    expect(ui).toMatch(/ValueField/);   // numbers, as before
  });
});
