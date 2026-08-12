/**
 * Distort, round four — Ripple, Magnify, Warp, Page Turn, Split, Slant, Smear,
 * Rolling Shutter.
 *
 * ## Every one of these is an INVERSE map
 *
 * The kernels answer "which SOURCE pixel does this DESTINATION pixel show?",
 * never "where does this source pixel go?". This is the single most important
 * fact in the file and the easiest to get backwards, because a forward map
 * written by mistake still produces a plausible distorted picture — just bent
 * the wrong way, and with holes where no source pixel happened to land.
 *
 * A test that only checks "the output differs from the input" cannot see the
 * error. Only a DIRECTIONAL assertion can: push content right and check it
 * arrived right. See `gotcha_motion_inverse_map_direction`.
 *
 * Consequence worth internalising: to move content in `+x`, the map must sample
 * from `−x`. Every sign in this file that looks backwards is.
 *
 * `remap` (from `distort.ts`) does the bilinear sampling and treats an
 * out-of-range or null source as transparent rather than clamping, so none of
 * these smear their border pixel into a streak.
 */

import { remap } from './distort';
import { clamp01, clamp255 } from './colorSpace';

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

// ── Ripple ──────────────────────────────────────────────────────────

/**
 * Ripple — concentric sine waves radiating from a centre.
 *
 * The displacement is RADIAL: a destination pixel samples from a point pushed
 * in or out along the line to the centre. Displacing in x/y instead would give
 * a wobble, not a ripple, and the difference is obvious the moment the centre
 * is off-frame.
 *
 * `phase` is what animates. Keyframing it linearly makes the rings travel
 * outward at constant speed, which is the whole reason it is a separate control
 * from `frequency` rather than being folded into it.
 */
export function rippleData(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  centerX: number,
  centerY: number,
  radius: number,
  amplitude: number,
  frequency: number,
  phase: number,
  decay: number,
): Uint8ClampedArray {
  if (amplitude === 0) return data;
  const cx = w / 2 + centerX;
  const cy = h / 2 + centerY;
  const rad = radius > 0 ? radius : Math.hypot(w, h);
  const ph = (phase * Math.PI) / 180;
  const dec = Math.max(0, decay);

  return remap(data, w, h, (dx, dy) => {
    const ox = dx - cx;
    const oy = dy - cy;
    const d = Math.hypot(ox, oy);
    if (d < 1e-6 || d > rad) return { x: dx, y: dy };
    // Falloff toward the outer radius so the ripple does not end at a hard
    // circular seam — the same reasoning as `radialFalloff` in distort.ts.
    const t = 1 - d / rad;
    const falloff = t * t * (3 - 2 * t) * Math.exp(-dec * (d / rad));
    const push = Math.sin((d / Math.max(1e-6, rad)) * frequency * Math.PI * 2 - ph) * amplitude * falloff;
    // MINUS: to make the content move outward by `push`, sample from inward.
    const k = (d - push) / d;
    return { x: cx + ox * k, y: cy + oy * k };
  });
}

// ── Magnify ─────────────────────────────────────────────────────────

/**
 * Magnify — a lens over a circular (or square) region.
 *
 * `shape` 0 = circle, 1 = square. Inside the region the sample point is pulled
 * toward the centre by `1/scale`, which is what makes the centre's content
 * cover more area. `feather` softens the boundary by ramping the scale back to
 * 1 rather than by blending two images — ramping the GEOMETRY keeps straight
 * lines continuous across the rim, where blending would show them doubled.
 */
export function magnifyData(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  centerX: number,
  centerY: number,
  magnification: number,
  radius: number,
  shape: number,
  feather: number,
): Uint8ClampedArray {
  const scale = Math.max(0.01, magnification / 100);
  if (Math.abs(scale - 1) < 1e-6 || radius <= 0) return data;
  const cx = w / 2 + centerX;
  const cy = h / 2 + centerY;
  const sq = Math.round(shape) === 1;
  const feath = clamp(feather, 0, radius);

  return remap(data, w, h, (dx, dy) => {
    const ox = dx - cx;
    const oy = dy - cy;
    const d = sq ? Math.max(Math.abs(ox), Math.abs(oy)) : Math.hypot(ox, oy);
    if (d > radius) return { x: dx, y: dy };
    // 1 inside the core, ramping to 0 across the feather band at the rim.
    const edge = radius - feath;
    const t = feath <= 0 ? 1 : 1 - clamp01((d - edge) / feath);
    const s = 1 + (1 / scale - 1) * (t * t * (3 - 2 * t));
    return { x: cx + ox * s, y: cy + oy * s };
  });
}

// ── Warp ────────────────────────────────────────────────────────────

