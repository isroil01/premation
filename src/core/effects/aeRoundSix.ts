/**
 * Visual effects, round six — eight iconic After Effects & Cycore (CC) effects:
 *   • Unmult (Knoll / AE 2026 native unmult — alpha from luminance)
 *   • CC Composite (Composite original unmodified source over effect stack)
 *   • CC RepeTile (Tiling expansion with unfold/mirror, repeat, flip, slide)
 *   • CC Scatterize (Explodes/scatters pixels into particles)
 *   • CC Radial Fast Blur (Directional zoom-blur / god-rays)
 *   • CC Cross Blur (Independent separable horizontal & vertical blurs)
 *   • CC Scale Wipe (Directional scale stretch wipe transition)
 *   • CC Plastic (3D specular plastic relief from luminance height map)
 *
 * All pure Uint8ClampedArray transforms.
 */

import { clamp01, clamp255, luma } from './colorSpace';
import { remap } from './distort';

const DEG = Math.PI / 180;

/** Deterministic 0..1 hash of two integers. */
function hash2(a: number, b: number): number {
  let n = (a * 374761393 + b * 668265263) | 0;
  n = (n ^ (n >>> 13)) * 1274126177;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

/** Luma plane of an RGBA buffer, optionally box-blurred. */
function lumaField(src: Uint8ClampedArray, w: number, h: number, blurRadius: number): Float32Array {
  let f = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    f[i] = luma(src[i * 4]!, src[i * 4 + 1]!, src[i * 4 + 2]!) * (src[i * 4 + 3]! / 255);
  }
  const r = Math.max(0, Math.round(blurRadius));
  if (r === 0) return f;
  for (let pass = 0; pass < 2; pass++) {
    const g = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        let cnt = 0;
        for (let k = -r; k <= r; k++) {
          const xx = pass === 0 ? x + k : x;
          const yy = pass === 0 ? y : y + k;
          if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
          sum += f[yy * w + xx]!;
          cnt++;
        }
        g[y * w + x] = cnt > 0 ? sum / cnt : 0;
      }
    }
    f = g;
  }
  return f;
}

// ── 1. Unmult ───────────────────────────────────────────────────────

/**
 * Unmult — Knocks out black backgrounds by calculating alpha directly from max RGB
 * channel luminance and unmultiplying the color channels.
 */
export function unmultData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  threshold = 0,
  boost = 100,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length);
  const threshNorm = Math.max(0, Math.min(0.99, threshold / 100));
  const boostGain = Math.max(0.1, boost / 100);

  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    const r = src[o]!;
    const g = src[o + 1]!;
    const b = src[o + 2]!;
    const a = src[o + 3]!;

    if (a === 0) continue;

    const maxChan = Math.max(r, g, b) / 255;
    if (maxChan <= threshNorm) {
      out[o] = 0;
      out[o + 1] = 0;
      out[o + 2] = 0;
      out[o + 3] = 0;
      continue;
    }

    const normL = (maxChan - threshNorm) / (1 - threshNorm);
    const newAlphaNorm = Math.min(1, normL * boostGain * (a / 255));
    const newAlpha = Math.round(newAlphaNorm * 255);

    if (newAlpha <= 0) {
      out[o] = 0;
      out[o + 1] = 0;
      out[o + 2] = 0;
      out[o + 3] = 0;
      continue;
    }

    // Unmultiply RGB values
    const unmultR = clamp255(r / newAlphaNorm);
    const unmultG = clamp255(g / newAlphaNorm);
    const unmultB = clamp255(b / newAlphaNorm);

    out[o] = unmultR;
    out[o + 1] = unmultG;
    out[o + 2] = unmultB;
    out[o + 3] = newAlpha;
  }
  return out;
}

// ── 2. CC Composite ─────────────────────────────────────────────────

export type CompositeBlendMode =
  | 'in-front'
  | 'behind'
  | 'add'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'hard-light'
  | 'soft-light'
  | 'difference'
  | 'stencil-alpha'
  | 'silhouette-alpha';

