/**
 * The template registry: templates are found by id, unknown ids are refused.
 * (Building and filling a template runs on the engine — the native suites.)
 */

import { getTemplate } from './registry';

describe('template registry', () => {
  it('getTemplate resolves by id and rejects unknown ids', () => {
    expect(getTemplate('title-card')).toBeTruthy();
    expect(getTemplate('nope')).toBeNull();
  });
});
