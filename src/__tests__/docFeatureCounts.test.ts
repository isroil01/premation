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
 * This asserts the TABLE. Prose is `docPropagatedCounts.test.ts`, added
 * 2026-08-12 — and it exists because the sentence that used to stand here
 * ("This asserts counts, not prose. Prose still rots") was describing a hole
 * and calling it a boundary. While it stood, `EffectType` grew to 145 and §4,
 * `README.md` and `ROADMAP.md` all went on asserting **73**, while the §2
 * architecture diagram said 39 stores against 40. This table was green
 * throughout, and every brief written against the document inherited the 73.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { featureSizes, objectKeysIn, unionMembersIn } = require('../../scripts/featureCounts.cjs') as {
  featureSizes: () => Record<string, number>;
  objectKeysIn: (src: string, constName: string, where?: string) => string[];
  unionMembersIn: (src: string, typeName: string, where?: string) => string[];
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
  /**
   * An apostrophe in a comment used to invent a member and eat a real one.
   *
   * The union body was regex-matched for `'…'` runs WITHOUT stripping comments,
   * so writing `// AE's Apply Color LUT` above a member opened a quote that
   * closed on the next real member. Adding one effect moved the count by two,
   * which is the only reason it was noticed — a comment worded slightly
   * differently would have moved it by zero and quietly under-reported forever.
   *
   * This is the worst version of the bug this whole script exists to prevent:
   * the count that is supposed to be beyond hand-miscounting, miscounted.
   */
  describe('the union extractor is not fooled by prose', () => {
    const UNION = [
      "export type Demo =",
      "  | 'alpha'",
      "  // AE's own name for it, with an apostrophe.",
      "  | 'beta'",
      "  /* a block comment that isn't shy about apostrophes either */",
      "  | 'gamma';",
    ].join('\n');

    it('counts only real members', () => {
      expect(unionMembersIn(UNION, 'Demo')).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('a comment cannot change the count', () => {
      const withoutProse = UNION.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('/*')).join('\n');
      expect(unionMembersIn(withoutProse, 'Demo')).toEqual(unionMembersIn(UNION, 'Demo'));
    });

    it('a new member DOES change the count', () => {
      const spliced = UNION.replace("  | 'gamma';", "  | 'delta'\n  | 'gamma';");
      expect(spliced).not.toBe(UNION);
      expect(unionMembersIn(spliced, 'Demo')).toHaveLength(4);
    });

    it('the real EffectType union has no apostrophe casualties', () => {
      const src = readFileSync(join(__dirname, '../core/effects/effects.ts'), 'utf8');
      const members = unionMembersIn(src, 'EffectType');
      // Every member is a kebab-case effect id. A swallowed comment shows up
      // here as an entry with spaces or capitals in it.
      for (const m of members) expect(m).toMatch(/^[a-z0-9-]+$/);
      expect(members).toContain('apply-color-lut');
    });
  });

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
