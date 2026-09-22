import { chordKeys, formatChord } from './formatChord';

/**
 * The labels a Windows user was shown — "Ctrl⌥⇧L", "⇧Q", "CtrlT" — name keys
 * no PC keyboard has, run together so "CtrlT" reads as a word.
 */
describe('formatChord', () => {
  it('spells a PC chord with the words on the keycaps, joined by +', () => {
    expect(formatChord({ key: 'l', ctrl: true, alt: true, shift: true }, false)).toBe('Ctrl+Alt+Shift+L');
    expect(formatChord({ key: 'q', shift: true }, false)).toBe('Shift+Q');
    expect(formatChord({ key: 't', ctrl: true }, false)).toBe('Ctrl+T');
    expect(formatChord({ key: 'z', ctrl: true, shift: true }, false)).toBe('Ctrl+Shift+Z');
    expect(formatChord({ key: 'ArrowDown', alt: true }, false)).toBe('Alt+ArrowDown');
  });

  it('keeps Mac chords as glyphs, run together, in Apple order', () => {
    expect(formatChord({ key: 'k', meta: true, shift: true }, true)).toBe('⇧⌘K');
    expect(formatChord({ key: 'l', ctrl: true, alt: true, shift: true, meta: true }, true)).toBe('⌃⌥⇧⌘L');
  });

  it('contains no Mac glyph on a PC keyboard', () => {
    const label = formatChord({ key: 'x', ctrl: true, alt: true, shift: true, meta: true }, false);
    expect(label).not.toMatch(/[⌘⌥⇧⌃]/);
  });

  it('follows the keyboard the page runs on by default', () => {
    // jsdom reports no Mac platform.
    expect(formatChord({ key: 's', ctrl: true })).toBe('Ctrl+S');
  });

  it('yields one keycap per key', () => {
    expect(chordKeys({ key: '+', ctrl: true }, false)).toEqual(['Ctrl', '+']);
  });
});
