// ── fxkit standard library: shared by every effect, on the GPU (as WGSL) and the CPU (transpiled). ──
// Hashes are integer (PCG) so both paths agree bit for bit; noise is built on them.

const PI: f32 = 3.14159265358979;
const TAU: f32 = 6.28318530717959;

// ── hashing ──
fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn hash_u2(i: vec2i, seed: u32) -> u32 {
  return pcg(pcg(u32(i.x) + seed * 1013u) + u32(i.y) * 1664525u);
}
fn u01(h: u32) -> f32 { return f32(h >> 8u) * (1.0 / 16777216.0); }
/// 0..1 from an integer lattice point (+ seed).
fn hash21(i: vec2i, seed: u32) -> f32 { return u01(hash_u2(i, seed)); }
fn hash22(i: vec2i, seed: u32) -> vec2f {
  let h = hash_u2(i, seed);
  return vec2f(u01(h), u01(pcg(h)));
}
fn hash31(i: vec2i, z: i32, seed: u32) -> f32 { return u01(pcg(hash_u2(i, seed) + u32(z) * 2654435761u)); }
fn hash11(i: i32, seed: u32) -> f32 { return u01(pcg(u32(i) * 1597334677u + seed)); }
/// 0..1 from a float position, through its lattice cell.
fn hashf(p: vec2f, seed: u32) -> f32 { return hash21(vec2i(floor(p)), seed); }

fn fmodp(x: f32, m: f32) -> f32 { return x - m * floor(x / m); }
fn fmodp2(x: vec2f, m: vec2f) -> vec2f { return x - m * floor(x / m); }

