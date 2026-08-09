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

const { featureSizes } = require('../../scripts/featureCounts.cjs') as {
  featureSizes: () => Record<string, number>;
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
});
