/**
 * Sanitization and id scoping.
 *
 * Two failure modes, both invisible until they bite:
 *
 *  - a `<script>` or `on*` handler surviving into the DOM we render;
 *  - two copies of the same logo sharing one id namespace, so the second one
 *    silently picks up the first one's gradient. That is THE classic
 *    inline-SVG bug, and it presents as "the duplicate has the wrong colour",
 *    which nobody traces back to id collision.
 */

import { sanitizeSvg, scopeSvgIds, readSvgIntrinsicSize, svgToDataUrl } from './svgSanitize';

const wrap = (inner: string, attrs = 'viewBox="0 0 100 100"'): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${attrs}>${inner}</svg>`;

const parse = (markup: string): Element =>
  new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement;

describe('sanitizeSvg', () => {
  it('removes scripts and event handlers', () => {
    const out = sanitizeSvg(wrap('<script>alert(1)</script><rect onload="alert(1)" width="10"/>'), 'n1');
    expect(out).not.toBeNull();
    expect(out!.markup).not.toMatch(/<script/i);
    expect(out!.markup).not.toMatch(/onload/i);
    expect(out!.changed).toBe(true);
  });

  it('keeps <style> — dropping it would silently restyle the file', () => {
    const out = sanitizeSvg(wrap('<style>.p { fill: red }</style><path class="p" d="M0 0 L1 1"/>'), 'n1');
    expect(out!.markup).toMatch(/fill:\s*red/);
  });

  it('strips remote references, which would make a frame depend on the network', () => {
    const out = sanitizeSvg(wrap('<image href="https://evil.example/x.png" width="10" height="10"/>'), 'n1');
    expect(out!.markup).not.toMatch(/evil\.example/);
  });

  it('keeps local references intact', () => {
    const out = sanitizeSvg(
      wrap('<defs><linearGradient id="g"><stop offset="0"/></linearGradient></defs><rect fill="url(#g)"/>'),
      'n1',
    );
    expect(out!.markup).toMatch(/url\(#n1__g\)/);
  });

  it('reports unchanged for a file it did not have to touch', () => {
    const out = sanitizeSvg(wrap('<rect width="10" height="10" fill="red"/>'), 'n1');
    expect(out!.changed).toBe(false);
  });

  it('returns null for markup that is not an SVG', () => {
    expect(sanitizeSvg('<html><body>nope</body></html>', 'n1')).toBeNull();
    expect(sanitizeSvg('not markup at all', 'n1')).toBeNull();
  });

  it('guarantees a viewBox so the rasterizer can scale to any size', () => {
    const out = sanitizeSvg(wrap('<rect/>', 'width="40" height="20"'), 'n1');
    expect(out!.markup).toMatch(/viewBox="0 0 40 20"/);
  });
});

describe('sanitizeSvg — SMIL animation nodes ("Dark Mode Button" regression)', () => {
  /*
    DOMPurify's svg profile admits animateTransform but silently drops plain
    <animate> and <set> — the two tags every Keyshape/SVGator export uses for
    FILL, OPACITY and VISIBILITY animation. A dark-mode toggle sanitized into a
    permanently-light picture whose transforms still moved: 25 <animate> and
    114 <set> nodes gone, no error anywhere. The tags are re-admitted and only
    the genuinely dangerous instances (attributeName aimed at reference or
    identity attributes) are removed.
  */
  it('keeps <animate> on presentation attributes — the fill/opacity animations', () => {
    const out = sanitizeSvg(wrap(
      '<rect width="10" height="10" fill="#93e5f7">'
      + '<animate attributeName="fill" values="#93e5f7;#13121d" dur="2s"/>'
      + '<animate attributeName="opacity" values="1;0" dur="2s"/>'
      + '</rect>',
    ), 'n1');
    expect((out!.markup.match(/<animate\s/g) ?? []).length).toBe(2);
  });

  it('keeps <set> — visibility switching (sun/moon swaps) depends on it', () => {
    const out = sanitizeSvg(wrap(
      '<circle r="5"><set attributeName="visibility" to="hidden" begin="1s"/></circle>',
    ), 'n1');
    expect(out!.markup).toMatch(/<set\s/);
  });

  it('still removes SMIL aimed at reference/identity attributes', () => {
    const out = sanitizeSvg(wrap(
      '<a href="#safe"><text>x</text>'
      + '<animate attributeName="href" values="javascript:alert(1)" dur="1s"/></a>'
      + '<rect width="5" height="5"><set attributeName="id" to="hijack"/></rect>',
    ), 'n1');
    expect(out!.markup).not.toMatch(/<animate\s/);
    expect(out!.markup).not.toMatch(/<set\s/);
  });
});

describe('sanitizeSvg — what the golden-frame fidelity oracle caught', () => {
  // Both of these rendered as visibly WRONG pixels and passed every unit test:
  // the markup was well-formed, ids were scoped, nothing threw. Only diffing
  // against the untouched source showed content had gone missing.

  it('keeps <use>, which the SVG profile drops by default', () => {
    // `<use href="#icon">` is how essentially every icon set is authored, and
    // DOMPurify's svg profile does not allowlist `use` — so an icon sheet
    // sanitized to an empty <defs> and rendered as nothing at all.
    const out = sanitizeSvg(
      wrap('<defs><symbol id="sq"><rect width="10" height="10"/></symbol></defs><use href="#sq" x="5" y="5"/>'),
      'L',
    );
    expect(out!.markup).toMatch(/<use/);
    expect(out!.markup).toMatch(/href="#L__sq"/);
  });

  it('keeps an id that would otherwise be stripped as DOM-clobbering', () => {
    // DOMPurify removes `id="target"` (it can clobber a DOM property), which
    // silently breaks every url(#target) and #target rule pointing at it.
    // Scoping BEFORE sanitizing makes the id harmless instead of turning the
    // protection off — so this asserts the ORDER of those two passes.
    for (const risky of ['target', 'name', 'body', 'location']) {
      const out = sanitizeSvg(
        wrap(`<style>#${risky} { fill: #f0f }</style><rect id="${risky}" width="10" height="10"/>`),
        'L',
      );
      expect(out!.markup).toMatch(new RegExp(`id="L__${risky}"`));
      expect(out!.markup).toMatch(new RegExp(`#L__${risky}`));
    }
  });
});

