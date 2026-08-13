/**
 * Cell → field-kind coercion.
 *
 * The table is all strings — a CSV has no types, and JSON numbers are
 * stringified deliberately — so the FIELD decides what a cell means. This is
 * where a spreadsheet's habits meet the scene graph, and where a permissive
 * rule quietly writes NaN into a prop and renders a blank instead of failing.
 *
 * `applyDataRow` itself is not unit-tested here: it mutates the live scene
 * graph through `writeTemplateField` and wraps the writes in a real undo entry,
 * which needs a booted engine rather than a mock worth trusting. Stated as a
 * gap rather than papered over with a stub that would only assert that I called
 * my own function.
 */

import { coerceCell } from './dataFill';

describe('coerceCell', () => {
  describe('number', () => {
    it('parses plain and signed decimals', () => {
      expect(coerceCell('number', '42')).toBe(42);
      expect(coerceCell('number', '-3.5')).toBe(-3.5);
      expect(coerceCell('number', ' 7 ')).toBe(7);
    });

    it('refuses what is not a number instead of writing NaN', () => {
      // Number('abc') is NaN, and NaN in a prop renders as nothing at all —
      // a blank frame with no error is the failure mode to avoid.
      expect(coerceCell('number', 'abc')).toBeNull();
      expect(coerceCell('number', '')).toBeNull();
      expect(coerceCell('number', '12px')).toBeNull();
    });

    it('refuses Infinity, which Number() happily produces', () => {
      expect(coerceCell('number', 'Infinity')).toBeNull();
    });
  });

  describe('color', () => {
    it('accepts 3, 6 and 8 digit hex', () => {
      expect(coerceCell('color', '#abc')).toBe('#abc');
      expect(coerceCell('color', '#5282b8')).toBe('#5282b8');
      expect(coerceCell('color', '#5282b8ff')).toBe('#5282b8ff');
    });

    it('adds a missing #, which is what a spreadsheet strips', () => {
      // A hex column left as plain text loses its leading hash constantly.
      expect(coerceCell('color', '5282b8')).toBe('#5282b8');
    });

    it('refuses a colour it cannot parse', () => {
      expect(coerceCell('color', 'cornflower')).toBeNull();
      expect(coerceCell('color', '#12345')).toBeNull();
      expect(coerceCell('color', '')).toBeNull();
    });
  });

  describe('text', () => {
    it('passes through verbatim, whitespace included', () => {
      // Text is the one kind where trimming would be presumptuous — a leading
      // space in a title may be deliberate.
      expect(coerceCell('text', '  spaced  ')).toBe('  spaced  ');
      expect(coerceCell('text', '')).toBe('');
    });
  });
});
