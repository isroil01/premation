/**
 * Illustrator / SVG paste (AE 26.3).
 *
 * Two things are pinned. The DECISION — which clipboard flavours count as an
 * SVG paste and which must be left alone — is a pure function, so it is tested
 * as one. And the ROUTE: a paste with SVG on the OS clipboard lands in the
 * scene through the same importer a dropped .svg file takes, and only after
 * the app's own clipboard has been consulted.
 */



import { detectClipboardSvg, extractSvgMarkup, isSvgDocumentText } from './clipboard';

const RECT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#0af"/></svg>';
const XML_SVG = `<?xml version="1.0" encoding="UTF-8"?>\n<!-- Generator: Adobe Illustrator -->\n${RECT_SVG}`;
const NESTED_SVG = '<svg viewBox="0 0 20 20"><svg x="5" y="5" width="10" height="10"><circle cx="5" cy="5" r="4"/></svg><rect width="2" height="2"/></svg>';

describe('isSvgDocumentText — the strict text/plain gate', () => {
  it('accepts a bare <svg> document', () => {
    expect(isSvgDocumentText(RECT_SVG)).toBe(true);
    expect(isSvgDocumentText(`   \n${RECT_SVG}\n`)).toBe(true);
  });

  it('accepts an XML prolog / Illustrator comment / doctype before the root', () => {
    expect(isSvgDocumentText(XML_SVG)).toBe(true);
    expect(isSvgDocumentText(`<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd">${RECT_SVG}`)).toBe(true);
  });

  it('rejects prose and code that merely CONTAIN an <svg>', () => {
    expect(isSvgDocumentText('hello world')).toBe(false);
    expect(isSvgDocumentText(`const Icon = () => (${RECT_SVG});`)).toBe(false);
    expect(isSvgDocumentText(`<div>${RECT_SVG}</div>`)).toBe(false);
    expect(isSvgDocumentText('<?xml version="1.0"?><note>not svg</note>')).toBe(false);
    expect(isSvgDocumentText('<svgfoo>')).toBe(false);
    expect(isSvgDocumentText('')).toBe(false);
  });

  it('rejects the app\'s own layer-clipboard JSON', () => {
    expect(isSvgDocumentText('{"node":{"id":"a"},"animation":{}}')).toBe(false);
  });
});

describe('extractSvgMarkup', () => {
  it('keeps a NESTED <svg> intact instead of cutting at the inner close tag', () => {
    const out = extractSvgMarkup(`<meta charset="utf-8">${NESTED_SVG}`);
    expect(out).toBe(NESTED_SVG);
  });

  it('returns a self-closing <svg/> as an (empty) document', () => {
    expect(extractSvgMarkup('<svg xmlns="http://www.w3.org/2000/svg"/>')).toBe('<svg xmlns="http://www.w3.org/2000/svg"/>');
  });

  it('returns null for an unterminated element', () => {
    expect(extractSvgMarkup('<svg viewBox="0 0 1 1"><rect/>')).toBeNull();
  });
});

describe('detectClipboardSvg — flavour priority', () => {
  it('takes a declared image/svg+xml item first', () => {
    const out = detectClipboardSvg([
      { type: 'text/plain', text: 'some caption' },
      { type: 'image/svg+xml', text: RECT_SVG },
    ]);
    expect(out).toBe(RECT_SVG);
  });

  it('pulls an SVG wrapped in HTML (browser / Figma clipboards)', () => {
    const out = detectClipboardSvg([
      { type: 'text/html', text: `<meta charset='utf-8'><div>${RECT_SVG}</div>` },
      { type: 'text/plain', text: 'not svg' },
    ]);
    expect(out).toBe(RECT_SVG);
  });

  it('accepts Illustrator\'s plain-text SVG markup', () => {
    expect(detectClipboardSvg([{ type: 'text/plain', text: XML_SVG }])).toBe(RECT_SVG);
    expect(detectClipboardSvg([{ type: 'text/plain', text: RECT_SVG }])).toBe(RECT_SVG);
  });

  it('never swallows ordinary text, even when it mentions an <svg>', () => {
    expect(detectClipboardSvg([{ type: 'text/plain', text: 'hello' }])).toBeNull();
    expect(detectClipboardSvg([{ type: 'text/plain', text: `export const Icon = () => ${RECT_SVG};` }])).toBeNull();
    expect(detectClipboardSvg([{ type: 'text/plain', text: '{"node":{}}' }])).toBeNull();
    expect(detectClipboardSvg([])).toBeNull();
  });

  it('ignores flavours it does not read (a PNG is not an SVG paste)', () => {
    expect(detectClipboardSvg([{ type: 'image/png', text: RECT_SVG }])).toBeNull();
  });

  it('does not stop at an item\'s first flavour when a later one holds the SVG', () => {
    // The old reader picked the first matching type per item and gave up.
    const out = detectClipboardSvg([
      { type: 'text/html', text: '<p>caption only</p>' },
      { type: 'image/svg+xml', text: RECT_SVG },
    ]);
    expect(out).toBe(RECT_SVG);
  });
});
