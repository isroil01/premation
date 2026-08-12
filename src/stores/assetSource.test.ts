/**
 * The library shelf is "media I brought in", not everything with bytes.
 *
 * ── The report this closes ──────────────────────────────────────────────────
 *
 * Operations that duplicate or rasterize scene content — a plugin repeater,
 * Rig Logo — have to create real assets: the layers using them reference them
 * by id, and those bytes must persist. But they were filed as ordinary
 * imports, so the Assets panel filled with copies the user never imported,
 * sitting among the footage they did, with nothing to tell the two apart.
 *
 * ── Why `isLibraryAsset` is a function and not a `=== 'user'` at the panel ──
 *
 * Two things have to agree: what the shelf lists, and what the count on the
 * reveal toggle says is hidden. Written as a comparison at each site they
 * drift, and the drift is invisible — a toggle offering to show 3 things that
 * reveals 4. One predicate, used by both, cannot disagree with itself.
 *
 * The absent case is the one that matters most: every asset stored before this
 * field existed has no `source` at all, and every one of them is a user
 * import. Defaulting the other way would empty the shelf on upgrade.
 */

import { isLibraryAsset, type AssetSource } from './assetStore';

const asset = (source?: AssetSource) => ({ source });

describe('what the shelf lists', () => {
  it('lists an asset with no source — every pre-existing import is one', () => {
    // The upgrade case. If this flipped, a user's whole library would vanish
    // from the panel on the first run of the new build.
    expect(isLibraryAsset(asset(undefined))).toBe(true);
  });

  it('lists user imports and AI artifacts', () => {
    // `'ai'` is generated, but the user ASKED for it as a thing in its own
    // right — it is a result they went looking for, not a by-product of an
    // edit. It belongs on the shelf.
    expect(isLibraryAsset(asset('user'))).toBe(true);
    expect(isLibraryAsset(asset('ai'))).toBe(true);
  });

  it('does NOT list derived output', () => {
    // The whole point.
    expect(isLibraryAsset(asset('derived'))).toBe(false);
  });
});

describe('the predicate partitions the set', () => {
  it('splits a mixed library into shelf and hidden with nothing lost', () => {
    // Guards the shelf list and the toggle's count against disagreeing: the
    // count is computed as `total - shelf`, so any asset the predicate treats
    // inconsistently would be counted in both halves or neither.
    const all = [asset('user'), asset('derived'), asset(undefined), asset('ai'), asset('derived')];
    const shelf = all.filter(isLibraryAsset);
    const hidden = all.filter((a) => !isLibraryAsset(a));
    expect(shelf).toHaveLength(3);
    expect(hidden).toHaveLength(2);
    expect(shelf.length + hidden.length).toBe(all.length);
  });
});
