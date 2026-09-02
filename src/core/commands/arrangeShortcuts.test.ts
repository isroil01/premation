/**
 * The Arrange chords have to survive the trip from a real keydown to a binding.
 *
 * Two normalizations stand between them, and each one hid a dead key:
 *
 *  • **Modifier.** Every command in this app declares `meta: true` and
 *    `resolveChord` rewrites that to `ctrl` off macOS. Without it Ctrl+] would
 *    look for a Meta chord on Windows and Linux.
 *  • **Character vs physical key.** `e.key` is the PRODUCED CHARACTER, so
 *    Shift+] reports `}`. Bring to Front is bound to `{ key: ']', shift: true }`
 *    and therefore built the key `Ctrl+Shift+}` — which nothing claims. Bring
 *    to Front and Send to Back were printed in the Layer menu with chords that
 *    could not fire, while their unshifted siblings worked; `chordKeyFromEvent`
 *    resolves the bracket row from `e.code` for exactly that reason.
 *
 * Asserted against `chordKey`, the string the dispatcher actually compares.
 */

import { chordFromEvent } from './CommandSystem';
import { chordKey } from './Command';
import { resolveChord } from './shortcutOverrides';
import type { KeyChord } from '@app-types/common';

/** A keydown as the browser reports it on a US layout. */
function keydown(init: { key: string; code: string; ctrl?: boolean; shift?: boolean }): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    key: init.key,
    code: init.code,
    ctrlKey: init.ctrl === true,
    shiftKey: init.shift === true,
  });
}

/** The chord the four Arrange commands declare in Providers. */
const ARRANGE: Record<string, KeyChord> = {
  'layer.bringToFront': { key: ']', meta: true, shift: true },
  'layer.bringForward': { key: ']', meta: true },
  'layer.sendBackward': { key: '[', meta: true },
  'layer.sendToBack': { key: '[', meta: true, shift: true },
};

/** What the dispatcher binds on Windows/Linux, where meta becomes ctrl. */
function boundKey(commandId: string): string {
  const chord = resolveChord(commandId, ARRANGE[commandId], {});
  // `resolveChord` short-circuits its platform rewrite under NODE_ENV=test, so
  // the mapping is applied here explicitly rather than depending on the env.
  const pc: KeyChord = chord!.meta ? { ...chord!, meta: false, ctrl: true } : chord!;
  return chordKey(pc);
}

describe('the Ctrl+[ / Ctrl+] family reaches its command', () => {
  it('Ctrl+] matches Bring Forward', () => {
    expect(chordKey(chordFromEvent(keydown({ key: ']', code: 'BracketRight', ctrl: true }))))
      .toBe(boundKey('layer.bringForward'));
  });

  it('Ctrl+[ matches Send Backward', () => {
    expect(chordKey(chordFromEvent(keydown({ key: '[', code: 'BracketLeft', ctrl: true }))))
      .toBe(boundKey('layer.sendBackward'));
  });

  it('Ctrl+Shift+] matches Bring to Front — the browser reports the key as "}"', () => {
    expect(chordKey(chordFromEvent(keydown({ key: '}', code: 'BracketRight', ctrl: true, shift: true }))))
      .toBe(boundKey('layer.bringToFront'));
  });

  it('Ctrl+Shift+[ matches Send to Back — the browser reports the key as "{"', () => {
    expect(chordKey(chordFromEvent(keydown({ key: '{', code: 'BracketLeft', ctrl: true, shift: true }))))
      .toBe(boundKey('layer.sendToBack'));
  });

  it('the four chords stay distinct from each other', () => {
    const keys = Object.keys(ARRANGE).map(boundKey);
    expect(new Set(keys).size).toBe(4);
  });

  it('the bracket resolution does not touch a key that is not on the bracket row', () => {
    // The branch reads `e.code`, so a shifted character produced anywhere else
    // is left exactly as the browser reported it.
    expect(chordKey(chordFromEvent(keydown({ key: '"', code: 'Quote', ctrl: true, shift: true }))))
      .toBe('Ctrl+Shift+"');
  });
});
