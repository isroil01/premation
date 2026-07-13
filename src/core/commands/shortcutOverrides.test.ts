import { resolveChord, findChordConflict, type ShortcutOverrides } from './shortcutOverrides';
import type { KeyChord } from '@app-types/common';

const K = (key: string, mods: Partial<KeyChord> = {}): KeyChord => ({ key, ...mods });

describe('resolveChord', () => {
  test('uses the default when there is no override', () => {
    expect(resolveChord('cmd', K('a', { meta: true }), {})).toEqual({ key: 'a', meta: true });
  });

  test('an override chord replaces the default', () => {
    const overrides: ShortcutOverrides = { cmd: K('b', { ctrl: true }) };
    expect(resolveChord('cmd', K('a'), overrides)).toEqual({ key: 'b', ctrl: true });
  });

  test('a null override disables the shortcut (undefined)', () => {
    expect(resolveChord('cmd', K('a'), { cmd: null })).toBeUndefined();
  });

  test('an unset command with no default resolves to undefined', () => {
    expect(resolveChord('cmd', undefined, {})).toBeUndefined();
  });
});

describe('findChordConflict', () => {
  const resolved = [
    { commandId: 'save', chord: K('s', { meta: true }) },
    { commandId: 'open', chord: K('o', { meta: true }) },
    { commandId: 'disabled', chord: undefined },
  ];

  test('returns the command already using the chord', () => {
    expect(findChordConflict(K('s', { meta: true }), 'other', resolved)).toBe('save');
  });

  test('ignores the same command (rebinding to its own chord is fine)', () => {
    expect(findChordConflict(K('s', { meta: true }), 'save', resolved)).toBeNull();
  });

  test('returns null when the chord is free', () => {
    expect(findChordConflict(K('k', { meta: true, shift: true }), 'other', resolved)).toBeNull();
  });

  test('modifier differences are distinct chords', () => {
    // meta+s is taken, but plain s (no modifier) is free.
    expect(findChordConflict(K('s'), 'other', resolved)).toBeNull();
  });

  test('a disabled (undefined-chord) binding never conflicts', () => {
    expect(findChordConflict(K('s', { meta: true }), 'disabled', resolved)).toBe('save');
  });
});
