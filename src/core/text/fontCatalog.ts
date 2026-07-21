/**
 * Font catalog — per-family WEIGHTS discovered from the real installed fonts
 * (queryLocalFonts styles), so the Weight dropdown offers what a family
 * actually ships instead of a hardcoded 300–700 guess. Cached module-wide;
 * families we know nothing about fall back to the standard five.
 */

interface LocalFontData {
  family?: string;
  style?: string;
}

/** Style-name → numeric weight. ORDER MATTERS: compound names (Extra Bold,
 *  Semi Bold) must match before their plain substrings (Bold). */
const STYLE_WEIGHTS: ReadonlyArray<readonly [RegExp, number]> = [
  [/thin|hairline/i, 100],
  [/extra\s*-?light|ultra\s*-?light/i, 200],
  [/semi\s*-?bold|demi\s*-?bold|demibold/i, 600],
  [/extra\s*-?bold|ultra\s*-?bold/i, 800],
  [/light/i, 300],
  [/medium/i, 500],
  [/black|heavy/i, 900],
  [/bold/i, 700],
  [/regular|normal|book|roman|text|italic|oblique/i, 400],
];

export function weightFromStyle(style: string): number {
  for (const [re, w] of STYLE_WEIGHTS) {
    if (re.test(style)) return w;
  }
  return 400;
}

export const FALLBACK_WEIGHTS: readonly number[] = [300, 400, 500, 600, 700];

export const WEIGHT_LABELS: Record<number, string> = {
  100: 'Thin (100)',
  200: 'Extra Light (200)',
  300: 'Light (300)',
  400: 'Regular (400)',
  500: 'Medium (500)',
  600: 'Semi-Bold (600)',
  700: 'Bold (700)',
  800: 'Extra Bold (800)',
  900: 'Black (900)',
};

let catalog: Map<string, Set<number>> | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** Kick off (once) the local-font scan; notifies subscribers when ready. */
export function loadFontCatalog(): Promise<void> {
  if (catalog) return Promise.resolve();
  if (loading) return loading;
  loading = (async () => {
    const map = new Map<string, Set<number>>();
    try {
      const query = (window as unknown as {
        queryLocalFonts?: () => Promise<ReadonlyArray<LocalFontData>>;
      }).queryLocalFonts;
      if (typeof query === 'function') {
        for (const f of (await query.call(window)) ?? []) {
          const family = String(f?.family ?? '').trim();
          if (!family) continue;
          let set = map.get(family);
          if (!set) {
            set = new Set<number>();
            map.set(family, set);
          }
          set.add(weightFromStyle(String(f?.style ?? 'Regular')));
        }
      }
    } catch {
      /* permission denied / unsupported — fallbacks cover it */
    }
    catalog = map;
    for (const l of listeners) l();
  })();
  return loading;
}

/** Subscribe to catalog readiness (for React re-render). */
export function onFontCatalogReady(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The weights a family actually provides, sorted ascending. Regular (400) is
 * always offered so a family that only ships display cuts stays usable, and
 * unknown families get the standard five.
 */
export function getFontWeights(family: string): number[] {
  const found = catalog?.get(family);
  if (!found || found.size === 0) return [...FALLBACK_WEIGHTS];
  return [...new Set([...found, 400])].sort((a, b) => a - b);
}
