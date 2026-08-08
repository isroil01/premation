/**
 * G2 — every KEYFRAMEABLE property must be sampled somewhere that draws.
 *
 * ## Why this is a second guard and not an extension of the first
 *
 * `contentHashReaders.test.ts` (G1) enforces a different contract: every field
 * folded into the rasterizer's CONTENT HASH must have a reader. That caught
 * per-layer `quality`.
 *
 * It could never have caught F34, and extending it would not have helped. The
 * hash folds `st: layer.stroke` — one object — and the guard checks top-level
 * hashed field names, so `stroke.width` was never in its subject set at all.
 * More importantly the two failures are different classes:
 *
 *   G1  hashed-but-unread        → the texture re-rasterizes and looks identical
 *   G2  keyframeable-but-unsampled → the STOPWATCH writes keyframes nothing reads
 *
 * F34 was the second: `strokeWidth` was registered in `propertyMeta`, offered a
 * stopwatch by the inspector and the timeline, and folded into the resolved
 * stroke by nothing. A 6→40 ramp rendered 5296 stroke pixels at both ends.
 *
 * ## The subject set is the registry's own inventory
 *
 * `staticPropertyPaths()` exists explicitly "for tests" — so a property added to
 * `propertyMeta` is enrolled here the moment it exists, and cannot be forgotten.
 * Hardcoding the list is the shape that has already bitten this project
 * repeatedly.
 *
 * ## HOW A PATH PASSES
 *
 * Its name must appear QUOTED in a file that turns a layer into pixels. That is
 * how animated values are read here: `a.has('strokeWidth')` / `a.get(…)` off the
 * sampled-value map, or `anim.sample(id, 'prop', t)`. A path that appears only
 * as an object key (`strokeWidth:`) is a WRITE and does not count — which is the
 * discriminator that makes this useful, and the same one G1 uses.
 *
 * ## IF THIS FAILS
 *
 * You have made a property keyframeable that nothing renders from. Two honest
 * fixes: sample it, or take the stopwatch away. There is no exception list,
 * deliberately — `EXPLAINED` below is not one: every entry there names the
 * concrete symbol that DOES the sampling, and is asserted to still exist.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { staticPropertyPaths, resolvePropertyMeta } from '@core/inspector/propertyMeta';

const REPO_ROOT = resolve(__dirname, '../../../..');

/** Where a layer becomes pixels. Kept narrow for the reason G1 states. */
const PIXEL_PATH = [
  'src/core/rendering',
  'packages/renderer/src',
];

function readAll(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (!/__tests__|node_modules/.test(p)) readAll(p, acc);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      acc.push(readFileSync(p, 'utf8'));
    }
  }
  return acc;
}

const PIXEL_SOURCE = PIXEL_PATH.flatMap((d) => readAll(join(REPO_ROOT, d))).join('\n');

/**
 * Paths whose sampling happens under a DIFFERENT symbol, each with the symbol
 * that does it. Not an exception list: the second element is asserted to be
 * present, so an entry that stops being true fails here.
 */
const EXPLAINED: Record<string, string> = {
  // Decomposed into per-axis tracks; the group path itself is never sampled.
  scale: "'scaleX'",
};

/**
 * Registered, keyframeable, and NOT sampled — found by this guard, logged
 * rather than fixed because each is its own behaviour change needing its own
 * re-bless (§2a).
 *
 * This is not an exception list that can rot. Two tests below hold it honest:
 * nothing may JOIN it silently, and every entry must still BE unsampled — so
 * fixing one fails here until it is removed, and the list cannot outlive the
 * bugs it describes.
 */
const KNOWN_UNSAMPLED: Record<string, string> = {
  // EMPTY, and that is the healthy state — not a sign the list is unused.
  //
  // It held exactly one entry for exactly one commit: F35 (`cornerRadius`),
  // which this guard found the day F34 was fixed. Fixing F35 made
  // `and every LOGGED finding is still real` go red, which is the whole design
  // — the list cannot outlive the bugs it names, so it emptied itself rather
  // than quietly becoming an exemption for a property that now works.
};

