/**
 * Chrome sizes stay on the scale.
 *
 * WHY THIS EXISTS. Before the scale landed, an audit of this app found:
 *
 *   • **twenty** distinct `<Icon size={N}>` values across 416 call sites,
 *     including 9, 10, 11, 12 and 13 all doing the same job — "a glyph on a
 *     row" — separated by a pixel each, and
 *   • 126 hardcoded `font-size: Npx` declarations, every one of which already
 *     matched a `--font-size-*` token exactly. They were not different sizes;
 *     they were the same sizes written in a way nothing could check.
 *
 * None of that was a decision made twenty times. It is the absence of one: for
 * icons there was no token to be consistent WITH, and for text the token
 * existed but nothing required using it.
 *
 * That is the whole argument for this file. A consistency pass done by eye
 * decays, because every individual `size={13}` is locally reasonable and
 * nothing objects. The tokens are the intent; this is what keeps them true.
 *
 * IF THIS FAILS you added a raw size to app chrome. Use `size="sm" | "md" |
 * "lg"` (see `ICON_SIZE`) or `var(--font-size-*)`. If what you are sizing is
 * genuinely NOT chrome — empty-state artwork, the logo, a text layer's own font
 * size — see the exemptions below and add to them deliberately.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ICON_SIZE } from './Icon';

const SRC = join(__dirname, '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '__fixtures__') continue;
      walk(full, out);
      continue;
    }
    out.push(full);
  }
  return out;
}

const files = walk(SRC);
const rel = (p: string): string => p.slice(SRC.length + 1).replace(/\\/g, '/');

/**
 * Icons ABOVE this are display artwork, not chrome — empty-state illustrations
 * and the like. They are sized to a layout, not to a control scale, and forcing
 * them onto one would be the same mistake in the other direction.
 */
const CHROME_ICON_MAX = 32;

/** The file that DEFINES the type scale is allowed to state it in pixels. */
const TOKEN_SOURCE = 'tokens/typography.css';

/**
 * Rules that state a size in SVG **user units**, which are not CSS pixels.
 *
 * Inside a `viewBox`, `font-size: 9px` means nine USER UNITS, scaled by
 * whatever transform the viewBox implies — so applying a CSS-px token would be
 * a category error, not a fix: `--font-size-xs` means "11 CSS px" and would
 * render at an arbitrary size depending on the element's scale factor.
 *
 * Each entry names the selector and why, so this stays a short list of reasoned
 * exceptions rather than a place to park anything the guard complains about.
 * If you are adding a row here, check the element really is inside a scaled
 * `viewBox` — for ordinary chrome the token is the right answer.
 */
const SVG_USER_UNIT_RULES: ReadonlyArray<{ file: string; px: number; why: string }> = [
  {
    file: 'layout/Motion/MotionEditorPanel.module.css',
    px: 9,
    why: '.axisLabel is <text> inside viewBox="0 0 320 200" — user units, not CSS px',
  },
];

