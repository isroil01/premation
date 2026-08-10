/**
 * The reference doc's feature counts must equal the registries.
 *
 * This repo's `.md` files have gone stale three separate times, and the failure
 * mode is always the same: a count is written by hand, the registry grows, and
 * the doc keeps asserting the old number with total confidence. The last round
 * had `docs/PREMATION_COMPLETE_REFERENCE.md` claiming 38 effects in one table
 * and 58 in another while `EffectType` held 73, and declaring `trim`/`repeater`
 * permanently outside the path-operator chain months after they joined it.
 *
 * So the counts in `docs/EDITOR_REFERENCE.md` are pinned here. Adding an effect
 * reddens this test, and the fix is to update the doc — which is the point. The
 * numbers come from `scripts/featureCounts.cjs`, the same module the doc's
 * report is generated from, so there is exactly one extractor and not two.
 *
 * This asserts counts, not prose. Prose still rots; a wrong NUMBER is the part
 * that made the doc actively misleading rather than merely dated.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { featureSizes, objectKeysIn } = require('../../scripts/featureCounts.cjs') as {
  featureSizes: () => Record<string, number>;
  objectKeysIn: (src: string, constName: string, where?: string) => string[];
};

const DOC = 'docs/EDITOR_REFERENCE.md';

/** Row label in the doc's count table → key returned by `featureSizes()`. */
const LABEL_TO_KEY: Readonly<Record<string, string>> = {
  Effects: 'effects',
  'Blend modes': 'blendModes',
  'Layer styles': 'layerStyles',
  'Path operators': 'pathOps',
  'Mask modes': 'maskModes',
  'Light types': 'lightTypes',
  'Canvas tools': 'tools',
  'AI tools': 'aiTools',
  'Export formats': 'exportFormats',
  Stores: 'stores',
  Packages: 'packages',
};

/**
 * Parse the doc's count table.
 *
 * Deliberately scoped to rows between the `<!-- FEATURE-COUNTS -->` markers so
 * a number appearing in prose elsewhere can never be mistaken for the pinned
 * table — and so moving the table without its markers fails loudly instead of
 * silently matching nothing.
 */
function docCounts(): Record<string, number> {
  const md = readFileSync(join(__dirname, '../..', DOC), 'utf8');
  const block = md.match(/<!-- FEATURE-COUNTS -->([\s\S]*?)<!-- \/FEATURE-COUNTS -->/)?.[1];
  if (!block) throw new Error(`${DOC}: FEATURE-COUNTS markers missing`);

  const out: Record<string, number> = {};
  for (const row of block.matchAll(/^\|\s*\*{0,2}([A-Za-z ]+?)\*{0,2}\s*\|\s*(\d+)\s*\|/gm)) {
    const label = row[1];
    const count = row[2];
    if (!label || !count) continue;
    const key = LABEL_TO_KEY[label.trim()];
    if (key) out[key] = Number(count);
  }
  return out;
}

describe('docs/EDITOR_REFERENCE.md feature counts', () => {
  const actual = featureSizes();
  const documented = docCounts();

  it('documents every registry the script derives', () => {
    expect(Object.keys(documented).sort()).toEqual(Object.keys(actual).sort());
  });

  // One case per registry so a failure names the drifted number directly
  // instead of dumping an eleven-key object diff.
  for (const [label, key] of Object.entries(LABEL_TO_KEY)) {
    it(`${label}: doc matches the registry`, () => {
      expect(documented[key]).toBe(actual[key]);
    });
  }

  /**
   * Layer styles come from TWO registries, and the second one is the interesting
   * one: Glass does not compile to an effect, so it cannot live in
   * `LAYER_STYLE_LABEL`, and the script used to append it as a literal `'glass'`
   * — a hand-written number inside the script that exists to eliminate
   * hand-written numbers. A second backdrop-resolved style would have left the
   * documented count wrong with every test still green.
   *
   * Asserting the sum is not enough on its own; that would hold for a hardcoded
   * `+ 1` too. So this also splices a registry and checks the derived count
   * MOVES.
   */
  describe('layer styles are summed from two registries, not one plus a literal', () => {
    const src = readFileSync(join(__dirname, '../core/effects/layerStyles.ts'), 'utf8');

    it('the total is exactly both registries', () => {
      const compiled = objectKeysIn(src, 'LAYER_STYLE_LABEL');
      const backdrop = objectKeysIn(src, 'BACKDROP_STYLES');
      expect(backdrop.length).toBeGreaterThan(0);
      expect(actual.layerStyles).toBe(compiled.length + backdrop.length);
    });

    it('a new BACKDROP_STYLES entry moves the count', () => {
      const before = objectKeysIn(src, 'BACKDROP_STYLES');
      // Splice a sibling for Glass into the real source text. If the script ever
      // reverts to a literal, the count stops tracking this and the test fails.
      // `\r?\n` because this repo checks out CRLF on Windows; an LF-only splice
      // matches nothing and the test passes by never having tested anything.
      const spliced = src.replace(
        /(export const BACKDROP_STYLES\b[^=]*=\s*\{\r?\n)/,
        (m) => `${m}  frost: 'Frost',\n`,
      );
      expect(spliced).not.toBe(src); // the splice actually applied
      const after = objectKeysIn(spliced, 'BACKDROP_STYLES');
      expect(after.length).toBe(before.length + 1);
      expect(after).toContain('frost');
    });

    it('the script reads the registry rather than naming Glass', () => {
      // The arithmetic checks above cannot catch a revert on their own: while
      // BACKDROP_STYLES holds exactly one entry, `LABEL.length + 1` and
      // `LABEL.length + BACKDROP.length` are the same number, so a hardcoded
      // literal would satisfy them both. This is the assertion that actually
      // pins the mechanism.
      const script = readFileSync(join(__dirname, '../../scripts/featureCounts.cjs'), 'utf8');
      const code = script.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      expect(code).toContain('BACKDROP_STYLES');
      expect(code).not.toMatch(/['"]glass['"]/i);
    });
  });
});
