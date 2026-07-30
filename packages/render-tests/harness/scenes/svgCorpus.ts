/**
 * SVG corpus for the golden-frame suite (§10).
 *
 * ~40 files chosen to span what real SVGs actually contain — the features the
 * OLD import pipeline had to approximate and this one reproduces verbatim:
 * gradients, masks, clip paths, patterns, filters, markers, nested transforms,
 * text, `<use>`/`<symbol>`, viewBox variants, and stroke geometry.
 *
 * Each entry is rendered TWICE by the suite: once as a real SVG layer (through
 * sanitize + id-scoping + the texture pipeline) and once as its untouched
 * source. Diffing those two is the actual fidelity oracle — it answers "did our
 * pipeline change the pixels?", which a self-blessed reference PNG cannot.
 *
 * Every file is 100×100 in user units so scenes are uniform and a regression
 * shows up as a shape change rather than a layout shift.
 */

export interface SvgCorpusEntry {
  /** Kebab-case; becomes the scene id (`svg-<name>`). */
  name: string;
  /** What this file probes. */
  description: string;
  markup: string;
  /**
   * Fraction of pixels allowed to differ from the untouched source (§10 asks
   * for <1%). Raise ONLY with a documented reason — a per-file exception is a
   * statement that our pipeline changes this file's pixels on purpose.
   */
  fidelityTolerance?: number;
  /** Why this file needs a raised tolerance. Required when one is set. */
  exception?: string;
  /**
   * Fraction of pixels allowed to differ from the COMMITTED reference PNG
   * (the gpu-oracle gate), when the default 0.5% is too tight. Distinct from
   * `fidelityTolerance`: the fidelity twin renders on the same machine and is
   * immune to rasterizer differences, but the committed reference was blessed
   * on real hardware while CI renders with SwiftShader — scenes dominated by
   * font or AA edge pixels sit right on the default line.
   */
  tolerance?: number;
}