/**
 * Warp — envelope distortions, in the AE sense.
 *
 * `style`: 0 Arc · 1 Arch · 2 Flag · 3 Wave · 4 Fisheye · 5 Rise · 6 Bulge.
 *
 * All seven are one-dimensional envelopes evaluated on the normalised
 * coordinate, so `bend` behaves consistently across them and switching style
 * keeps the amount meaningful. `axis` 0 = horizontal, 1 = vertical, which is
 * AE's Warp Axis and doubles the set without doubling the code.
 */
export function warpData(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  style: number,
  bend: number,
  horizontal: number,
  vertical: number,
  axis: number,
): Uint8ClampedArray {
  const b = bend / 100;
  if (b === 0 && horizontal === 0 && vertical === 0) return data;
  const st = Math.round(style);
  const vert = Math.round(axis) === 1;

  return remap(data, w, h, (dx, dy) => {
    // u runs across the warp axis, v along it; both normalised to −1..1 so the
    // envelopes below are written once and work either way round.
    const u = vert ? (dy / h) * 2 - 1 : (dx / w) * 2 - 1;
    const v = vert ? (dx / w) * 2 - 1 : (dy / h) * 2 - 1;
    let du = 0;
    let dv = 0;

    switch (st) {
      case 0: // Arc — the whole edge bows.
        dv = b * (1 - u * u);
        break;
      case 1: // Arch — bows the far edge only, so the near edge stays straight.
        dv = b * (1 - u * u) * (v * 0.5 + 0.5);
        break;
      case 2: // Flag — a travelling wave that grows along v.
        dv = b * Math.sin(u * Math.PI * 2) * (v * 0.5 + 0.5);
        break;
      case 3: // Wave — uniform sine, no growth.
        dv = b * Math.sin(u * Math.PI * 2);
        break;
      case 4: { // Fisheye — radial, magnifying the centre.
        const r = Math.hypot(u, v);
        const k = 1 + b * (1 - clamp01(r));
        du = u * (k - 1);
        dv = v * (k - 1);
        break;
      }
      case 5: // Rise — a monotonic shear along u.
        dv = b * (u * 0.5 + 0.5);
        break;
      default: // Bulge — pushes the middle out along v.
        dv = b * (1 - u * u) * v;
        break;
    }

    // MINUS on the displacement: see the file header. Content moves by +d only
    // if the sample is taken from −d.
    const su = u - du - (vert ? vertical : horizontal) / 100;
    const sv = v - dv - (vert ? horizontal : vertical) / 100;
    const sx = vert ? ((sv + 1) / 2) * w : ((su + 1) / 2) * w;
    const sy = vert ? ((su + 1) / 2) * h : ((sv + 1) / 2) * h;
    return { x: sx, y: sy };
  });
}

// ── Page Turn ───────────────────────────────────────────────────────

/**
 * Page Turn — peel a corner back over a cylinder.
 *
 * Geometry: a fold LINE at angle `angle`, positioned by `amount`. Content
 * beyond the line wraps around a cylinder of radius `radius` and comes back
 * over the page, mirrored. Content before it is untouched.
 *
 * Written as its own loop rather than through `remap` because the effect is not
 * purely geometric — the curled flap has to be SHADED, and the back face
 * dimmed, or the result reads as a mirrored copy rather than as paper. Shading
 * is a function of the same fold distance the geometry uses, so computing both
 * in one pass is also the cheaper arrangement.
 */
export function pageTurnData(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  amount: number,
  angle: number,
  radius: number,
  backOpacity: number,
  shading: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(data.length);
  const t = clamp01(amount / 100);
  if (t <= 0) return new Uint8ClampedArray(data);

  const a = (angle * Math.PI) / 180;
  const nx = Math.cos(a);
  const ny = Math.sin(a);
  const diag = Math.abs(w * nx) + Math.abs(h * ny);
  // Fold line travels from fully-unturned to fully past the far corner.
  const foldAt = (1 - t) * diag - (w * nx + h * ny) / 2 + diag * 0;
  const rad = Math.max(1, radius);
  const backA = clamp01(backOpacity / 100);
  const shade = clamp01(shading / 100);

  const sample = (sx: number, sy: number, di: number, mul: number, alphaMul: number): void => {
    const x0 = Math.floor(sx - 0.5), y0 = Math.floor(sy - 0.5);
    const fx = sx - 0.5 - x0, fy = sy - 0.5 - y0;
    for (let c = 0; c < 4; c++) {
      let acc = 0;
      for (let j = 0; j <= 1; j++) {
        for (let i = 0; i <= 1; i++) {
          const px = x0 + i, py = y0 + j;
          if (px < 0 || px >= w || py < 0 || py >= h) continue;
          acc += data[(py * w + px) * 4 + c]! * ((i ? fx : 1 - fx) * (j ? fy : 1 - fy));
        }
      }
      out[di + c] = c === 3 ? acc * alphaMul : acc * mul;
    }
  };

  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const di = (dy * w + dx) * 4;
      // Signed distance from the fold line, in the direction the page peels.
      const d = (dx + 0.5 - w / 2) * nx + (dy + 0.5 - h / 2) * ny - foldAt;

      if (d < 0) {
        // Flat, untouched part of the page.
        const si = di;
        out[si] = data[di]!; out[si + 1] = data[di + 1]!;
        out[si + 2] = data[di + 2]!; out[si + 3] = data[di + 3]!;
        continue;
      }
      if (d > Math.PI * rad) {
        // Past the far side of the cylinder — the page has lifted away and
        // what is behind it is nothing. Left transparent rather than showing
        // the flat page, which would make the turn look like a wipe.
        continue;
      }
      // Wrap: arc length `d` around a cylinder of radius `rad` maps back to a
      // point `d` before the fold, mirrored.
      const theta = d / rad;
      const back = rad * Math.sin(theta);
      const sx = dx + 0.5 - nx * (d + back);
      const sy = dy + 0.5 - ny * (d + back);
      if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;
      // Lambert-ish shading from the cylinder normal, so the curl reads round.
      const lit = 1 - shade * (1 - Math.cos(theta));
      sample(sx, sy, di, clamp01(lit) * (0.35 + 0.65 * backA), backA);
    }
  }
  return out;
}

