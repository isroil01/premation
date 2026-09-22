/**
 * The title-bar chip truncates in the MIDDLE, which CSS cannot do on its own:
 * the name is split into a head that shrinks (and ends in "…") and a tail that
 * does not.
 */

import { splitForMiddleEllipsis } from './ProjectStatus';

describe('splitForMiddleEllipsis', () => {
  it('leaves a short name whole — no ellipsis inside "Untitled"', () => {
    expect(splitForMiddleEllipsis('Untitled')).toEqual(['Untitled', '']);
  });

  it('keeps the END of a long name out of the truncating half', () => {
    const [head, tail] = splitForMiddleEllipsis('Client Launch Film — Final Master v7');
    expect(tail).toBe('aster v7');
    expect(head + tail).toBe('Client Launch Film — Final Master v7');
  });

  it('never splits inside a surrogate pair', () => {
    const name = `A very long project name ${'🎬'.repeat(8)}`;
    const [head, tail] = splitForMiddleEllipsis(name);
    expect(tail).toBe('🎬'.repeat(8));
    expect(head + tail).toBe(name);
  });
});