/**
 * Structural rows, excluded on a PROPERTY of the entry rather than by name: a
 * `type: 'group'` row is a synthesized timeline header (AE's Position group),
 * not something a renderer could sample. `POSITION_PSEUDO_PROP` is the only one
 * today, and naming it would have made this a hardcoded exemption.
 */
const isGroupRow = (path: string): boolean => {
  try { return resolvePropertyMeta(path).type === 'group'; } catch { return false; }
};

const PATHS = staticPropertyPaths().filter((p) => !isGroupRow(p));

/** Quoted read, not an object-literal write. */
const isSampled = (path: string): boolean =>
  PIXEL_SOURCE.includes(`'${path}'`) || PIXEL_SOURCE.includes(`"${path}"`);

describe('the instrument itself', () => {
  it('POSITIVE CONTROL: the registry yielded a real inventory', () => {
    // `[].filter(...)` reports as passing.
    expect(PATHS.length).toBeGreaterThan(15);
  });

  it('POSITIVE CONTROL: the pixel path was actually read', () => {
    expect(PIXEL_SOURCE.length).toBeGreaterThan(100_000);
  });

  it('POSITIVE CONTROL: the detector distinguishes sampled from unsampled', () => {
    // A property known to be sampled, and a name that cannot be. Without this
    // the sweep could be reporting "all clear" because `isSampled` is always
    // true, or flagging everything because it is always false.
    expect({ real: isSampled('opacity'), fake: isSampled('nope_not_a_property') })
      .toEqual({ real: true, fake: false });
  });

  it('every EXPLAINED entry still names a symbol the pixel path contains', () => {
    const stale = Object.entries(EXPLAINED)
      .filter(([, symbol]) => !PIXEL_SOURCE.includes(symbol))
      .map(([path, symbol]) => `${path} → ${symbol}`);
    expect(stale).toEqual([]);
  });

  it('and every EXPLAINED entry is still IN the registry', () => {
    // An entry for a property that no longer exists is dead weight that would
    // quietly excuse a future property of the same name.
    const ghosts = Object.keys(EXPLAINED).filter((p) => !PATHS.includes(p));
    expect(ghosts).toEqual([]);
  });
});

describe('every keyframeable property is sampled where it draws', () => {
  it('POSITIVE CONTROL: the group-row filter removed something, and not everything', () => {
    // Otherwise the exclusion is either dead or is quietly swallowing the whole
    // inventory, and the sweep below would be vacuous.
    const all = staticPropertyPaths();
    expect({ removedSome: PATHS.length < all.length, keptMost: PATHS.length > all.length - 5 })
      .toEqual({ removedSome: true, keptMost: true });
  });

  it('nothing NEW is registered with a stopwatch the renderer never reads', () => {
    const unsampled = PATHS.filter(
      (p) => !isSampled(p) && !(p in EXPLAINED) && !(p in KNOWN_UNSAMPLED));
    expect(unsampled).toEqual([]);
  });

  it('and every LOGGED finding is still real — fixing one fails here', () => {
    // The half that stops this becoming an exception list. An entry that has
    // been fixed must be deleted, or it silently excuses the next regression
    // of the same property.
    const fixed = Object.keys(KNOWN_UNSAMPLED).filter((p) => isSampled(p));
    expect(fixed).toEqual([]);
  });

  it('strokeWidth is NOT in the logged set — F34 is fixed, not excused', () => {
    // The specific regression this change exists to prevent: F34 must be sampled
    // for real, not moved into the list above.
    expect({ logged: 'strokeWidth' in KNOWN_UNSAMPLED, sampled: isSampled('strokeWidth') })
      .toEqual({ logged: false, sampled: true });
  });
});