// ── Split ───────────────────────────────────────────────────────────

/**
 * Split — cut along a line and slide the two halves apart.
 *
 * The gap opens symmetrically, so the content stays centred as it separates.
 *
 * The halves move along the cut's NORMAL, not along the cut. That is what makes
 * this a split rather than a shear: sliding the two sides parallel to the cut
 * line keeps them touching and just offsets them past each other, which is a
 * completely different (and much less useful) effect. Moving along the normal
 * is what opens a parallel-sided gap, at any angle.
 */
export function splitData(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  offset: number,
  angle: number,
  centerX: number,
  centerY: number,
): Uint8ClampedArray {
  if (offset === 0) return data;
  const a = (angle * Math.PI) / 180;
  // Normal to the cut. The halves move ALONG this, which is what opens a gap;
  // moving along the cut instead would just slide them past each other.
  const nx = Math.cos(a);
  const ny = Math.sin(a);
  const cx = w / 2 + centerX;
  const cy = h / 2 + centerY;
  const half = offset / 2;

  return remap(data, w, h, (dx, dy) => {
    const side = (dx - cx) * nx + (dy - cy) * ny >= 0 ? 1 : -1;
    // MINUS: content on the `+` side moves toward `+n`, so it is sampled from
    // behind. See the file header — every sign that looks backwards is.
    return { x: dx - side * half * nx, y: dy - side * half * ny };
  });
}

// ── Slant ───────────────────────────────────────────────────────────

/**
 * Slant — a shear, hinged on a chosen line.
 *
 * `axis` 0 shears horizontally with height, 1 vertically with width.
 * `floor` picks where the hinge sits (0 = top/left, 1 = bottom/right, 0.5 =
 * centre), which is the difference between an italic lean and a card falling
 * over, and is why it is a control rather than a constant.
 */
export function slantData(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  slant: number,
  axis: number,
  floor: number,
): Uint8ClampedArray {
  if (slant === 0) return data;
  const vert = Math.round(axis) === 1;
  const anchor = clamp01(floor);

  return remap(data, w, h, (dx, dy) => {
    if (vert) {
      const t = dx / w - anchor;
      return { x: dx, y: dy - slant * t };
    }
    const t = dy / h - anchor;
    return { x: dx - slant * t, y: dy };
  });
}

// ── Smear ───────────────────────────────────────────────────────────

/**
 * Smear — drag a disc of pixels from one point toward another.
 *
 * The liquify-style push. Inside `radius` of the source point, the sample is
 * pulled back along the drag vector by an amount that falls off toward the rim,
 * so content stretches rather than translating as a disc.
 *
 * `elasticity` shapes that falloff: low values give a hard, taffy-like pull
 * with a visible boundary, high values a gentle smear. Exposed because the two
 * looks are used for completely different things and neither is a default.
 */
export function smearData(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  radius: number,
  elasticity: number,
): Uint8ClampedArray {
  const fx = w / 2 + fromX;
  const fy = h / 2 + fromY;
  const vx = toX - fromX;
  const vy = toY - fromY;
  if ((vx === 0 && vy === 0) || radius <= 0) return data;
  const el = Math.max(0.1, elasticity / 100);

  return remap(data, w, h, (dx, dy) => {
    const d = Math.hypot(dx - fx, dy - fy);
    if (d >= radius) return { x: dx, y: dy };
    const t = 1 - d / radius;
    const k = Math.pow(t * t * (3 - 2 * t), 1 / el);
    // MINUS again: content is dragged toward `to`, so sample from behind it.
    return { x: dx - vx * k, y: dy - vy * k };
  });
}

