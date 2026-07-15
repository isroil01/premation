/** Linear RGBA color, components 0..1. GPU-ready (premultiply on demand). */
export interface Color {
  r: number;
  g: number;
  b: number;
  a: number;
}

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

  /** Parse `#rgb`, `#rrggbb`, or `#rrggbbaa` into a linear-ish sRGB color 0..1. */
  fromHex(hex: string): Color {
    let h = hex.trim().replace(/^#/, '');
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
