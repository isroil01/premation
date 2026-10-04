

import {   extractSvgMarkup } from './clipboard';

describe('extractSvgMarkup', () => {
  test('pulls a bare svg document', () => {
    const svg = extractSvgMarkup('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
    expect(svg).toMatch(/^<svg\b/i);
    expect(svg).toMatch(/<\/svg>$/i);
  });

  test('pulls svg embedded in html', () => {
    const svg = extractSvgMarkup('<div><svg viewBox="0 0 8 8"><circle cx="4" cy="4" r="3"/></svg></div>');
    expect(svg).toContain('<circle');
  });

  test('rejects non-svg text', () => {
    expect(extractSvgMarkup('hello world')).toBeNull();
    expect(extractSvgMarkup('')).toBeNull();
  });
});
