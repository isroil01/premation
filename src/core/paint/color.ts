/**
 * RGBA colour as four 0..1 components, and the hex / `rgb()` strings the
 * document stores colours as.
 *
 * This is the UI's and the document code's colour helper: the inspector turns a
 * stored hex into channel values for keyframes (`ColorKfRow`, layer styles,
 * effect edits), the stroke tracks turn sampled channels back into a hex, and
 * the light gizmo reads a light's colour. Moved here from `packages/renderer`
 * (docs/TS_ENGINE_REMOVAL.md, step 2) — the page renderer is deleted and none of
 * these callers draws anything.
 */

/** RGBA color, components 0..1. */
export interface Color {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * Parse memo for `fromHex`. Callers reach it repeatedly with the same handful
 * of document colours, and the regex + split + parseInt work showed up in
 * profiles. Values are frozen parses; `fromHex` hands out copies so no caller
 * can mutate a shared entry. Reset (not LRU'd) at a generous cap — a real
 * document never approaches it, but a procedurally animated colour string must
 * not grow it without bound.
 */
const HEX_PARSE_CACHE = new Map<string, Color>();
const HEX_PARSE_CACHE_MAX = 4096;

export const Color = {
  of(r: number, g: number, b: number, a = 1): Color {
    return { r, g, b, a };
  },
  black(a = 1): Color {
    return { r: 0, g: 0, b: 0, a };
  },
  white(a = 1): Color {
    return { r: 1, g: 1, b: 1, a };
  },
  transparent(): Color {
    return { r: 0, g: 0, b: 0, a: 0 };
  },

  /** Parse `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` or `rgba()` into 0..1 components. */
  fromHex(hex: string): Color {
    const hit = HEX_PARSE_CACHE.get(hex);
    if (hit) return { r: hit.r, g: hit.g, b: hit.b, a: hit.a };
    const parsed = Color.parseHexUncached(hex);
    if (HEX_PARSE_CACHE.size >= HEX_PARSE_CACHE_MAX) HEX_PARSE_CACHE.clear();
    HEX_PARSE_CACHE.set(hex, parsed);
    return { r: parsed.r, g: parsed.g, b: parsed.b, a: parsed.a };
  },

  /** The actual parser behind `fromHex` — exported for tests only. */
  parseHexUncached(hex: string): Color {
    const raw = hex.trim();
    // `rgb()` / `rgba()` as well as hex: an effect's opacity is folded into its
    // colour by rewriting a 6-digit hex as `rgba(r,g,b,a)`, and a hex-only
    // parser read every one of those as BLACK.
    const fn = /^rgba?\(([^)]+)\)$/i.exec(raw);
    if (fn) {
      const parts = fn[1]!.split(/[,\s/]+/).filter((s) => s.length > 0).map(Number);
      if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n))) {
        const a = parts.length > 3 && Number.isFinite(parts[3]!) ? parts[3]! : 1;
        return {
          r: Math.max(0, Math.min(1, parts[0]! / 255)),
          g: Math.max(0, Math.min(1, parts[1]! / 255)),
          b: Math.max(0, Math.min(1, parts[2]! / 255)),
          a: Math.max(0, Math.min(1, a)),
        };
      }
      return Color.black();
    }
    let h = raw.replace(/^#/, '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (h.length === 6) h += 'ff';
    if (h.length !== 8) return Color.black();
    const n = Number.parseInt(h, 16);
    return {
      r: ((n >>> 24) & 0xff) / 255,
      g: ((n >>> 16) & 0xff) / 255,
      b: ((n >>> 8) & 0xff) / 255,
      a: (n & 0xff) / 255,
    };
  },

  toHex(c: Color): string {
    const r = Math.round(Math.max(0, Math.min(1, c.r)) * 255);
    const g = Math.round(Math.max(0, Math.min(1, c.g)) * 255);
    const b = Math.round(Math.max(0, Math.min(1, c.b)) * 255);
    const a = Math.round(Math.max(0, Math.min(1, c.a)) * 255);
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}${a.toString(16).padStart(2, '0')}`;
  },

  toArray(c: Color): [number, number, number, number] {
    return [c.r, c.g, c.b, c.a];
  },

  premultiply(c: Color): Color {
    return { r: c.r * c.a, g: c.g * c.a, b: c.b * c.a, a: c.a };
  },

  equals(a: Color, b: Color, eps = 1e-4): boolean {
    return (
      Math.abs(a.r - b.r) <= eps &&
      Math.abs(a.g - b.g) <= eps &&
      Math.abs(a.b - b.b) <= eps &&
      Math.abs(a.a - b.a) <= eps
    );
  },
};