export function compositeBlendMode(modeNum: number): CompositeBlendMode {
  const modes: CompositeBlendMode[] = [
    'in-front',
    'behind',
    'add',
    'multiply',
    'screen',
    'overlay',
    'hard-light',
    'soft-light',
    'difference',
    'stencil-alpha',
    'silhouette-alpha',
  ];
  return modes[Math.max(0, Math.min(modes.length - 1, Math.round(modeNum)))] ?? 'in-front';
}

/**
 * CC Composite — Blends the original source layer over (or behind) the current effect output.
 */
export function ccCompositeData(
  current: Uint8ClampedArray,
  original: Uint8ClampedArray,
  w: number,
  h: number,
  opacity = 100,
  blendMode: CompositeBlendMode = 'in-front',
  rgbOnly = false,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(current.length);
  const mix = clamp01(opacity / 100);

  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    const cr = current[o]!;
    const cg = current[o + 1]!;
    const cb = current[o + 2]!;
    const ca = current[o + 3]!;

    const or = original[o]!;
    const og = original[o + 1]!;
    const ob = original[o + 2]!;
    const oa = original[o + 3]!;

    let br = cr;
    let bg = cg;
    let bb = cb;
    let ba = ca;

    const topA = oa / 255;
    const botA = ca / 255;

    switch (blendMode) {
      case 'in-front':
        br = or * topA + cr * (1 - topA);
        bg = og * topA + cg * (1 - topA);
        bb = ob * topA + cb * (1 - topA);
        ba = Math.max(oa, ca);
        break;
      case 'behind':
        br = cr * botA + or * (1 - botA);
        bg = cg * botA + og * (1 - botA);
        bb = cb * botA + ob * (1 - botA);
        ba = Math.max(oa, ca);
        break;
      case 'add':
        br = Math.min(255, cr + or);
        bg = Math.min(255, cg + og);
        bb = Math.min(255, cb + ob);
        ba = Math.max(ca, oa);
        break;
      case 'multiply':
        br = (cr * or) / 255;
        bg = (cg * og) / 255;
        bb = (cb * ob) / 255;
        ba = Math.max(ca, oa);
        break;
      case 'screen':
        br = 255 - ((255 - cr) * (255 - or)) / 255;
        bg = 255 - ((255 - cg) * (255 - og)) / 255;
        bb = 255 - ((255 - cb) * (255 - ob)) / 255;
        ba = Math.max(ca, oa);
        break;
      case 'overlay':
        br = cr < 128 ? (2 * cr * or) / 255 : 255 - (2 * (255 - cr) * (255 - or)) / 255;
        bg = cg < 128 ? (2 * cg * og) / 255 : 255 - (2 * (255 - cg) * (255 - og)) / 255;
        bb = cb < 128 ? (2 * cb * ob) / 255 : 255 - (2 * (255 - cb) * (255 - ob)) / 255;
        ba = Math.max(ca, oa);
        break;
      case 'difference':
        br = Math.abs(cr - or);
        bg = Math.abs(cg - og);
        bb = Math.abs(cb - ob);
        ba = Math.max(ca, oa);
        break;
      case 'stencil-alpha':
        br = cr;
        bg = cg;
        bb = cb;
        ba = (ca * oa) / 255;
        break;
      case 'silhouette-alpha':
        br = cr;
        bg = cg;
        bb = cb;
        ba = (ca * (255 - oa)) / 255;
        break;
      default:
        br = or;
        bg = og;
        bb = ob;
        ba = oa;
        break;
    }

    out[o] = clamp255(cr + (br - cr) * mix);
    out[o + 1] = clamp255(cg + (bg - cg) * mix);
    out[o + 2] = clamp255(cb + (bb - cb) * mix);
    out[o + 3] = rgbOnly ? ca : clamp255(ca + (ba - ca) * mix);
  }
  return out;
}

// ── 3. CC RepeTile ──────────────────────────────────────────────────

export type RepeTileMode = 'repeat' | 'unfold' | 'flip-h' | 'flip-v';

export function repeTileModeOf(modeNum: number): RepeTileMode {
  const modes: RepeTileMode[] = ['unfold', 'repeat', 'flip-h', 'flip-v'];
  return modes[Math.max(0, Math.min(modes.length - 1, Math.round(modeNum)))] ?? 'unfold';
}

/**
 * CC RepeTile — Expands and tiles the borders of a layer.
 */