// ── noise ──
fn quintic(t: vec2f) -> vec2f { return t * t * t * (t * (t * 6.0 - vec2f(15.0)) + vec2f(10.0)); }
fn grad2(i: vec2i, seed: u32) -> vec2f {
  let a = hash21(i, seed) * TAU;
  return vec2f(cos(a), sin(a));
}
/// Gradient noise, about -0.7..0.7.
fn gnoise(p: vec2f, seed: u32) -> f32 {
  let i = vec2i(floor(p));
  let f = p - floor(p);
  let u = quintic(f);
  let a = dot(grad2(i, seed), f);
  let b = dot(grad2(i + vec2i(1, 0), seed), f - vec2f(1.0, 0.0));
  let c = dot(grad2(i + vec2i(0, 1), seed), f - vec2f(0.0, 1.0));
  let d = dot(grad2(i + vec2i(1, 1), seed), f - vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
/// Value noise, 0..1.
fn vnoise(p: vec2f, seed: u32) -> f32 {
  let i = vec2i(floor(p));
  let f = p - floor(p);
  let u = quintic(f);
  let a = hash21(i, seed);
  let b = hash21(i + vec2i(1, 0), seed);
  let c = hash21(i + vec2i(0, 1), seed);
  let d = hash21(i + vec2i(1, 1), seed);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
/// Gradient noise animated through time: two seeds cross-faded on a smooth cycle (no 3D lattice).
fn gnoise_t(p: vec2f, t: f32, seed: u32) -> f32 {
  let k = floor(t);
  let f = t - k;
  let s0 = seed + u32(i32(k)) * 7919u;
  let w = f * f * (3.0 - 2.0 * f);
  return mix(gnoise(p + vec2f(k * 17.13, k * 5.71), s0), gnoise(p + vec2f((k + 1.0) * 17.13, (k + 1.0) * 5.71), s0 + 7919u), w);
}
fn fbm(p: vec2f, octaves: i32, lacunarity: f32, gain: f32, seed: u32) -> f32 {
  var sum = 0.0;
  var amp = 0.5;
  var q = p;
  for (var i = 0; i < octaves; i++) {
    sum += amp * gnoise(q, seed + u32(i) * 131u);
    q = rot2(q, 0.6435) * lacunarity + vec2f(19.1, 7.3);
    amp *= gain;
  }
  return sum;
}
fn fbm_t(p: vec2f, t: f32, octaves: i32, seed: u32) -> f32 {
  var sum = 0.0;
  var amp = 0.5;
  var q = p;
  for (var i = 0; i < octaves; i++) {
    sum += amp * gnoise_t(q, t * (1.0 + f32(i) * 0.37), seed + u32(i) * 131u);
    q = rot2(q, 0.6435) * 2.03 + vec2f(19.1, 7.3);
    amp *= 0.5;
  }
  return sum;
}
/// Voronoi: x = distance to the nearest feature, y = to the second, zw = the nearest cell's id (lattice).
fn voronoi(p: vec2f, jitter: f32, seed: u32) -> vec4f {
  let i = vec2i(floor(p));
  let f = p - floor(p);
  var d1 = 8.0;
  var d2 = 8.0;
  var id = vec2f(0.0);
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let g = vec2i(x, y);
      let o = hash22(i + g, seed) * jitter + vec2f(0.5 - 0.5 * jitter);
      let r = vec2f(f32(x), f32(y)) + o - f;
      let d = dot(r, r);
      if (d < d1) {
        d2 = d1;
        d1 = d;
        id = vec2f(f32(i.x + x), f32(i.y + y));
      } else if (d < d2) {
        d2 = d;
      }
    }
  }
  return vec4f(sqrt(d1), sqrt(d2), id.x, id.y);
}

// ── geometry ──
fn rot2(v: vec2f, a: f32) -> vec2f {
  let c = cos(a);
  let s = sin(a);
  return vec2f(c * v.x - s * v.y, s * v.x + c * v.y);
}
fn cmul(a: vec2f, b: vec2f) -> vec2f { return vec2f(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
fn cdiv(a: vec2f, b: vec2f) -> vec2f {
  let d = max(dot(b, b), 1e-12);
  return vec2f(a.x * b.x + a.y * b.y, a.y * b.x - a.x * b.y) / d;
}
fn cexp(z: vec2f) -> vec2f { return exp(z.x) * vec2f(cos(z.y), sin(z.y)); }
fn clog(z: vec2f) -> vec2f { return vec2f(log(max(length(z), 1e-12)), atan2(z.y, z.x)); }
fn aa_step(edge: f32, x: f32, w: f32) -> f32 { return smoothstep(edge - w, edge + w, x); }
fn remap01(x: f32, lo: f32, hi: f32) -> f32 { return clamp((x - lo) / max(hi - lo, 1e-6), 0.0, 1.0); }

// ── colour ──
fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
fn unpremul(c: vec4f) -> vec4f {
  if (c.a <= 1e-6) { return vec4f(0.0); }
  return vec4f(c.rgb / c.a, c.a);
}
fn premul(c: vec4f) -> vec4f { return vec4f(c.rgb * c.a, c.a); }
fn srgb_enc1(x: f32) -> f32 {
  let v = max(x, 0.0);
  return select(1.055 * pow(v, 1.0 / 2.4) - 0.055, v * 12.92, v <= 0.0031308);
}
fn srgb_dec1(x: f32) -> f32 {
  let v = max(x, 0.0);
  return select(pow((v + 0.055) / 1.055, 2.4), v / 12.92, v <= 0.04045);
}
fn srgb_enc(c: vec3f) -> vec3f { return vec3f(srgb_enc1(c.r), srgb_enc1(c.g), srgb_enc1(c.b)); }
fn srgb_dec(c: vec3f) -> vec3f { return vec3f(srgb_dec1(c.r), srgb_dec1(c.g), srgb_dec1(c.b)); }
fn rgb2hsv(c: vec3f) -> vec3f {
  let mx = max(c.r, max(c.g, c.b));
  let mn = min(c.r, min(c.g, c.b));
  let d = mx - mn;
  var h = 0.0;
  if (d > 1e-6) {
    if (mx == c.r) { h = fmodp((c.g - c.b) / d, 6.0); }
    else if (mx == c.g) { h = (c.b - c.r) / d + 2.0; }
    else { h = (c.r - c.g) / d + 4.0; }
  }
  return vec3f(h / 6.0, select(0.0, d / mx, mx > 1e-6), mx);
}
fn hsv2rgb(c: vec3f) -> vec3f {
  let k = vec3f(5.0, 3.0, 1.0) + vec3f(c.x * 6.0);
  let m = vec3f(fmodp(k.x, 6.0), fmodp(k.y, 6.0), fmodp(k.z, 6.0));
  let t = clamp(min(m, vec3f(4.0) - m), vec3f(0.0), vec3f(1.0));
  return c.z - c.z * c.y * t;
}
fn cbrt(x: f32) -> f32 { return sign(x) * pow(abs(x), 1.0 / 3.0); }
fn lin_to_oklab(c: vec3f) -> vec3f {
  let l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  let m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  let s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
  let l_ = cbrt(l);
  let m_ = cbrt(m);
  let s_ = cbrt(s);
  return vec3f(0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
               1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
               0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_);
}
fn oklab_to_lin(c: vec3f) -> vec3f {
  let l_ = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  let m_ = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  let s_ = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  let l = l_ * l_ * l_;
  let m = m_ * m_ * m_;
  let s = s_ * s_ * s_;
  return vec3f(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
              -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
              -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}
fn saturation(c: vec3f, s: f32) -> vec3f {
  let y = luma(c);
  return vec3f(y) + (c - vec3f(y)) * s;
}
fn screen3(a: vec3f, b: vec3f) -> vec3f { return a + b - a * b; }
fn overlay1(a: f32, b: f32) -> f32 { return select(1.0 - 2.0 * (1.0 - a) * (1.0 - b), 2.0 * a * b, a < 0.5); }
fn softlight1(a: f32, b: f32) -> f32 {
  return select(a + (2.0 * b - 1.0) * (sqrt(max(a, 0.0)) - a), a - (1.0 - 2.0 * b) * a * (1.0 - a), b <= 0.5);
}
/// A smooth spectral colour for a wavelength in nm (380..780), linear, roughly white-balanced when summed.
fn spectrum(nm: f32) -> vec3f {
  let t = (nm - 380.0) / 400.0;
  let ur = (t - 0.05) / 0.07;
  let ug = (t - 0.47) / 0.17;
  let ub = (t - 0.17) / 0.13;
  let r = smoothstep(0.45, 0.75, t) * (1.0 - smoothstep(0.92, 1.0, t)) + 0.35 * exp(-ur * ur);
  let g = exp(-ug * ug);
  let b = exp(-ub * ub);
  return max(vec3f(r, g, b), vec3f(0.0));
}
/// Inigo Quilez' cosine palette.
fn cospal(t: f32, a: vec3f, b: vec3f, c: vec3f, d: vec3f) -> vec3f { return a + b * cos(TAU * (c * t + d)); }

// ── sampling helpers ──
/// The layer blurred by about `r` world px, from the effect's pyramid (needs meta.pyramid ≥ log2(r)).
fn blurred(p: vec2f, r: f32) -> vec4f {
  if (r < 0.6) { return src(p); }
  let lk = clamp(log2(r / 0.6), 0.0, f32(levels()));
  let k0 = floor(lk);
  let t = lk - k0;
  let a = level(i32(k0), p);
  if (t < 0.001) { return a; }
  return mix(a, level(i32(k0) + 1, p), t);
}
/// Luminance gradient (central differences of the source) at p, in world px.
fn luma_grad(p: vec2f, d: f32) -> vec2f {
  let gx = luma(src(p + vec2f(d, 0.0)).rgb) - luma(src(p - vec2f(d, 0.0)).rgb);
  let gy = luma(src(p + vec2f(0.0, d)).rgb) - luma(src(p - vec2f(0.0, d)).rgb);
  return vec2f(gx, gy) / (2.0 * d);
}

// ── compositing (generators' Output ▸ Composite) ──
fn fxk_composite(base: vec4f, c: vec4f, mode: i32, opacity: f32) -> vec4f {
  var o = c;
  if (mode == 2) { o = c + base * (1.0 - c.a); }
  else if (mode == 3) { o = base + c * (1.0 - base.a); }
  else if (mode == 4) { o = vec4f(base.rgb + c.rgb, max(base.a, c.a)); }
  else if (mode == 5) { o = vec4f(base.rgb + c.rgb - base.rgb * c.rgb, base.a + c.a - base.a * c.a); }
  else if (mode == 6) { o = vec4f(base.rgb * (c.rgb + vec3f(1.0 - c.a)), base.a); }
  else if (mode == 7) { o = c * base.a; }
  return mix(base, o, opacity);
}
