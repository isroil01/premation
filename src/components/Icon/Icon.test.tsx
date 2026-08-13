/**
 * Every name in the vocabulary draws something.
 *
 * WHY THIS EXISTS. The glyphs are no longer components imported one per name —
 * they are path strings in a GENERATED table, produced from a mapping that lives
 * in a build script. That is a better arrangement, but it moves the failure mode:
 * a name can now go missing without anything failing to compile, because
 * `Record<IconName, …>` is satisfied by an entry whose value is an empty string,
 * and a `<path d="">` renders as nothing at all. A blank 16px square in a
 * toolbar is exactly the kind of thing that ships.
 *
 * So this asserts the property the type system cannot: that resolving a name
 * ends in real geometry, in both grades of the fill axis, for all of them.
 *
 * Plain Jest matchers only — jest-dom is imported at runtime by jest.setup.ts,
 * but that file sits outside tsconfig's `include`, so its matcher types are not
 * visible to `tsc -b`.
 */
import { render } from '@testing-library/react';

import { Icon, ICON_NAMES, type IconName, type IconWeight } from './Icon';
import { SHARP_ICON_PATHS } from './sharpIconPaths';

function pathOf(name: IconName, weight?: IconWeight): string {
  const { container } = render(<Icon name={name} weight={weight} />);
  const path = container.querySelector('path');
  return path?.getAttribute('d') ?? '';
}

describe('the icon vocabulary resolves to geometry', () => {
  it.each(ICON_NAMES.map((n) => [n]))('%s draws an outline and a fill', (name) => {
    // 20 is well under the shortest real glyph and well over "" or "M0 0Z",
    // which is the class of thing a broken generator run would leave behind.
    expect(pathOf(name, 'regular').length).toBeGreaterThan(20);
    expect(pathOf(name, 'fill').length).toBeGreaterThan(20);
  });

  it('draws the solid grade by default', () => {
    // The default is the whole point of the set reading as solid, and it is a
    // one-word edit away from silently reverting to outline.
    expect(pathOf('folder')).toBe(pathOf('folder', 'fill'));
    expect(pathOf('folder')).not.toBe(pathOf('folder', 'regular'));
  });

  it('buckets the heavy weight names onto the solid grade', () => {
    // `bold` and `duotone` have no stroke to thicken here, so they resolve to
    // solid rather than becoming inert — see IconWeight in Icon.tsx.
    expect(pathOf('export', 'bold')).toBe(pathOf('export', 'fill'));
    expect(pathOf('export', 'light')).toBe(pathOf('export', 'regular'));
  });

  it('has a path for exactly the declared names, no more and no fewer', () => {
    // Guards the generator's two halves against drifting apart: a name added to
    // `iconNames.ts` without a mapping, or a mapping left behind after a name
    // was removed. The script itself throws on both, but only if someone runs it.
    expect(Object.keys(SHARP_ICON_PATHS).sort()).toEqual([...ICON_NAMES].sort());
  });

  it('draws the AI wordmark rather than a glyph from the set', () => {
    // `ai` is the one name the set does not serve — it is a lockup, and it is
    // drawn inline in the component. If that branch is ever dropped the name
    // still resolves, so the mistake would be silent without this.
    const { container } = render(<Icon name="ai" />);
    expect(container.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 34 34');
    expect(container.querySelectorAll('path').length).toBeGreaterThan(1);
  });

  it('gives the fill weight different geometry from the outline', () => {
    // The fill axis is the only thing `weight` still selects, so if the two
    // grades ever collapse to the same string the prop has quietly become inert.
    expect(pathOf('play', 'fill')).not.toBe(pathOf('play', 'regular'));
  });
});
