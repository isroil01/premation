import { render, screen } from '@testing-library/react';
import { Kbd, splitChord } from './Kbd';

describe('splitChord', () => {
  it('splits the human spelling on +', () => {
    expect(splitChord('Ctrl+Shift+P')).toEqual(['Ctrl', 'Shift', 'P']);
  });

  it('splits formatChord output, which has no separators', () => {
    expect(splitChord('⌘⇧K')).toEqual(['⌘', '⇧', 'K']);
    expect(splitChord('Ctrl⇧K')).toEqual(['Ctrl', '⇧', 'K']);
    expect(splitChord('Ctrl⌥Enter')).toEqual(['Ctrl', '⌥', 'Enter']);
  });

  it('reads a trailing + as the plus KEY, not a separator', () => {
    expect(splitChord('Ctrl++')).toEqual(['Ctrl', '+']);
    expect(splitChord('+')).toEqual(['+']);
  });

  it('keeps a multi-character key whole', () => {
    expect(splitChord('Ctrl+ArrowDown')).toEqual(['Ctrl', 'ArrowDown']);
    expect(splitChord('Escape')).toEqual(['Escape']);
    // A modifier WORD alone is a key, not a prefix of nothing.
    expect(splitChord('Shift')).toEqual(['Shift']);
  });
});

describe('Kbd', () => {
  it('renders one keycap per key and names the chord for assistive tech', () => {
    render(<Kbd chord="Ctrl+Shift+P" />);
    const root = screen.getByLabelText('Ctrl Shift P');
    expect(root.tagName).toBe('KBD');
    expect(root.querySelectorAll('kbd')).toHaveLength(3);
    expect(root.textContent).toBe('CtrlShiftP');
  });

  it('exposes the size on the root', () => {
    render(<Kbd chord="K" size="sm" />);
    expect(screen.getByLabelText('K')).toHaveAttribute('data-size', 'sm');
  });
});
