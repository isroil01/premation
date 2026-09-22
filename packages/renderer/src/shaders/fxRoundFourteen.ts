/**
 * Round fourteen: the HISTOGRAM colour autos — Equalize, Auto Levels, Auto
 * Contrast, Auto Color. The one family that needs a whole-layer REDUCTION
 * before it can touch a pixel, done as three tiny passes:
 *
 *   1. `fx-histogram` — a 256×1 target. Fragment b counts, over a stratified
 *      S×S grid of layer samples (S ≤ 44, so counts stay exact in f16), how
 *      many land in byte bin b for R, G, B and Rec.709 luma → one RGBA texel
 *      of four counts. Transparent samples are skipped, as `histograms()`
 *      skips alpha-0 pixels. Summing any channel over the 256 bins recovers n.
 *   2. `fx-auto-table` — a 256×1 target. Fragment i reads the whole histogram
 *      and emits the per-channel output level for input level i: the CDF
 *      (Equalize), a percentile stretch (Auto Levels / Contrast) or the
 *      stretch plus the neutral-snap gamma (Auto Color) — with the effect's
 *      blend already folded in, exactly `applyTables`.
 *   3. `fx-auto-apply` — the layer pass: decode to bytes, look each channel
 *      up in the table, re-encode.
 *
 * The one approximation: the histogram is of ≤ 1936 stratified samples rather
 * than every pixel, so percentiles are quantised to about 0.05 %. Auto Color's
 * medians are read off the stretch table at the input median, which is exact
 * for a monotonic table.
 */

import type { ShaderSource } from './builtin';
import { fxShader } from './fxRoundSix';
import { withHelpers } from './fxRoundEight';
import { withSecondTexture } from './fxRoundTen';
import { BASE_GLSL, BASE_WGSL } from './fxRoundEleven';

// ── Pass 1: histogram ────────────────────────────────────────────────────────

/** p0 = lw, lh, grid S. Target 256×1; fragment x is the bin. */
export const FX_HISTOGRAM_FX = withHelpers(fxShader('fx-histogram', 1,
  `  let lwh = obj.p0.xy;
  let bin = i32(floor(fieldQ(uv).x * 256.0));
  let S = i32(obj.p0.z + 0.5);
  var count = vec4<f32>(0.0);
  for (var j = 0; j < 44; j = j + 1) {
    if (j >= S) { break; }
    for (var i = 0; i < 44; i = i + 1) {
      if (i >= S) { break; }
      let px = vec2<f32>((f32(i) + 0.5) / f32(S) * lwh.x, (f32(j) + 0.5) / f32(S) * lwh.y);
      let s = samplePx(px, lwh);
      if (s.a < 0.002) { continue; }
      let c = decodeS(s);
      let v = vec4<i32>(round(vec4<f32>(c.rgb, lum709(c.rgb)) * 255.0));
      count = count + select(vec4<f32>(0.0), vec4<f32>(1.0), v == vec4<i32>(bin));
    }
  }
  return count;`,
  `  vec2 lwh = p0.xy;
  int bin = int(floor(fieldQ(vUv).x * 256.0));
  int S = int(p0.z + 0.5);
  vec4 count = vec4(0.0);
  for (int j = 0; j < 44; j++) {
    if (j >= S) break;
    for (int i = 0; i < 44; i++) {
      if (i >= S) break;
      vec2 px = vec2((float(i) + 0.5) / float(S) * lwh.x, (float(j) + 0.5) / float(S) * lwh.y);
      vec4 s = samplePx(px, lwh);
      if (s.a < 0.002) continue;
      vec4 c = decodeS(s);
      ivec4 v = ivec4(round(vec4(c.rgb, lum709(c.rgb)) * 255.0));
      count += vec4(equal(v, ivec4(bin)));
    }
  }
  frag = count;`), BASE_WGSL, BASE_GLSL);

// ── Pass 2: table ────────────────────────────────────────────────────────────

