/**
 * Text-animator prop paths must read as properties, not as paths.
 *
 * `ta.0.offset` is the single most-keyframed path in the text system — every
 * reveal preset animates it — and it rendered in the timeline as "Ta.0.offset"
 * through the raw-path fallback. Apply "Cascade", open the timeline, and the
 * row told you nothing about what it was.
 */

import { resolvePropertyMeta, propertyLabel, hasPropertyMeta } from './propertyMeta';

describe('text animator property metadata', () => {
  it('labels an animator property without a node', () => {
    // No nodeId: the registry cannot know the animator's name, but must still
    // beat the raw path.
    expect(propertyLabel('ta.0.x')).toBe('Animator 1 Position X');
    expect(propertyLabel('ta.2.rotation')).toBe('Animator 3 Rotation');
  });

  it('labels the legacy flat selector params', () => {
    // These kept their un-namespaced paths so existing projects keep animating;
    // they still have to read correctly.
    expect(propertyLabel('ta.0.offset')).toBe('Animator 1 Offset');
    expect(propertyLabel('ta.0.start')).toBe('Animator 1 Start');
    expect(propertyLabel('ta.1.wiggleFreq')).toBe('Animator 2 Wiggles/Second');
  });

  it('labels a namespaced selector param', () => {
    expect(propertyLabel('ta.0.s1.amount')).toBe('Animator 1 Amount');
    expect(propertyLabel('ta.0.s2.correlation')).toBe('Animator 1 Correlation');
  });

  it('claims these paths rather than leaving them to the fallback', () => {
    expect(hasPropertyMeta('ta.0.offset')).toBe(true);
    expect(hasPropertyMeta('ta.3.s2.easeHigh')).toBe(true);
  });

  it('carries the right unit and type for display', () => {
    expect(resolvePropertyMeta('ta.0.offset')).toMatchObject({ unit: '%', type: 'percent' });
    expect(resolvePropertyMeta('ta.0.rotation')).toMatchObject({ unit: '°', type: 'angle' });
    expect(resolvePropertyMeta('ta.0.x')).toMatchObject({ unit: 'px', type: 'number' });
    expect(resolvePropertyMeta('ta.0.wiggleFreq')).toMatchObject({ unit: 'Hz' });
    expect(resolvePropertyMeta('ta.0.characterOffset')).toMatchObject({ unit: '' });
  });

  it('groups them with text, not with "other"', () => {
    expect(resolvePropertyMeta('ta.0.offset').group).toBe('text');
  });

  it('falls back gracefully for a parameter it has never heard of', () => {
    // A parameter added later should still read as a title, and still be
    // attributed to its animator.
    expect(propertyLabel('ta.0.someNewThing')).toBe('Animator 1 Some New Thing');
  });

  it('does not claim paths that only look like animator paths', () => {
    // The regex must not swallow neighbouring families.
    for (const p of ['tab.0.x', 'ta.x', 'ta..x', 'ta.0.', 'talk']) {
      expect({ path: p, label: propertyLabel(p) }).not.toEqual({
        path: p,
        label: expect.stringContaining('Animator'),
      });
    }
  });

  it('still resolves ordinary paths unchanged', () => {
    // Guard against the new resolver shadowing anything.
    expect(propertyLabel('opacity')).toBe('Opacity');
    expect(propertyLabel('x')).toBe('Position X');
  });
});
