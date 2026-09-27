// E4 (effect_chain.cpp): Vegas on the GPU — vegas.ts's dashes along the alpha
// contours, drawn from the contour texture (binding 3, effects/contour_texture.hpp:
// one float32 per RGBA8 texel) with every Vegas param a uniform. One instance
// per contour vertex draws its segment as a capsule quad; the fragment finds
// the nearest lit arc of its contour (the dash layout of vegas_runs: n slots,
// `lit` of each, pitch bunched or even, the phase from Rotation and Random
// Phase), and covers it with the stroke's profile — a hard, antialiased edge,
// or at Hardness < 100 the Gaussian of blur((100 - h) / 100 · w / 2) across a
// line, exact for a straight run. Instances blend with MAX into a cleared
// buffer, so joints and overlapping capsules never double up (a Canvas2D
// stroke is one shape).
//
//   mvp / uvRect  the layer quad (raster uv → clip), as its content draw
//   color         working-space colour (straight), a = 1
//   p0  width (layer px), hardness, opacity, segments
//   p1  length %, rotation (deg), bunched, random phase
//   p2  seed, start / mid / end opacity (%)
//   p3  mid position (%), instance count drawn, 0, 0
struct Object { mvp : mat3x3<f32>, uvRect : vec4<f32>, color : vec4<f32>, p0 : vec4<f32>, p1 : vec4<f32>, p2 : vec4<f32>, p3 : vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
@group(0) @binding(3) var data : texture_2d<f32>;

const ROW : u32 = 1024u;
const HEADER : u32 = 8u;

fn fetch(i : u32) -> f32 {
  let t = textureLoad(data, vec2<i32>(i32(i % ROW), i32(i / ROW)), 0);
  let b = vec4<u32>(round(t * 255.0));
  return bitcast<f32>(b.x | (b.y << 8u) | (b.z << 16u) | (b.w << 24u));
}

struct VOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) px : vec2<f32>,
  @location(1) @interpolate(flat) a : vec2<f32>,
  @location(2) @interpolate(flat) b : vec2<f32>,
  // arc at a, arc at b, contour total, contour phase
  @location(3) @interpolate(flat) arc : vec4<f32>,
  // half width, blur sigma (raster px), 0, 0
  @location(4) @interpolate(flat) stroke : vec4<f32>,
};

// vegas.ts hash01 (int32 arithmetic).
fn hash01(a : f32, b : f32) -> f32 {
  var x = bitcast<u32>(i32(a)) * 374761393u + bitcast<u32>(i32(b)) * 668265263u;
  x = (x ^ (x >> 13u)) * 1274126177u;
  return f32(x ^ (x >> 16u)) / 4294967296.0;
}

@vertex fn vs(@location(0) pos : vec2<f32>, @builtin(instance_index) inst : u32) -> VOut {
  var o : VOut;
  let vertexCount = u32(fetch(0u));
  let contourCount = u32(fetch(1u));
  let size = vec2<f32>(fetch(2u), fetch(3u));
  let ss = fetch(4u);
  if (inst >= vertexCount) {
    o.pos = vec4<f32>(2.0, 2.0, 0.0, 1.0);  // clipped: past the contour table's end
    return o;
  }
  let vbase = HEADER + contourCount * 4u;
  let v = vbase + inst * 4u;
  let c = u32(fetch(v + 3u));
  let first = u32(fetch(HEADER + c * 4u));
  let count = u32(fetch(HEADER + c * 4u + 1u));
  let total = fetch(HEADER + c * 4u + 2u);
  var next = inst + 1u;
  if (next >= first + count) { next = first; }
  let n = vbase + next * 4u;
  let a = vec2<f32>(fetch(v), fetch(v + 1u));
  let b = vec2<f32>(fetch(n), fetch(n + 1u));
  let sa = fetch(v + 2u);
  let sb = sa + distance(a, b);
  let halfW = max(0.1, obj.p0.x) * ss * 0.5;
  let sigma = (100.0 - obj.p0.y) / 100.0 * max(0.1, obj.p0.x) * ss * 0.5;
  let reach = halfW + 3.0 * sigma + 1.5;
  var dir = b - a;
  let len = length(dir);
  dir = select(vec2<f32>(1.0, 0.0), dir / max(len, 1e-6), len > 1e-6);
  let nrm = vec2<f32>(-dir.y, dir.x);
  // The unit quad's corner → a capsule box around the segment.
  let along = mix(-reach, len + reach, pos.x);
  let across = mix(-reach, reach, pos.y);
  let p = a + dir * along + nrm * across;
  let uv = p / size;
  let local = (uv - obj.uvRect.xy) / obj.uvRect.zw;
  o.pos = vec4<f32>((obj.mvp * vec3<f32>(local, 1.0)).xy, 0.0, 1.0);
  o.px = p;
  o.a = a;
  o.b = b;
  var phase = obj.p1.y / 360.0 * total;
  if (obj.p1.w > 0.5) { phase = phase + hash01(obj.p2.x, f32(c)) * total; }
  o.arc = vec4<f32>(sa, sb, total, phase);
  o.stroke = vec4<f32>(halfW, sigma, 0.0, 0.0);
  return o;
}