export function ccRepeTileData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  expandLeft = 0,
  expandRight = 0,
  expandUp = 0,
  expandDown = 0,
  mode: RepeTileMode = 'unfold',
): { data: Uint8ClampedArray; width: number; height: number } {
  const el = Math.max(0, Math.round(expandLeft));
  const er = Math.max(0, Math.round(expandRight));
  const eu = Math.max(0, Math.round(expandUp));
  const ed = Math.max(0, Math.round(expandDown));

  if (el === 0 && er === 0 && eu === 0 && ed === 0) {
    return { data: new Uint8ClampedArray(src), width: w, height: h };
  }

  const newW = w + el + er;
  const newH = h + eu + ed;
  const out = new Uint8ClampedArray(newW * newH * 4);

  const mapCoord = (p: number, size: number, modeStr: RepeTileMode, isHorizontal: boolean): number => {
    if (p >= 0 && p < size) return p;
    if (modeStr === 'unfold') {
      const cycle = 2 * (size - 1);
      if (cycle <= 0) return 0;
      let m = ((p % cycle) + cycle) % cycle;
      return m >= size ? cycle - m : m;
    }
    if (modeStr === 'repeat') {
      return ((p % size) + size) % size;
    }
    if (modeStr === 'flip-h' && isHorizontal) {
      const tile = Math.floor(p / size);
      let m = ((p % size) + size) % size;
      return Math.abs(tile) % 2 === 1 ? size - 1 - m : m;
    }
    if (modeStr === 'flip-v' && !isHorizontal) {
      const tile = Math.floor(p / size);
      let m = ((p % size) + size) % size;
      return Math.abs(tile) % 2 === 1 ? size - 1 - m : m;
    }
    return ((p % size) + size) % size;
  };

  for (let ny = 0; ny < newH; ny++) {
    const origY = ny - eu;
    const sy = mapCoord(origY, h, mode, false);
    for (let nx = 0; nx < newW; nx++) {
      const origX = nx - el;
      const sx = mapCoord(origX, w, mode, true);

      const srcIdx = (sy * w + sx) * 4;
      const dstIdx = (ny * newW + nx) * 4;

      out[dstIdx] = src[srcIdx]!;
      out[dstIdx + 1] = src[srcIdx + 1]!;
      out[dstIdx + 2] = src[srcIdx + 2]!;
      out[dstIdx + 3] = src[srcIdx + 3]!;
    }
  }

  return { data: out, width: newW, height: newH };
}

// ── 4. CC Scatterize ────────────────────────────────────────────────

/**
 * CC Scatterize — Explodes and scatters the layer's pixels with controllable wind and twist.
 */
export function ccScatterizeData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  amount = 0,
  windX = 0,
  windY = 0,
  twist = 0,
  seed = 1,
): Uint8ClampedArray {
  if (amount <= 0.001) return new Uint8ClampedArray(src);

  const out = new Uint8ClampedArray(src.length);
  const amt = amount * 0.5;
  const twistRad = twist * DEG;
  const cx = w / 2;
  const cy = h / 2;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      const a = src[idx + 3]!;
      if (a === 0) continue;

      const h1 = hash2(x + seed * 997, y + seed * 997);
      const h2 = hash2(y + seed * 613, x + seed * 613);

      const dist = h1 * amt;
      const ang = h2 * Math.PI * 2 + twistRad * (Math.hypot(x - cx, y - cy) / Math.max(1, cx));

      const dx = Math.cos(ang) * dist + (windX * amt) / 100;
      const dy = Math.sin(ang) * dist + (windY * amt) / 100;

      const destX = Math.round(x + dx);
      const destY = Math.round(y + dy);

      if (destX >= 0 && destX < w && destY >= 0 && destY < h) {
        const dstIdx = (destY * w + destX) * 4;
        out[dstIdx] = src[idx]!;
        out[dstIdx + 1] = src[idx + 1]!;
        out[dstIdx + 2] = src[idx + 2]!;
        out[dstIdx + 3] = src[idx + 3]!;
      }
    }
  }
  return out;
}

// ── 5. CC Radial Fast Blur ──────────────────────────────────────────