// ── Rolling Shutter ─────────────────────────────────────────────────

/**
 * Rolling Shutter — the CMOS skew, as an effect.
 *
 * A rolling-shutter sensor exposes one scanline at a time, so during a fast pan
 * each row is captured at a slightly different moment and the frame SHEARS.
 * Verticals lean; a fast enough pan makes them curve.
 *
 * `direction` 0 = rows expose top-to-bottom (the usual), 1 = bottom-to-top.
 * `sweep` is the shear across the full frame in pixels; `wobble` adds the
 * non-linear component that turns a lean into a curve, which is what
 * distinguishes real rolling shutter from a plain skew and is the reason this
 * is not just Slant with a different label.
 */
export function rollingShutterData(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  sweep: number,
  wobble: number,
  direction: number,
  vertical: boolean,
): Uint8ClampedArray {
  if (sweep === 0 && wobble === 0) return data;
  const flip = Math.round(direction) === 1;

  return remap(data, w, h, (dx, dy) => {
    // Exposure phase of this scanline, 0 at the first row read to 1 at the last.
    const along = vertical ? dx / w : dy / h;
    const t = flip ? 1 - along : along;
    const shift = sweep * t + wobble * Math.sin(t * Math.PI * 2);
    return vertical ? { x: dx, y: dy - shift } : { x: dx - shift, y: dy };
  });
}

// ── Radial Shadow ───────────────────────────────────────────────────

/**
 * Radial Shadow — a shadow cast from a POINT light.
 *
 * Distinct from Drop Shadow, and worth having both: a drop shadow offsets the
 * silhouette by a fixed distance, so it is the shadow of a light at infinity
 * and every part moves the same way. A point light PROJECTS — the shadow scales
 * and stretches with distance from the light, which is what makes it read as a
 * lamp in the scene rather than as a sticker offset.
 *
 * `renderMode` 0 = regular (shadow behind the layer), 1 = shadow only.
 *
 * Projection is a scale about the light position: a point at distance d from
 * the light lands at d·(1 + projection). Sampling that inverse is what builds
 * the shadow's alpha, then it is blurred and composited under the layer.
 */
export function radialShadowData(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  lightX: number,
  lightY: number,
  projection: number,
  color: [number, number, number],
  opacity: number,
  softness: number,
  renderMode: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(data.length);
  const lx = w / 2 + lightX;
  const ly = h / 2 + lightY;
  const proj = 1 + Math.max(0, projection) / 100;
  const op = clamp01(opacity / 100);
  const shadowOnly = Math.round(renderMode) === 1;

  // Project the silhouette's ALPHA. Inverse map about the light: the shadow at
  // destination p shows the occluder at light + (p − light)/proj.
  // Annotated for the same TS 5.7 typed-array reason as aeKeyingAdvanced: the
  // blur helper below returns `<ArrayBufferLike>`, which cannot be assigned
  // back into a binding inferred as `<ArrayBuffer>`.
  let shadow: Float32Array<ArrayBufferLike> = new Float32Array(w * h);
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const sx = lx + (dx + 0.5 - lx) / proj;
      const sy = ly + (dy + 0.5 - ly) / proj;
      if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;
      shadow[dy * w + dx] = data[((sy | 0) * w + (sx | 0)) * 4 + 3]! / 255;
    }
  }
  if (softness > 0) shadow = blurField(shadow, w, h, Math.round(softness));

  for (let p = 0, i = 0; p < shadow.length; p++, i += 4) {
    const s = clamp01(shadow[p]!) * op;
    const la = data[i + 3]! / 255;
    if (shadowOnly) {
      out[i] = color[0]; out[i + 1] = color[1]; out[i + 2] = color[2];
      out[i + 3] = clamp255(s * 255);
      continue;
    }
    // Layer over shadow, straight alpha.
    const outA = la + s * (1 - la);
    if (outA <= 0) continue;
    for (let c = 0; c < 3; c++) {
      out[i + c] = clamp255((data[i + c]! * la + color[c]! * s * (1 - la)) / outA);
    }
    out[i + 3] = clamp255(outA * 255);
  }
  return out;
}

/** Separable box blur over a scalar field, used for shadow softness. */
function blurField(a: Float32Array, w: number, h: number, radius: number): Float32Array {
  const r = Math.max(1, radius);
  const tmp = new Float32Array(a.length);
  const out = new Float32Array(a.length);
  const span = r * 2 + 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let d = -r; d <= r; d++) s += a[y * w + clamp(x + d, 0, w - 1)]!;
      tmp[y * w + x] = s / span;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let d = -r; d <= r; d++) s += tmp[clamp(y + d, 0, h - 1) * w + x]!;
      out[y * w + x] = s / span;
    }
  }
  return out;
}
