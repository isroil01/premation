/**
 * "Select All with This Label" — the matching rule.
 *
 * Tested against `matchLabelColor`, the pure half, because the interesting
 * cases are about what COUNTS as a match rather than about the scene walk: the
 * unlabelled set has to be a first-class answer, and a near-miss colour must
 * not be swept in with an exact one.
 */

import { matchLabelColor } from './labelColor';
import type { SceneNode } from '@core/types';

/** Only `id` and `color` are read; the rest of SceneNode is irrelevant here. */
const n = (id: string, color?: string): SceneNode => ({ id, color } as unknown as SceneNode);

describe('matchLabelColor', () => {
  const nodes = [
    n('a', '#5282b8'),
    n('b'),
    n('c', '#4ea885'),
    n('d', '#5282b8'),
    n('e'),
  ];

  it('finds every node sharing a colour, in scene order', () => {
    expect(matchLabelColor(nodes, '#5282b8')).toEqual(['a', 'd']);
  });

  it('treats "no label" as a real match, not as no answer', () => {
    // Sweeping up the untagged layers is how you find what you forgot to
    // label, and is exactly as useful as sweeping up the blue ones.
    expect(matchLabelColor(nodes, undefined)).toEqual(['b', 'e']);
  });

  it('matches exactly — a different colour is not a near miss', () => {
    expect(matchLabelColor(nodes, '#5282B8')).toEqual([]);
    expect(matchLabelColor(nodes, '#000000')).toEqual([]);
  });

  it('returns a single match without special-casing it', () => {
    expect(matchLabelColor(nodes, '#4ea885')).toEqual(['c']);
  });

  it('is empty for an empty scene', () => {
    expect(matchLabelColor([], undefined)).toEqual([]);
  });
});