export type RadialFastBlurMode = 'standard' | 'bright' | 'dark';

export function radialFastBlurModeOf(modeNum: number): RadialFastBlurMode {
  const modes: RadialFastBlurMode[] = ['standard', 'bright', 'dark'];
  return modes[Math.max(0, Math.min(modes.length - 1, Math.round(modeNum)))] ?? 'standard';
}

/**
 * CC Radial Fast Blur — Directional zoom blur / god-rays from a center point.
 */
export function radialFastBlurData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  amount = 20,
  centerX = 0,
  centerY = 0,
  mode: RadialFastBlurMode = 'standard',
): Uint8ClampedArray {
  if (amount <= 0.01) return new Uint8ClampedArray(src);

  const out = new Uint8ClampedArray(src.length);
  const cx = w / 2 + centerX;
  const cy = h / 2 + centerY;
  const amt = (amount / 100) * 0.8;
  const STEPS = 16;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      const vx = cx - x;
      const vy = cy - y;

      let rAcc = 0;
      let gAcc = 0;
      let bAcc = 0;
      let aAcc = 0;
      let totalWeight = 0;

      for (let s = 0; s < STEPS; s++) {
        const frac = (s / STEPS) * amt;
        const sx = Math.min(w - 1, Math.max(0, Math.round(x + vx * frac)));
        const sy = Math.min(h - 1, Math.max(0, Math.round(y + vy * frac)));
        const sIdx = (sy * w + sx) * 4;

        const sr = src[sIdx]!;
        const sg = src[sIdx + 1]!;
        const sb = src[sIdx + 2]!;
        const sa = src[sIdx + 3]!;

        let weight = 1 - (s / STEPS) * 0.5;
        if (mode === 'bright') {
          const lum = (sr + sg + sb) / (255 * 3);
          weight *= 1 + lum * 2;
        } else if (mode === 'dark') {
          const lum = (sr + sg + sb) / (255 * 3);
          weight *= 1 + (1 - lum) * 2;
        }

        rAcc += sr * weight;
        gAcc += sg * weight;
        bAcc += sb * weight;
        aAcc += sa * weight;
        totalWeight += weight;
      }

      if (totalWeight > 0) {
        out[idx] = clamp255(rAcc / totalWeight);
        out[idx + 1] = clamp255(gAcc / totalWeight);
        out[idx + 2] = clamp255(bAcc / totalWeight);
        out[idx + 3] = clamp255(aAcc / totalWeight);
      }
    }
  }
  return out;
}

// ── 6. CC Cross Blur ────────────────────────────────────────────────

/**
 * CC Cross Blur — Independent separable horizontal and vertical blurs.
 */
export function crossBlurData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  radiusX = 15,
  radiusY = 15,
  repeatEdges = true,
): Uint8ClampedArray {
  const rx = Math.max(0, Math.round(radiusX));
  const ry = Math.max(0, Math.round(radiusY));

  if (rx === 0 && ry === 0) return new Uint8ClampedArray(src);

  const temp = new Uint8ClampedArray(src.length);
  const out = new Uint8ClampedArray(src.length);

  // Horizontal Pass
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let cnt = 0;

      for (let k = -rx; k <= rx; k++) {
        let sx = x + k;
        if (sx < 0 || sx >= w) {
          if (!repeatEdges) continue;
          sx = Math.max(0, Math.min(w - 1, sx));
        }
        const idx = (y * w + sx) * 4;
        r += src[idx]!;
        g += src[idx + 1]!;
        b += src[idx + 2]!;
        a += src[idx + 3]!;
        cnt++;
      }

      const outIdx = (y * w + x) * 4;
      temp[outIdx] = cnt > 0 ? r / cnt : 0;
      temp[outIdx + 1] = cnt > 0 ? g / cnt : 0;
      temp[outIdx + 2] = cnt > 0 ? b / cnt : 0;
      temp[outIdx + 3] = cnt > 0 ? a / cnt : 0;
    }
  }

  // Vertical Pass
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let cnt = 0;

      for (let k = -ry; k <= ry; k++) {
        let sy = y + k;
        if (sy < 0 || sy >= h) {
          if (!repeatEdges) continue;
          sy = Math.max(0, Math.min(h - 1, sy));
        }
        const idx = (sy * w + x) * 4;
        r += temp[idx]!;
        g += temp[idx + 1]!;
        b += temp[idx + 2]!;
        a += temp[idx + 3]!;
        cnt++;
      }

      const outIdx = (y * w + x) * 4;
      out[outIdx] = cnt > 0 ? r / cnt : 0;
      out[outIdx + 1] = cnt > 0 ? g / cnt : 0;
      out[outIdx + 2] = cnt > 0 ? b / cnt : 0;
      out[outIdx + 3] = cnt > 0 ? a / cnt : 0;
    }
  }

  return out;
}

