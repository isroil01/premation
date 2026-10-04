/**
 * Effect copy/paste and presets.
 *
 * The load-bearing assertion is IDENTITY: a pasted effect must not share an id
 * with its source, because ids key both the keyframe prop paths
 * (`effect.<id>.<param>`) and the renderer's per-effect caching. Two layers
 * sharing one id means editing either one moves both.
 */


import {
  clearEffectClipboard,
  listEffectPresets,
} from './effectClipboard';
import { listBuiltinEffectPresets } from './builtinEffectPresets';

/** Names of the USER presets — `listEffectPresets` also returns the built-in
 *  library, which is always present and is not what these assertions are about. */
function userPresetNames(): string[] {
  const builtin = new Set(listBuiltinEffectPresets().map((p) => p.name));
  return listEffectPresets().map((p) => p.name).filter((n) => !builtin.has(n));
}

beforeEach(() => {
  clearEffectClipboard();
  localStorage.clear();
});

describe('effect presets', () => {

  it('survives unreadable storage rather than throwing', () => {
    localStorage.setItem('motion-editor.effectPresets.v1', 'not json');
    // Degrades to the built-in library rather than throwing or returning junk:
    // corrupt USER storage must not take the shipped looks down with it.
    expect(() => listEffectPresets()).not.toThrow();
    expect(userPresetNames()).toEqual([]);
    // By NAME, not by deep equality: each call mints fresh effect ids for the
    // built-ins (that is what keeps two layers from sharing one), so two lists
    // are never structurally equal even when they hold the same presets.
    expect(listEffectPresets().map((p) => p.name))
      .toEqual(listBuiltinEffectPresets().map((p) => p.name));
  });
});