fn erfApprox(x : f32) -> f32 {
  // Abramowitz–Stegun 7.1.26 (|error| < 1.5e-7).
  let s = sign(x);
  let t = 1.0 / (1.0 + 0.3275911 * abs(x));
  let y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-x * x);
  return s * y;
}

fn opacityAt(u : f32) -> f32 {
  let m = clamp(obj.p3.x / 100.0, 0.001, 0.999);
  let uu = clamp(u, 0.0, 1.0);
  var v = 0.0;
  if (uu <= m) { v = obj.p2.y + (obj.p2.z - obj.p2.y) * uu / m; }
  else { v = obj.p2.z + (obj.p2.w - obj.p2.z) * (uu - m) / (1.0 - m); }
  return clamp(v / 100.0, 0.0, 1.0);
}

@fragment fn fs(v : VOut) -> @location(0) vec4<f32> {
  let total = v.arc.z;
  if (total <= 0.0) { discard; }
  let ab = v.b - v.a;
  let len2 = max(dot(ab, ab), 1e-12);
  let segLen = sqrt(len2);
  let t = clamp(dot(v.px - v.a, ab) / len2, 0.0, 1.0);
  let s = v.arc.x + t * segLen;
  let n = max(1.0, round(obj.p0.w));
  let slot = total / n;
  let lit = clamp(obj.p1.x / 100.0, 0.0, 1.0) * slot;
  if (lit <= 0.0) { discard; }
  var pitch = slot;
  if (obj.p1.z > 0.5) { pitch = lit + min(slot - lit, lit * 0.5); }
  let phase = v.arc.w;
  // The dash this arc falls in (or follows), and its neighbours.
  let d = ((s - phase) % total + total) % total;
  let k = floor(d / pitch);
  let start0 = s - (d - k * pitch);
  var best = 1e9;
  var bestU = 0.0;
  for (var j = -1; j <= 1; j = j + 1) {
    var kk = k + f32(j);
    var st = start0 + f32(j) * pitch;
    // Past the last slot the next dash is slot 0 of the next lap.
    if (kk >= n) { st = st + (total - n * pitch); kk = kk - n; }
    // Before slot 0 the previous dash is the last slot of the previous lap.
    if (kk < 0.0) { kk = kk + n; st = start0 - k * pitch - total + (n - 1.0) * pitch; }
    if (kk >= n || kk < 0.0) { continue; }
    let lo = st;
    let hi = st + lit;
    let sc = clamp(clamp(s, lo, hi), v.arc.x, v.arc.y);
    let q = v.a + ab * ((sc - v.arc.x) / segLen);
    let dist = distance(v.px, q);
    if (dist < best && (sc >= lo - 1e-3 && sc <= hi + 1e-3)) {
      best = dist;
      bestU = (sc - lo) / lit;
    }
  }
  if (best >= 1e8) { discard; }
  let r = v.stroke.x;
  let sigma = v.stroke.y;
  var cov = 0.0;
  if (sigma < 0.05) {
    cov = clamp(r - best + 0.5, 0.0, 1.0);
  } else {
    let k2 = 1.0 / (sigma * 1.41421356);
    cov = 0.5 * (erfApprox((r - best) * k2) + erfApprox((r + best) * k2));
  }
  let a = clamp(cov * min(1.0, obj.p0.z) * opacityAt(bestU), 0.0, 1.0);
  if (a <= 0.0) { discard; }
  return vec4<f32>(obj.color.rgb * a, a);
}