const TABLE_WGSL = `fn H(j : i32) -> vec4<f32> { return textureSampleLevel(tex, smp, vec2<f32>((f32(j) + 0.5) / 256.0, 0.5), 0.0); }
fn chan(v : vec4<f32>, ch : i32) -> f32 {
  if (ch == 0) { return v.r; } if (ch == 1) { return v.g; } if (ch == 2) { return v.b; }
  if (ch == 3) { return v.a; } return v.r + v.g + v.b;
}
// percentile(): first bin at which the running count reaches total·frac, skipping empty bins.
fn pct(frac : f32, ch : i32, total : f32) -> f32 {
  let goal = total * clamp(frac, 0.0, 1.0);
  var acc = 0.0;
  for (var j = 0; j < 256; j = j + 1) {
    let h = chan(H(j), ch);
    acc = acc + h;
    if (acc >= goal && h > 0.0) { return f32(j); }
  }
  return 255.0;
}
fn stretch(i : f32, lo : f32, hi : f32) -> f32 {
  let span = hi - lo;
  return select(i, clamp((i - lo) / span * 255.0, 0.0, 255.0), span > 0.0);
}
fn gammaFor(median : f32, goal : f32) -> f32 {
  let m = clamp(median / 255.0, 0.0, 1.0); let t = clamp(goal / 255.0, 0.0, 1.0);
  if (m <= 0.001 || m >= 0.999 || t <= 0.001 || t >= 0.999) { return 1.0; }
  return clamp(log(m) / log(t), 1.0 / 3.0, 3.0);
}
`;
const TABLE_GLSL = `vec4 H(int j) { return textureLod(uTex, vec2((float(j) + 0.5) / 256.0, 0.5), 0.0); }
float chan(vec4 v, int ch) {
  if (ch == 0) return v.r; if (ch == 1) return v.g; if (ch == 2) return v.b;
  if (ch == 3) return v.a; return v.r + v.g + v.b;
}
float pct(float frac, int ch, float total) {
  float goal = total * clamp(frac, 0.0, 1.0);
  float acc = 0.0;
  for (int j = 0; j < 256; j++) {
    float h = chan(H(j), ch);
    acc += h;
    if (acc >= goal && h > 0.0) return float(j);
  }
  return 255.0;
}
float stretch(float i, float lo, float hi) {
  float span = hi - lo;
  return (span > 0.0) ? clamp((i - lo) / span * 255.0, 0.0, 255.0) : i;
}
float gammaFor(float median, float goal) {
  float m = clamp(median / 255.0, 0.0, 1.0); float t = clamp(goal / 255.0, 0.0, 1.0);
  if (m <= 0.001 || m >= 0.999 || t <= 0.001 || t >= 0.999) return 1.0;
  return clamp(log(m) / log(t), 1.0 / 3.0, 3.0);
}
`;

/**
 * tex = the histogram. p0 = mode (0 equalize RGB · 1 equalize luma · 2 auto
 * levels · 3 auto contrast · 4 auto color), amount k or black clip, white clip
 * (as 1 − clip), neutral snap; p1 = blend keep. Target 256×1; fragment x is
 * the input level; output = per-channel output level / 255.
 */
