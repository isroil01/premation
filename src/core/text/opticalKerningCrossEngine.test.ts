/**
 * Cross-engine optical-kerning parity (plan E3), VERTICAL pairs: the C++
 * port (`native/engine/src/raster/optical_math.cpp`, VerticalKerner) of
 * `opticalKernVerticalPx`, `verticalProfileFromAlpha`, `measurePairGap`,
 * `pairAdjustment` and `isProportionalCjk`. Glyph rasters are synthetic —
 * axis-aligned rectangles with exact fractional coverage, drawn identically by
 * both sides — so the fixture pins the profile scan, the pair math, the face
 * target and the caches without depending on a font rasteriser (the glyph
 * drawing itself is the Canvas2D's, gated by the raster harness).
 *
 * `GEN_NATIVE_OPTICAL_KERNING=1 npx jest opticalKerningCrossEngine` rewrites
 * `native/engine/tests/data/optical_kerning_parity.json`; without it this test
 * fails when the fixture is stale.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  isProportionalCjk,
  measurePairGap,
  opticalKernVerticalPx,
  pairAdjustment,
  profileFromAlpha,
  resetOpticalKerningForTest,
  setOpticalVerticalRasterizer,
  verticalProfileFromAlpha,
  REF_EM_PX,
  type InkProfile,
} from './opticalKerning';

const OUT = path.resolve(__dirname, '../../../native/engine/tests/data/optical_kerning_parity.json');
const SIDE = REF_EM_PX * 2;

type Rect = [number, number, number, number];

/** RGBA of rectangles with exact area coverage (alpha only), SIDE × SIDE. */
export function renderRects(rects: ReadonlyArray<Rect>, w = SIDE, h = SIDE): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (const [x0, y0, x1, y1] of rects) {
        const ox = Math.max(0, Math.min(x1, x + 1) - Math.max(x0, x));
        const oy = Math.max(0, Math.min(y1, y + 1) - Math.max(y0, y));
        a += Math.round(255 * ox * oy);
      }
      out[(y * w + x) * 4 + 3] = Math.min(255, a);
    }
  }
  return out;
}

const shift = (rects: Rect[], dx: number, dy: number, k = 1): Rect[] =>
  rects.map(([a, b, c, d]) => [128 + (a - 128) * k + dx, 128 + (b - 128) * k + dy, 128 + (c - 128) * k + dx, 128 + (d - 128) * k + dy]);

const BASE: Record<string, Rect[]> = {
  国: [[70, 70, 186, 76], [70, 180, 186, 186], [70, 70, 76, 186], [180, 70, 186, 186], [100, 110, 156, 116.5]],
  口: [[80, 80, 176, 86.5], [80, 170, 176, 176], [80, 80, 86.5, 176], [169.5, 80, 176, 176]],
  あ: [[90, 95.3, 170, 160.7]],
  い: [[95, 100, 105, 170], [150, 110, 160, 150]],
  '。': [[166, 70.4, 186, 90]],
  '︒': [[160, 72, 180, 92.25]],
  '「': [[120, 70, 126, 140], [120, 70, 160, 76]],
  '」': [[134, 120, 140, 190], [100, 184.5, 140, 190]],
  日: [[90, 68, 166, 188.25]],
  ー: [[125.5, 80, 131, 176]],
  ッ: [[100, 120, 150, 170]],
  a: [[100, 120, 150, 160]],
};

const FACES: Record<string, Record<string, Rect[]>> = {
  '128px FaceA': BASE,
  '128px FaceB': Object.fromEntries(Object.entries(BASE).map(([k, v]) => [k, shift(v, 1.5, 3.3, 0.9)])),
};

const clean = (p: InkProfile | null) =>
  p && { advance: p.advance, left: p.left.map((v) => (Number.isNaN(v) ? null : v)), right: p.right.map((v) => (Number.isNaN(v) ? null : v)), top: Number.isNaN(p.top) ? null : p.top };

function rasterize(css: string, cluster: string): InkProfile | null {
  const rects = FACES[css]?.[cluster];
  if (!rects) return null;
  return verticalProfileFromAlpha(renderRects(rects), SIDE, SIDE, SIDE / 2 - REF_EM_PX / 2, SIDE / 2 - REF_EM_PX / 2, REF_EM_PX);
}

function generate() {
  const profiles: Record<string, unknown> = {};
  for (const [css, glyphs] of Object.entries(FACES)) for (const c of Object.keys(glyphs)) profiles[`${css}|${c}`] = clean(rasterize(css, c));

  // A horizontal profile of the same raster (profileFromAlpha moved with the math).
  const horizontal = clean(profileFromAlpha(renderRects(BASE['あ']!), SIDE, SIDE, 80, 170, REF_EM_PX, 90));

  const pa = rasterize('128px FaceA', 'あ')!;
  const pb = rasterize('128px FaceB', '「')!;
  const gaps = [[1, 1, 0.95], [1, 1.5, 0.95], [1, 0.6, 0.52]].map(([sa, sb, xh]) => {
    const g = measurePairGap(pa, sa!, pb, sb!, xh);
    return { sizeA: sa, sizeB: sb, xHeight: xh, gap: g, adj: g ? [pairAdjustment(g, 0.1, 1), pairAdjustment(g, 0.3, 0.8)] : null };
  });

  resetOpticalKerningForTest();
  setOpticalVerticalRasterizer(rasterize);
  const clusters = ['あ', 'い', '。', '︒', '「', '」', '日', 'ー', 'ッ', 'a', ' ', '国', '漢'];
  const sizes: Array<[number, number]> = [[40, 40], [40, 60], [60, 40.5]];
  const pairs: Array<[string, string, number, string, string, number, number]> = [];
  let n = 0;
  for (const a of clusters) {
    for (const b of clusters) {
      const [sa, sb] = sizes[n % sizes.length]!;
      const fa = n % 4 === 3 ? '128px FaceB' : '128px FaceA';
      const fb = n % 5 === 2 ? '128px FaceB' : '128px FaceA';
      n++;
      const face = (css: string) => ({ css });
      pairs.push([fa, a, sa, fb, b, sb, opticalKernVerticalPx(face(fa), a, sa, face(fb), b, sb)]);
    }
  }
  resetOpticalKerningForTest();
  const proportional = [0x3000, 0x3001, 0x303f, 0x3040, 0x3041, 0x30ff, 0x3100, 0x31f0, 0xfe10, 0xfe19, 0xfe1a, 0xfe30, 0xff01, 0xff10, 0xff1a, 0xff21, 0xff3b, 0xff5b, 0xff65, 0xff66, 0x65e5, 0x61]
    .map((cp) => [cp, isProportionalCjk(String.fromCodePoint(cp))]);
  return { rects: FACES, profiles, horizontal, gaps, pairs, proportional };
}

test('the C++ vertical optical-kerning fixture matches opticalKerning.ts', () => {
  const fixture = generate();
  // Something must actually kern, or the fixture pins nothing.
  expect(fixture.pairs.some((p) => p[6] < 0)).toBe(true);
  const text = `${JSON.stringify({ comment: 'Generated by src/core/text/opticalKerningCrossEngine.test.ts (GEN_NATIVE_OPTICAL_KERNING=1). Do not edit.', ...fixture })}\n`;
  if (process.env.GEN_NATIVE_OPTICAL_KERNING === '1') {
    writeFileSync(OUT, text);
    return;
  }
  expect(existsSync(OUT)).toBe(true);
  expect(JSON.parse(readFileSync(OUT, 'utf8'))).toEqual(JSON.parse(text));
});