// ── 7. CC Scale Wipe ────────────────────────────────────────────────

/**
 * CC Scale Wipe — Directional scale stretch wipe transition.
 */
export function scaleWipeData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  completion = 0,
  stretch = 10,
  direction = 0,
  centerX = 0,
  centerY = 0,
): Uint8ClampedArray {
  const comp = clamp01(completion / 100);
  if (comp <= 0.001) return new Uint8ClampedArray(src);

  const cx = w / 2 + centerX;
  const cy = h / 2 + centerY;
  const dirRad = direction * DEG;
  const ux = Math.cos(dirRad);
  const uy = Math.sin(dirRad);
  const maxDist = Math.hypot(w, h);
  const wipeEdge = comp * maxDist;

  return remap(src, w, h, (x, y) => {
    const dx = x - cx;
    const dy = y - cy;
    const proj = dx * ux + dy * uy;

    if (proj <= wipeEdge) {
      const scale = 1 + (stretch * (wipeEdge - proj)) / maxDist;
      return {
        x: cx + (dx - ux * proj) + ux * (proj / scale),
        y: cy + (dy - uy * proj) + uy * (proj / scale),
      };
    }
    return { x, y };
  });
}

// ── 8. CC Plastic ───────────────────────────────────────────────────

/**
 * CC Plastic — 3D specular plastic relief generated from layer luminance.
 */
export function plasticData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  surfaceBump = 25,
  softness = 5,
  lightAngle = 45,
  lightIntensity = 100,
  specular = 50,
): Uint8ClampedArray {
  const field = lumaField(src, w, h, softness);
  const out = new Uint8ClampedArray(src.length);
  const bump = (surfaceBump / 100) * 8;
  const la = lightAngle * DEG;
  const lx = Math.cos(la);
  const ly = -Math.sin(la);
  const lz = 0.8;
  const lLen = Math.hypot(lx, ly, lz) || 1;
  const nlx = lx / lLen;
  const nly = ly / lLen;
  const nlz = lz / lLen;

  const gain = lightIntensity / 100;
  const specGain = (specular / 100) * 1.5;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      const a = src[idx + 3]!;
      if (a === 0) continue;

      const xm = Math.max(0, x - 1);
      const xp = Math.min(w - 1, x + 1);
      const ym = Math.max(0, y - 1);
      const yp = Math.min(h - 1, y + 1);

      const gx = (field[y * w + xp]! - field[y * w + xm]!) * bump;
      const gy = (field[yp * w + x]! - field[ym * w + x]!) * bump;
      const gz = 1.0;
      const nLen = Math.hypot(gx, gy, gz) || 1;
      const nx = -gx / nLen;
      const ny = -gy / nLen;
      const nz = gz / nLen;

      // Diffuse Lambert
      const diff = Math.max(0, nx * nlx + ny * nly + nz * nlz);
      // Specular Blinn-Phong
      const hx = nlx;
      const hy = nly;
      const hz = nlz + 1.0;
      const hLen = Math.hypot(hx, hy, hz) || 1;
      const ndoth = Math.max(0, (nx * hx + ny * hy + nz * hz) / hLen);
      const spec = Math.pow(ndoth, 16) * specGain;

      const lighting = diff * gain + 0.3; // 0.3 ambient

      out[idx] = clamp255(src[idx]! * lighting + spec * 255);
      out[idx + 1] = clamp255(src[idx + 1]! * lighting + spec * 255);
      out[idx + 2] = clamp255(src[idx + 2]! * lighting + spec * 255);
      out[idx + 3] = a;
    }
  }
  return out;
}