const svg = (inner: string, attrs = 'viewBox="0 0 100 100"'): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${attrs}>${inner}</svg>`;

export const SVG_CORPUS: SvgCorpusEntry[] = [
  // ── Basic geometry ────────────────────────────────────────────────────────
  {
    name: 'rect',
    description: 'Plain filled rectangle — the baseline.',
    markup: svg('<rect x="10" y="20" width="80" height="60" fill="#3a7bd5"/>'),
  },
  {
    name: 'circle',
    description: 'Filled circle — curve rasterization.',
    markup: svg('<circle cx="50" cy="50" r="40" fill="#e4572e"/>'),
  },
  {
    name: 'ellipse',
    description: 'Ellipse with independent radii.',
    markup: svg('<ellipse cx="50" cy="50" rx="45" ry="25" fill="#17bebb"/>'),
  },
  {
    name: 'polygon',
    description: 'Closed polygon (star) — even-odd vs nonzero fill.',
    markup: svg('<polygon points="50,5 61,39 98,39 68,61 79,95 50,73 21,95 32,61 2,39 39,39" fill="#ffc914"/>'),
  },
  {
    name: 'polyline',
    description: 'Open polyline, stroked not filled.',
    markup: svg('<polyline points="10,80 30,20 50,70 70,10 90,60" fill="none" stroke="#2e282a" stroke-width="6"/>'),
  },
  {
    name: 'path-cubic',
    description: 'Cubic bezier path with a closed subpath.',
    markup: svg('<path d="M10 80 C 20 10, 80 10, 90 80 L 50 95 Z" fill="#76b041"/>'),
  },
  {
    name: 'path-arc',
    description: 'Elliptical arc command — the parser approximated these.',
    markup: svg('<path d="M20 50 A 30 20 0 1 1 80 50 L 50 90 Z" fill="#9b5de5"/>'),
  },
  {
    name: 'path-evenodd',
    description: 'fill-rule evenodd — a hole the nonzero rule would fill.',
    markup: svg('<path d="M10 10 H90 V90 H10 Z M30 30 H70 V70 H30 Z" fill="#f15bb5" fill-rule="evenodd"/>'),
  },

  // ── Gradients ─────────────────────────────────────────────────────────────
  {
    name: 'gradient-linear',
    description: 'Linear gradient fill via url(#id) — the id-scoping path.',
    markup: svg(
      '<defs><linearGradient id="g"><stop offset="0" stop-color="#ff0057"/><stop offset="1" stop-color="#0091ff"/></linearGradient></defs>' +
      '<rect width="100" height="100" fill="url(#g)"/>',
    ),
  },
  {
    name: 'gradient-radial',
    description: 'Radial gradient with focal offset.',
    markup: svg(
      '<defs><radialGradient id="r" cx="0.3" cy="0.3" r="0.8"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#003049"/></radialGradient></defs>' +
      '<circle cx="50" cy="50" r="48" fill="url(#r)"/>',
    ),
  },
  {
    name: 'gradient-transform',
    description: 'gradientTransform — a rotation the shape parser dropped entirely.',
    markup: svg(
      '<defs><linearGradient id="gt" gradientTransform="rotate(45 0.5 0.5)"><stop offset="0" stop-color="#fca311"/><stop offset="1" stop-color="#14213d"/></linearGradient></defs>' +
      '<rect width="100" height="100" fill="url(#gt)"/>',
    ),
  },
  {
    name: 'gradient-stop-opacity',
    description: 'stop-opacity — gradient alpha, not just colour.',
    markup: svg(
      '<defs><linearGradient id="go"><stop offset="0" stop-color="#e63946" stop-opacity="1"/><stop offset="1" stop-color="#e63946" stop-opacity="0"/></linearGradient></defs>' +
      '<rect width="100" height="100" fill="url(#go)"/>',
    ),
  },
  {
    name: 'gradient-spread-reflect',
    description: 'spreadMethod=reflect on a sub-unit gradient.',
    markup: svg(
      '<defs><linearGradient id="gs" x1="0" x2="0.25" spreadMethod="reflect"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient></defs>' +
      '<rect width="100" height="100" fill="url(#gs)"/>',
    ),
  },
  {
    name: 'gradient-userspace',
    description: 'gradientUnits=userSpaceOnUse — coordinates in user units.',
    markup: svg(
      '<defs><linearGradient id="gu" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="100">' +
      '<stop offset="0" stop-color="#06d6a0"/><stop offset="1" stop-color="#ef476f"/></linearGradient></defs>' +
      '<rect width="100" height="100" fill="url(#gu)"/>',
    ),
  },

  // ── Masks, clips, patterns ────────────────────────────────────────────────
  {
    name: 'mask-luminance',
    description: 'Luminance mask — flattened to a solid fill by the old path.',
    markup: svg(
      '<defs><mask id="m"><rect width="100" height="100" fill="#fff"/><circle cx="50" cy="50" r="30" fill="#000"/></mask></defs>' +
      '<rect width="100" height="100" fill="#ff595e" mask="url(#m)"/>',
    ),
  },
  {
    name: 'mask-gradient',
    description: 'Gradient mask — a soft alpha ramp, not a hard cut.',
    markup: svg(
      '<defs><linearGradient id="mg"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient>' +
      '<mask id="m2"><rect width="100" height="100" fill="url(#mg)"/></mask></defs>' +
      '<rect width="100" height="100" fill="#1982c4" mask="url(#m2)"/>',
    ),
  },
  {
    name: 'clip-path-shape',
    description: 'clipPath with a circle — hard-edged clip.',
    markup: svg(
      '<defs><clipPath id="c"><circle cx="50" cy="50" r="35"/></clipPath></defs>' +
      '<rect width="100" height="100" fill="#8ac926" clip-path="url(#c)"/>',
    ),
  },
  {
    name: 'clip-path-nested',
    description: 'clipPath applied to a group containing several shapes.',
    markup: svg(
      '<defs><clipPath id="cn"><rect x="20" y="20" width="60" height="60"/></clipPath></defs>' +
      '<g clip-path="url(#cn)"><circle cx="30" cy="30" r="25" fill="#6a4c93"/><circle cx="70" cy="70" r="25" fill="#ffca3a"/></g>',
    ),
  },
  {
    name: 'pattern-tile',
    description: 'Pattern fill — repeats a tile the shape parser could not express.',
    markup: svg(
      '<defs><pattern id="p" width="20" height="20" patternUnits="userSpaceOnUse">' +
      '<rect width="20" height="20" fill="#264653"/><circle cx="10" cy="10" r="6" fill="#e9c46a"/></pattern></defs>' +
      '<rect width="100" height="100" fill="url(#p)"/>',
    ),
  },

  // ── Filters ───────────────────────────────────────────────────────────────
  {
    name: 'filter-blur',
    description: 'feGaussianBlur.',
    markup: svg(
      '<defs><filter id="fb"><feGaussianBlur stdDeviation="4"/></filter></defs>' +
      '<circle cx="50" cy="50" r="30" fill="#e76f51" filter="url(#fb)"/>',
    ),
  },
  {
    name: 'filter-drop-shadow',
    description: 'feDropShadow.',
    markup: svg(
      '<defs><filter id="fd"><feDropShadow dx="4" dy="4" stdDeviation="3" flood-color="#000" flood-opacity="0.6"/></filter></defs>' +
      '<rect x="20" y="20" width="55" height="55" fill="#2a9d8f" filter="url(#fd)"/>',
    ),
  },
  {
    name: 'filter-color-matrix',
    description: 'feColorMatrix saturate.',
    markup: svg(
      '<defs><filter id="fc"><feColorMatrix type="saturate" values="0.2"/></filter></defs>' +
      '<rect width="100" height="100" fill="#ff006e" filter="url(#fc)"/>',
    ),
  },

  // ── Transforms ────────────────────────────────────────────────────────────
  {
    name: 'transform-nested',
    description: 'Nested group transforms — the hierarchy the old path had to flatten.',
    markup: svg(
      '<g transform="translate(50 50)"><g transform="rotate(30)"><g transform="scale(1.4 0.7)">' +
      '<rect x="-30" y="-30" width="60" height="60" fill="#3d5a80"/></g></g></g>',
    ),
  },
  {
    name: 'transform-matrix',
    description: 'Raw matrix() with skew — not decomposable into translate/rotate/scale.',
    markup: svg('<rect x="10" y="10" width="50" height="50" fill="#ee6c4d" transform="matrix(1 0.3 0.2 1 5 5)"/>'),
  },
  {
    name: 'transform-rotate-origin',
    description: 'rotate() about an explicit centre.',
    markup: svg('<rect x="30" y="30" width="40" height="40" fill="#98c1d9" transform="rotate(45 50 50)"/>'),
  },

  // ── Strokes ───────────────────────────────────────────────────────────────
  {
    name: 'stroke-dasharray',
    description: 'Dashed stroke with an offset.',
    markup: svg('<circle cx="50" cy="50" r="35" fill="none" stroke="#293241" stroke-width="8" stroke-dasharray="12 6" stroke-dashoffset="4"/>'),
  },
  {
    name: 'stroke-linecap-join',
    description: 'Round caps and joins on an open path.',
    markup: svg('<path d="M15 75 L50 20 L85 75" fill="none" stroke="#f4a261" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/>'),
  },
  {
    name: 'stroke-miter',
    description: 'Miter join with a tight angle — miterlimit behaviour.',
    markup: svg('<path d="M20 80 L50 20 L80 80" fill="none" stroke="#606c38" stroke-width="12" stroke-linejoin="miter" stroke-miterlimit="10"/>'),
  },
  {
    name: 'stroke-opacity',
    description: 'Independent fill-opacity and stroke-opacity.',
    markup: svg('<rect x="20" y="20" width="60" height="60" fill="#bc6c25" fill-opacity="0.35" stroke="#283618" stroke-width="10" stroke-opacity="0.7"/>'),
  },
  {
    name: 'stroke-gradient',
    description: 'Gradient-painted stroke — a url(#) reference in `stroke`, not `fill`.',
    markup: svg(
      '<defs><linearGradient id="sg"><stop offset="0" stop-color="#00f5d4"/><stop offset="1" stop-color="#f15bb5"/></linearGradient></defs>' +
      '<circle cx="50" cy="50" r="35" fill="none" stroke="url(#sg)" stroke-width="12"/>',
    ),
  },
  {
    name: 'marker-arrow',
    description: 'Markers on a path — marker-end references a def by url(#).',
    markup: svg(
      '<defs><marker id="mk" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto">' +
      '<path d="M0 0 L10 5 L0 10 Z" fill="#d90429"/></marker></defs>' +
      '<path d="M15 80 L80 25" fill="none" stroke="#d90429" stroke-width="4" marker-end="url(#mk)"/>',
    ),
  },

  // ── Structure / reuse ─────────────────────────────────────────────────────
  {
    name: 'use-symbol',
    description: '<use> referencing a <symbol> — href="#id" scoping.',
    markup: svg(
      '<defs><symbol id="sq" viewBox="0 0 10 10"><rect width="10" height="10" fill="#0077b6"/></symbol></defs>' +
      '<use href="#sq" x="10" y="10" width="35" height="35"/><use href="#sq" x="55" y="55" width="35" height="35"/>',
    ),
  },
  {
    name: 'use-transform',
    description: '<use> of a plain element with its own transform.',
    markup: svg(
      '<defs><g id="tri"><path d="M0 0 L30 0 L15 26 Z" fill="#7209b7"/></g></defs>' +
      '<use href="#tri" transform="translate(15 15)"/><use href="#tri" transform="translate(55 55) rotate(180 15 13)"/>',
    ),
  },
  {
    name: 'group-opacity',
    description: 'Group opacity — composites as a unit, not per child.',
    markup: svg(
      '<g opacity="0.5"><circle cx="40" cy="50" r="30" fill="#e63946"/><circle cx="60" cy="50" r="30" fill="#457b9d"/></g>',
    ),
  },
  {
    name: 'style-block-classes',
    description: 'A <style> block with class rules — must survive sanitization.',
    markup: svg(
      '<style>.a { fill: #ff9f1c } .b { fill: #2ec4b6; stroke: #011627; stroke-width: 4 }</style>' +
      '<rect class="a" x="10" y="10" width="80" height="35"/><rect class="b" x="10" y="55" width="80" height="35"/>',
    ),
  },
  {
    name: 'style-id-selector',
    description: 'CSS #id selector — must be rewritten in lockstep with the id.',
    markup: svg(
      '<style>#target { fill: #b5179e } #other { fill: #4361ee }</style>' +
      '<rect id="target" x="10" y="10" width="80" height="35"/><rect id="other" x="10" y="55" width="80" height="35"/>',
    ),
  },
  {
    name: 'nested-svg',
    description: 'A nested <svg> element with its own viewBox.',
    markup: svg(
      '<rect width="100" height="100" fill="#22223b"/>' +
      '<svg x="20" y="20" width="60" height="60" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="#f2e9e4"/></svg>',
    ),
  },

  // ── viewBox / sizing ──────────────────────────────────────────────────────
  {
    name: 'viewbox-only',
    description: 'viewBox with no width/height — must not letterbox into 300×150.',
    markup: svg('<circle cx="50" cy="50" r="45" fill="#ff7d00"/>', 'viewBox="0 0 100 100"'),
  },
  {
    name: 'size-no-viewbox',
    description: 'width/height with NO viewBox — our pipeline backfills one.',
    markup: svg('<rect x="10" y="10" width="80" height="80" fill="#15616d"/>', 'width="100" height="100"'),
  },
  {
    name: 'viewbox-offset-origin',
    description: 'viewBox with a non-zero origin.',
    markup: svg('<rect x="-40" y="-40" width="80" height="80" fill="#78290f"/>', 'viewBox="-50 -50 100 100"'),
  },
  {
    name: 'preserve-aspect-slice',
    description: 'preserveAspectRatio=slice on a non-square viewBox.',
    markup: svg(
      '<rect width="200" height="100" fill="#001524"/><circle cx="100" cy="50" r="45" fill="#ffecd1"/>',
      'viewBox="0 0 200 100" width="100" height="100" preserveAspectRatio="xMidYMid slice"',
    ),
  },

  // ── Text ──────────────────────────────────────────────────────────────────
  {
    name: 'text-basic',
    description: 'Filled <text> — renders with host fonts (capabilities.hasText warns).',
    markup: svg('<text x="50" y="58" font-family="sans-serif" font-size="28" text-anchor="middle" fill="#e0fbfc">Ag</text>'),
  },
  {
    name: 'text-stroked',
    description: 'Stroked and filled text.',
    markup: svg('<text x="50" y="60" font-family="sans-serif" font-size="34" font-weight="bold" text-anchor="middle" fill="#ffd166" stroke="#073b4c" stroke-width="1.5">Mg</text>'),
    // Bold stroked glyphs are nearly all edge pixels, and text renders with
    // HOST fonts: the committed reference (hardware GL, local fonts) vs CI
    // (SwiftShader, Ubuntu fonts) lands at ~0.98% on identical code.
    tolerance: 0.02,
  },
  {
    name: 'text-on-path',
    description: '<textPath> riding a path referenced by href="#id".',
    markup: svg(
      '<defs><path id="curve" d="M10 70 Q 50 20 90 70"/></defs>' +
      '<text font-family="sans-serif" font-size="14" fill="#06d6a0"><textPath href="#curve">curved</textPath></text>',
    ),
  },

  // ── Raster ────────────────────────────────────────────────────────────────
  {
    name: 'embedded-raster',
    description: 'An embedded <image> (data URI) — not vector, so unconvertible.',
    markup: svg(
      '<image x="10" y="10" width="80" height="80" preserveAspectRatio="none" href="data:image/png;base64,' +
      // A real 2×2 PNG — red / green over blue / yellow — stretched to 80×80, so
      // the rendered quadrants prove the raster actually decoded rather than
      // merely proving "something was drawn".
      'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAGklEQVR4AWP4z8Dwn+EEw38mxoD/DP9FGBgAPsUGK3uuWLcAAAAASUVORK5CYII="/>',
    ),
  },

  // ── Adversarial ───────────────────────────────────────────────────────────
  {
    name: 'duplicate-ids-two-copies',
    description: 'Two subtrees using the SAME gradient id — the classic collision case.',
    markup: svg(
      '<defs><linearGradient id="dup"><stop offset="0" stop-color="#f72585"/><stop offset="1" stop-color="#4cc9f0"/></linearGradient></defs>' +
      '<rect x="5" y="5" width="40" height="90" fill="url(#dup)"/>' +
      '<rect x="55" y="5" width="40" height="90" fill="url(#dup)"/>',
    ),
  },
  {
    name: 'many-paths',
    description: '120 paths — the layer-explosion case; must stay ONE layer.',
    markup: svg(
      Array.from({ length: 120 }, (_, i) => {
        const x = (i % 12) * 8 + 2;
        const y = Math.floor(i / 12) * 10 + 2;
        return `<path d="M${x} ${y} h6 v8 h-6 Z" fill="hsl(${i * 3} 70% 55%)"/>`;
      }).join(''),
    ),
  },
];