export const FX_AUTO_TABLE_FX = withHelpers(fxShader('fx-auto-table', 2,
  `  let fi = floor(fieldQ(uv).x * 256.0); let i = i32(fi);
  let mode = i32(obj.p0.x + 0.5);
  var n = 0.0;
  for (var j = 0; j < 256; j = j + 1) { n = n + H(j).r; }
  if (n <= 0.0) { return vec4<f32>(vec3<f32>(fi / 255.0), 1.0); }
  var tbl = vec3<f32>(fi);
  if (mode <= 1) {
    var acc = vec4<f32>(0.0);
    for (var j = 0; j < 256; j = j + 1) { if (j > i) { break; } acc = acc + H(j); }
    let cdf = floor(clamp(acc / n * 255.0, vec4<f32>(0.0), vec4<f32>(255.0)));
    let t3 = select(cdf.rgb, vec3<f32>(cdf.a), mode == 1);
    tbl = floor(clamp(fi + (t3 - fi) * obj.p0.y, vec3<f32>(0.0), vec3<f32>(255.0)));
  } else if (mode == 3) {
    let lo = pct(obj.p0.y, 4, n * 3.0); let hi = pct(obj.p0.z, 4, n * 3.0);
    tbl = vec3<f32>(floor(stretch(fi, lo, hi)));
  } else {
    let lo = vec3<f32>(pct(obj.p0.y, 0, n), pct(obj.p0.y, 1, n), pct(obj.p0.y, 2, n));
    let hi = vec3<f32>(pct(obj.p0.z, 0, n), pct(obj.p0.z, 1, n), pct(obj.p0.z, 2, n));
    tbl = floor(vec3<f32>(stretch(fi, lo.r, hi.r), stretch(fi, lo.g, hi.g), stretch(fi, lo.b, hi.b)));
    let snap = obj.p0.w;
    if (mode == 4 && snap > 0.0) {
      let med = vec3<f32>(
        floor(stretch(pct(0.5, 0, n), lo.r, hi.r)), floor(stretch(pct(0.5, 1, n), lo.g, hi.g)), floor(stretch(pct(0.5, 2, n), lo.b, hi.b)));
      let goal = (med.r + med.g + med.b) / 3.0;
      let g = 1.0 + (vec3<f32>(gammaFor(med.r, goal), gammaFor(med.g, goal), gammaFor(med.b, goal)) - 1.0) * snap;
      let warped = floor(clamp(pow(tbl / 255.0, 1.0 / g) * 255.0, vec3<f32>(0.0), vec3<f32>(255.0)));
      tbl = select(warped, tbl, abs(g - 1.0) < vec3<f32>(0.0001));
    }
  }
  return vec4<f32>((fi + (tbl - fi) * obj.p1.x) / 255.0, 1.0);`,
  `  float fi = floor(fieldQ(vUv).x * 256.0); int i = int(fi);
  int mode = int(p0.x + 0.5);
  float n = 0.0;
  for (int j = 0; j < 256; j++) n += H(j).r;
  if (n <= 0.0) { frag = vec4(vec3(fi / 255.0), 1.0); return; }
  vec3 tbl = vec3(fi);
  if (mode <= 1) {
    vec4 acc = vec4(0.0);
    for (int j = 0; j < 256; j++) { if (j > i) break; acc += H(j); }
    vec4 cdf = floor(clamp(acc / n * 255.0, 0.0, 255.0));
    vec3 t3 = (mode == 1) ? vec3(cdf.a) : cdf.rgb;
    tbl = floor(clamp(fi + (t3 - fi) * p0.y, 0.0, 255.0));
  } else if (mode == 3) {
    float lo = pct(p0.y, 4, n * 3.0); float hi = pct(p0.z, 4, n * 3.0);
    tbl = vec3(floor(stretch(fi, lo, hi)));
  } else {
    vec3 lo = vec3(pct(p0.y, 0, n), pct(p0.y, 1, n), pct(p0.y, 2, n));
    vec3 hi = vec3(pct(p0.z, 0, n), pct(p0.z, 1, n), pct(p0.z, 2, n));
    tbl = floor(vec3(stretch(fi, lo.r, hi.r), stretch(fi, lo.g, hi.g), stretch(fi, lo.b, hi.b)));
    float snap = p0.w;
    if (mode == 4 && snap > 0.0) {
      vec3 med = vec3(
        floor(stretch(pct(0.5, 0, n), lo.r, hi.r)), floor(stretch(pct(0.5, 1, n), lo.g, hi.g)), floor(stretch(pct(0.5, 2, n), lo.b, hi.b)));
      float goal = (med.r + med.g + med.b) / 3.0;
      vec3 g = 1.0 + (vec3(gammaFor(med.r, goal), gammaFor(med.g, goal), gammaFor(med.b, goal)) - 1.0) * snap;
      vec3 warped = floor(clamp(pow(tbl / 255.0, 1.0 / g) * 255.0, 0.0, 255.0));
      tbl = mix(warped, tbl, vec3(lessThan(abs(g - 1.0), vec3(0.0001))));
    }
  }
  frag = vec4((fi + (tbl - fi) * p1.x) / 255.0, 1.0);`), BASE_WGSL + TABLE_WGSL, BASE_GLSL + TABLE_GLSL);

// ── Pass 3: apply ────────────────────────────────────────────────────────────

/** tex = layer, tex2 = the 256×1 table. Byte lookup per channel; transparent pixels untouched. */
export const FX_AUTO_APPLY_FX = withHelpers(withSecondTexture(fxShader('fx-auto-apply', 1,
  `  let s = textureSampleLevel(tex, smp, uv, 0.0);
  if (s.a <= 0.0) { return s; }
  let c = decodeS(s);
  let idx = (round(c.rgb * 255.0) + 0.5) / 256.0;
  let r = textureSampleLevel(tex2, smp, vec2<f32>(idx.r, 0.5), 0.0).r;
  let g = textureSampleLevel(tex2, smp, vec2<f32>(idx.g, 0.5), 0.0).g;
  let b = textureSampleLevel(tex2, smp, vec2<f32>(idx.b, 0.5), 0.0).b;
  return encodeOut(vec3<f32>(r, g, b), c.a);`,
  `  vec4 s = textureLod(uTex, vUv, 0.0);
  if (s.a <= 0.0) { frag = s; return; }
  vec4 c = decodeS(s);
  vec3 idx = (round(c.rgb * 255.0) + 0.5) / 256.0;
  float r = textureLod(uMaskTex, vec2(idx.r, 0.5), 0.0).r;
  float g = textureLod(uMaskTex, vec2(idx.g, 0.5), 0.0).g;
  float b = textureLod(uMaskTex, vec2(idx.b, 0.5), 0.0).b;
  frag = encodeOut(vec3(r, g, b), c.a);`)), BASE_WGSL, BASE_GLSL);

export const FX_ROUND_FOURTEEN_SHADERS: readonly ShaderSource[] = [FX_HISTOGRAM_FX, FX_AUTO_TABLE_FX, FX_AUTO_APPLY_FX];