describe('sanitizeSvg — determinism (§5)', () => {
  it('is byte-identical across repeated runs for the same input and scope', () => {
    // The stored document is what renders and what the texture cache is keyed
    // on. If sanitizing were non-deterministic, the same project would render
    // differently on reload and every frame would miss the cache.
    const source = wrap(
      '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient></defs>' +
      '<style>#a { fill: url(#g) }</style><rect id="a" width="10" height="10"/><use href="#a"/>',
    );
    const runs = Array.from({ length: 5 }, () => sanitizeSvg(source, 'L')!.markup);
    expect(new Set(runs).size).toBe(1);
  });

  it('is stable under re-sanitizing its own output (idempotent scope aside)', () => {
    // Revert → re-convert round trips through this, so a pass that kept
    // mutating would drift the document a little further every cycle.
    const source = wrap('<defs><linearGradient id="g"/></defs><rect fill="url(#g)"/>');
    const once = sanitizeSvg(source, 'L')!.markup;
    const twice = sanitizeSvg(source, 'L')!.markup;
    expect(twice).toBe(once);
  });
});

describe('scopeSvgIds', () => {
  it('renames ids and every reference to them', () => {
    const root = parse(wrap(
      '<defs><linearGradient id="grad"/><clipPath id="clip"/></defs>' +
      '<rect fill="url(#grad)" clip-path="url(#clip)"/>' +
      '<use href="#grad"/>',
    ));
    scopeSvgIds(root, 'layer7');
    const out = new XMLSerializer().serializeToString(root);

    expect(out).toMatch(/id="layer7__grad"/);
    expect(out).toMatch(/url\(#layer7__grad\)/);
    expect(out).toMatch(/url\(#layer7__clip\)/);
    expect(out).toMatch(/href="#layer7__grad"/);
    // Nothing may still point at the bare name.
    expect(out).not.toMatch(/url\(#grad\)/);
  });

  it('rewrites #id selectors and url() inside <style>', () => {
    const root = parse(wrap('<style>#a { fill: url(#b) }</style><rect id="a"/><linearGradient id="b"/>'));
    scopeSvgIds(root, 'L');
    const css = root.getElementsByTagName('style')[0]!.textContent!;
    expect(css).toMatch(/#L__a/);
    expect(css).toMatch(/url\(#L__b\)/);
  });

  it('does not corrupt a longer id that starts with a shorter one', () => {
    // Rewriting "a" before "ab" would turn #ab into #L__ab's prefix and break it.
    const root = parse(wrap('<rect id="a"/><rect id="ab"/><use href="#ab"/><use href="#a"/>'));
    scopeSvgIds(root, 'L');
    const out = new XMLSerializer().serializeToString(root);
    expect(out).toMatch(/href="#L__ab"/);
    expect(out).toMatch(/href="#L__a"/);
    expect(out).not.toMatch(/L__L__/);
  });

  it('rewrites SMIL sync-base timing, which references ids by bare name', () => {
    const root = parse(wrap('<rect id="first"><animate id="a1" dur="1s"/></rect><rect><animate begin="a1.end" dur="1s"/></rect>'));
    scopeSvgIds(root, 'L');
    const out = new XMLSerializer().serializeToString(root);
    expect(out).toMatch(/begin="L__a1\.end"/);
  });

  it('gives two copies of the same file disjoint id namespaces', () => {
    const markup = wrap('<defs><linearGradient id="g"/></defs><rect fill="url(#g)"/>');
    const a = sanitizeSvg(markup, 'nodeA')!;
    const b = sanitizeSvg(markup, 'nodeB')!;
    expect(a.markup).toMatch(/url\(#nodeA__g\)/);
    expect(b.markup).toMatch(/url\(#nodeB__g\)/);
    expect(a.markup).not.toEqual(b.markup);
  });
});

describe('readSvgIntrinsicSize', () => {
  it('prefers explicit width/height', () => {
    expect(readSvgIntrinsicSize(parse(wrap('', 'width="40" height="20" viewBox="0 0 100 100"'))))
      .toMatchObject({ width: 40, height: 20 });
  });

  it('falls back to the viewBox', () => {
    expect(readSvgIntrinsicSize(parse(wrap('', 'viewBox="0 0 300 150"'))))
      .toMatchObject({ width: 300, height: 150, viewBox: [0, 0, 300, 150] });
  });

  it('derives the missing axis from the viewBox aspect', () => {
    expect(readSvgIntrinsicSize(parse(wrap('', 'width="200" viewBox="0 0 100 50"'))))
      .toMatchObject({ width: 200, height: 100 });
  });

  it('uses a square default rather than the browser 300x150 when nothing is stated', () => {
    expect(readSvgIntrinsicSize(parse('<svg xmlns="http://www.w3.org/2000/svg"/>')))
      .toMatchObject({ width: 512, height: 512 });
  });
});

describe('svgToDataUrl', () => {
  it('round-trips non-ASCII content', () => {
    const markup = wrap('<text>안녕 — café</text>');
    const url = svgToDataUrl(markup);
    expect(url.startsWith('data:image/svg+xml;base64,')).toBe(true);
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(url.split(',')[1]!), (c) => c.charCodeAt(0)),
    );
    expect(decoded).toBe(markup);
  });
});
