/**
 * The blend picker's menu shape.
 *
 * `BLEND_MODES.group` was documented as "load bearing for the picker's section
 * headers" and read by nobody — a contract with a stated purpose, zero
 * enforcement and zero readers. These tests are the enforcement: they fail if
 * the headers stop being emitted, if a section goes missing, or if the AE
 * ordering the table exists to preserve stops reaching the menu.
 */

import { blendDropdownItems, blendModeLabel, blendModeSections } from './blendMenu';
import { BLEND_MODES } from '@core/effects/blendMode';

describe('blendModeSections', () => {
  it('covers every mode exactly once', () => {
    const flat = blendModeSections().flatMap((s) => s.modes);
    expect(flat).toEqual(BLEND_MODES.map((b) => b.mode));
  });

  it('preserves AE\'s section order', () => {
    expect(blendModeSections().map((s) => s.group)).toEqual([
      'Normal', 'Subtractive', 'Additive', 'Complex', 'Difference', 'HSL', 'Utility', 'Matte',
    ]);
  });
});

describe('blendDropdownItems', () => {
  it('emits a header above each multi-mode section', () => {
    const items = blendDropdownItems('normal', () => undefined);
    const headers = items.filter((i) => i.type === 'label').map((i) => (i as { label: string }).label);
    // A section of one gets no header — a heading over a single item reads as
    // noise rather than structure. Normal WAS that section until the Dissolve
    // pair (M5) joined it; at three modes its header carries real structure,
    // and it is AE's own menu grouping.
    expect(headers).toEqual(['Normal', 'Subtractive', 'Additive', 'Complex', 'Difference', 'HSL', 'Utility', 'Matte']);
  });

  it('offers every mode as a selectable item', () => {
    const items = blendDropdownItems('normal', () => undefined);
    const ids = items.filter((i) => i.type === 'item').map((i) => (i as { id: string }).id);
    expect(ids).toEqual(BLEND_MODES.map((b) => b.mode));
  });

  it('ticks exactly the current mode', () => {
    const items = blendDropdownItems('stencil-luma', () => undefined);
    const ticked = items.filter((i) => i.type === 'item' && (i as { icon?: string }).icon === 'check');
    expect(ticked).toHaveLength(1);
    expect((ticked[0] as { id: string }).id).toBe('stencil-luma');
  });

  it('reports the picked mode', () => {
    const seen: string[] = [];
    const items = blendDropdownItems('normal', (m) => seen.push(m));
    const item = items.find((i) => i.type === 'item' && (i as { id: string }).id === 'silhouette-alpha');
    (item as { onSelect?: () => void }).onSelect?.();
    expect(seen).toEqual(['silhouette-alpha']);
  });
});

describe('blendModeLabel', () => {
  it('falls back to Normal for an unset or unknown mode', () => {
    expect(blendModeLabel(undefined)).toBe('Normal');
    expect(blendModeLabel('nope' as never)).toBe('Normal');
    expect(blendModeLabel('stencil-alpha')).toBe('Stencil Alpha');
  });
});