describe('the icon scale is three sizes', () => {
  it('exposes exactly sm / md / lg', () => {
    // A scale that quietly grows a fourth entry is a scale on its way back to
    // twenty, so the count is asserted rather than assumed.
    expect(Object.keys(ICON_SIZE).sort()).toEqual(['lg', 'md', 'sm']);
    // Moved up from 13/16/22 with the switch to Material Symbols Sharp, whose
    // glyphs sit inside ~95 units of margin on a 960 grid and so read smaller
    // than the edge-to-edge stroke set before them. See ICON_SIZE in Icon.tsx.
    expect(ICON_SIZE).toEqual({ sm: 15, md: 18, lg: 25 });
  });

  it('no chrome icon is sized with a raw number', () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (!/\.tsx$/.test(file)) continue;
      const src = readFileSync(file, 'utf8');
      // Scan `<Icon …>` tags only. `<Logo size={72}>` is a different component
      // with its own sizing, and a bare `size={n}` elsewhere is somebody else's
      // prop entirely.
      for (const m of src.matchAll(/<Icon\b[\s\S]*?(?:\/>|>)/g)) {
        for (const s of m[0].matchAll(/size=\{(\d+)\}/g)) {
          const px = Number(s[1]);
          if (px <= CHROME_ICON_MAX) offenders.push(`${rel(file)}: size={${px}}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the CSS icon tokens mirror the TS scale', () => {
  /**
   * Stylesheets cannot read `ICON_SIZE`, but rows that reserve a slot for an
   * icon have to know how wide one is — so the scale exists twice. This is the
   * only thing standing between that and drift, and drift is not hypothetical:
   * the menu row carried a bare `width: 16px` from when `md` WAS 16, and when
   * the scale moved to 18 the rows with no icon quietly stopped lining up with
   * the rows that had one. Nothing failed, because nothing was checking.
   */
  it('--icon-size-sm/md/lg equal ICON_SIZE', () => {
    const css = readFileSync(join(SRC, 'tokens', 'spacing.css'), 'utf8');
    const tokens: Record<string, number> = {};
    for (const m of css.matchAll(/--icon-size-(sm|md|lg):\s*(\d+)px/g)) {
      tokens[m[1]!] = Number(m[2]);
    }
    expect(tokens).toEqual({ sm: ICON_SIZE.sm, md: ICON_SIZE.md, lg: ICON_SIZE.lg });
  });
});

describe('type sizes come from the token scale', () => {
  it('no stylesheet hardcodes a font-size in pixels', () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (!/\.css$/.test(file)) continue;
      if (rel(file) === TOKEN_SOURCE) continue;
      const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const m of src.matchAll(/font-size:\s*(\d+)px/g)) {
        const px = Number(m[1]);
        if (SVG_USER_UNIT_RULES.some((r) => r.file === rel(file) && r.px === px)) continue;
        offenders.push(`${rel(file)}: font-size: ${px}px`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no inline style hardcodes a fontSize', () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (!/\.tsx$/.test(file)) continue;
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        // Only inline STYLE objects. `fontSize` on a text layer is that layer's
        // own property — content the user set, not chrome — and it has to stay
        // a number that arithmetic can be done on.
        if (!line.includes('style={{')) continue;
        const m = /fontSize:\s*(\d+)(?![\d.])/.exec(line);
        if (m) offenders.push(`${rel(file)}: fontSize: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * Control heights in the SHARED COMPONENT LIBRARY come from the scale.
 *
 * Scoped to `src/components` deliberately, and the scope is the interesting
 * part. These stylesheets size controls by definition, so a raw `height: 24px`
 * there is always a control height written where nothing can check it.
 *
 * Out in the layouts it is not that simple: `height: 24px` might be a
 * thumbnail, a divider, a progress ring or a timeline bar, and rewriting those
 * as `--control-height-md` would make the sheet claim a meaning it does not
 * have. Value-identical, and a lie. So they are left alone, and this guard does
 * not pretend to cover them.
 *
 * Note what the audit that produced this actually found: 18px and 26px were NOT
 * strays. They are the `xs` variant of every control and the compact row used
 * by Tabs, TreeView and the transport. The scale was missing two tiers; the
 * call sites were right. The tokens were added rather than the sites snapped.
 */
describe('component-library control heights are tokenised', () => {
  const ALLOWED_RAW = new Set([1, 2, 3, 4, 6, 8, 10, 12, 14, 16]);

  it('no raw control-sized height in src/components', () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (!/\.css$/.test(file)) continue;
      if (!rel(file).startsWith('components/')) continue;
      const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const m of src.matchAll(/\b(?:min-)?height:\s*(\d+)px/g)) {
        const px = Number(m[1]);
        // Under 18 is decoration — hairlines, dots, bars. Over 28 is layout,
        // not a control. The band between is the scale's business.
        if (px >= 18 && px <= 28 && !ALLOWED_RAW.has(px)) {
          offenders.push(`${rel(file)}: height: ${px}px`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
