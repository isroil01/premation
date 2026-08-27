/**
 * The declarative widget vocabulary — richer plugin UI without plugin markup.
 *
 * The standing request is arbitrary plugin HTML in the inspector. It stays
 * refused for the reason `CustomLayerSection.tsx` opens with: a plugin that can
 * render into the inspector can draw a convincing permission prompt, and every
 * plugin's panel would age differently from the app around it.
 *
 * So the vocabulary grows instead. A plugin states INTENT — this is an angle,
 * this belongs in that section, this only applies when that is on — and the
 * host still chooses every pixel. These tests pin what may be stated, and
 * (mostly) what may not.
 */

import { parseLayerKinds } from './layerKindSchema';
import { ICON_NAMES } from '@components/Icon/iconNames';

const ICONS = new Set<string>(ICON_NAMES as readonly string[]);

function kind(props: Record<string, unknown>) {
  const errors: string[] = [];
  const out = parseLayerKinds(
    [{ id: 'k', label: 'K', render: 'proxy', schemaVersion: 1, props }],
    errors,
    ICONS,
  );
  return { kind: out[0], errors };
}

describe('the angle type', () => {
  it('is a number in degrees, and animatable', () => {
    const { kind: k, errors } = kind({ spin: { type: 'angle', default: 0, animatable: true } });
    expect(errors).toEqual([]);
    expect(k!.props.spin).toMatchObject({ type: 'angle', animatable: true });
  });

  it('★ is deliberately unbounded — a revolution is a legitimate value', () => {
    // Clamping to 0..360 would make a spin animation stop at the wrap.
    expect(kind({ spin: { type: 'angle', default: 1080 } }).errors).toEqual([]);
    expect(kind({ spin: { type: 'angle', default: -720 } }).errors).toEqual([]);
  });

  it('takes min/max/step like a number when an author wants them', () => {
    const { kind: k, errors } = kind({ tilt: { type: 'angle', default: 0, min: -45, max: 45, step: 5 } });
    expect(errors).toEqual([]);
    expect(k!.props.tilt).toMatchObject({ min: -45, max: 45, step: 5 });
  });

  it('refuses a default that is not a number', () => {
    expect(kind({ spin: { type: 'angle', default: '90deg' } }).errors.join(' ')).toMatch(/finite number/);
  });
});

describe('grouping', () => {
  it('accepts a section name', () => {
    const { kind: k, errors } = kind({ feather: { type: 'number', default: 0, group: 'Edges' } });
    expect(errors).toEqual([]);
    expect(k!.props.feather!.group).toBe('Edges');
  });

  it('refuses an empty or oversized group name', () => {
    expect(kind({ a: { type: 'number', default: 0, group: '   ' } }).errors.join(' ')).toMatch(/group/);
    expect(kind({ a: { type: 'number', default: 0, group: 'x'.repeat(41) } }).errors.join(' ')).toMatch(/group/);
  });
});

describe('multiline', () => {
  it('is accepted on a string', () => {
    const { kind: k, errors } = kind({ body: { type: 'string', default: '', multiline: true } });
    expect(errors).toEqual([]);
    expect(k!.props.body!.multiline).toBe(true);
  });

  it('★ is REFUSED on a non-string rather than ignored', () => {
    // Silently ignoring it leaves an author staring at a single-line field
    // wondering which of the two spellings they got wrong.
    expect(kind({ n: { type: 'number', default: 0, multiline: true } }).errors.join(' '))
      .toMatch(/only meaningful for a string/);
  });

  it('is not stored when false, so a manifest that says so is byte-identical', () => {
    const { kind: k } = kind({ body: { type: 'string', default: '', multiline: false } });
    expect(k!.props.body!.multiline).toBeUndefined();
  });
});

describe('showIf', () => {
  it('hides a property behind a sibling', () => {
    const { kind: k, errors } = kind({
      soft: { type: 'boolean', default: false },
      feather: { type: 'number', default: 0, showIf: { prop: 'soft', equals: true } },
    });
    expect(errors).toEqual([]);
    expect(k!.props.feather!.showIf).toEqual({ prop: 'soft', equals: true });
  });

  it('★ refuses a sibling that does not exist', () => {
    // A dangling reference is a control that never appears, and "my property is
    // missing" sends an author looking at the property rather than at the typo
    // one line above it.
    const { errors } = kind({
      feather: { type: 'number', default: 0, showIf: { prop: 'softt', equals: true } },
    });
    expect(errors.join(' ')).toMatch(/names "softt", which this kind does not declare/);
  });

  it('★ refuses a property that depends on itself', () => {
    // It can never be shown or never hidden, and which one is not obvious from
    // reading it.
    const { errors } = kind({
      feather: { type: 'number', default: 0, showIf: { prop: 'feather', equals: 1 } },
    });
    expect(errors.join(' ')).toMatch(/cannot be the property itself/);
  });

  it('refuses a malformed condition', () => {
    for (const showIf of [{ prop: 'a' }, { equals: 1 }, 'a=1', { prop: 'a', equals: {} }]) {
      const { errors } = kind({
        a: { type: 'boolean', default: false },
        b: { type: 'number', default: 0, showIf },
      });
      expect(errors.length).toBeGreaterThan(0);
    }
  });

  it('accepts a string, number or boolean on the right-hand side', () => {
    for (const equals of ['advanced', 2, true]) {
      const { errors } = kind({
        mode: { type: 'string', default: '' },
        b: { type: 'number', default: 0, showIf: { prop: 'mode', equals } },
      });
      expect(errors).toEqual([]);
    }
  });
});

describe('what the vocabulary still refuses', () => {
  it('★ has no escape hatch for markup, and no type that renders one', () => {
    /*
      The line this whole design exists to hold. If a `html`, `component` or
      `render` prop type ever appears in this list, a plugin can draw a
      permission prompt that looks exactly like the editor's.
    */
    for (const type of ['html', 'component', 'render', 'jsx', 'markdown', 'iframe']) {
      const { errors } = kind({ x: { type, default: '' } });
      expect(errors.join(' ')).toMatch(/must be one of/);
    }
  });
});
