
struct Object {
  mvp : mat3x3<f32>,
  uvRect : vec4<f32>,
  tint : vec4<f32>,
  cr0 : vec4<f32>,
  cr1 : vec4<f32>,
  cr2 : vec4<f32>,
  srcSpace : vec4<f32>,
};
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
@group(0) @binding(3) var lutTex : texture_2d<f32>;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex
fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut;
  let p = obj.mvp * vec3<f32>(pos, 1.0);
  o.pos = vec4<f32>(p.xy, 0.0, p.z);
  o.uv = obj.uvRect.xy + pos * obj.uvRect.zw;
  return o;
}
fn unpremul(t : vec4<f32>) -> vec4<f32> {
  if (t.a < 0.00392156862745098) { return vec4<f32>(0.0, 0.0, 0.0, 0.0); }
  return vec4<f32>(t.rgb / t.a, t.a);
}


fn srgbToLinearChan(c : f32) -> f32 {
  if (c <= 0.04045) { return c / 12.92; }
  return pow((c + 0.055) / 1.055, 2.4);
}
fn linearToSrgbChan(c : f32) -> f32 {
  if (c <= 0.0031308) { return c * 12.92; }
  return 1.055 * pow(max(c, 0.0), 1.0 / 2.4) - 0.055;
}
fn srgbToLinearRgb(c : vec3<f32>) -> vec3<f32> {
  return vec3<f32>(srgbToLinearChan(c.r), srgbToLinearChan(c.g), srgbToLinearChan(c.b));
}
fn linearToSrgbRgb(c : vec3<f32>) -> vec3<f32> {
  return vec3<f32>(linearToSrgbChan(c.r), linearToSrgbChan(c.g), linearToSrgbChan(c.b));
}

fn linearSrgbToAcesCg(c : vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    dot(c, vec3<f32>(0.613097396, 0.339523469, 0.047379562)),
    dot(c, vec3<f32>(0.070194066, 0.916353879, 0.013452032)),
    dot(c, vec3<f32>(0.020615588, 0.109569769, 0.869814633)),
  );
}

fn acesOdtSrgb(c : vec3<f32>) -> vec3<f32> {
  var v = max(c, vec3<f32>(0.0));
  let a = v * (v + vec3<f32>(0.0245786)) - vec3<f32>(0.0000905377);
  let b = v * (0.983729 * v + vec3<f32>(0.4329510)) + vec3<f32>(0.238081);
  return clamp(a / b, vec3<f32>(0.0), vec3<f32>(1.0));
}

fn hlgOetfChannel(E : f32) -> f32 {
  // ARIB STD-B67 — same curve as hdrTransfer.ts (HDR export). Preview ODT
  // must match delivery or Comp Settings “HLG” and Export ▸ HLG diverge.
  let a = 0.17883277;
  let b = 0.28466892;
  let c = 0.55991073;
  let e = max(E, 0.0);
  if (e <= 1.0 / 12.0) { return sqrt(3.0 * e); }
  return a * log(12.0 * e - b) + c;
}

fn workingToDisplay(rgb : vec3<f32>, srcSpace : vec4<f32>) -> vec3<f32> {
  // z≈3 → HLG (ARIB STD-B67) preview ODT on SDR canvas.
  if (srcSpace.z > 2.5) {
    var v = max(rgb, vec3<f32>(0.0));
    if (srcSpace.y > 0.5) {
      v = vec3<f32>(
        dot(v, vec3<f32>(1.6410233797, -0.3248032942, -0.2364246952)),
        dot(v, vec3<f32>(-0.6636628587, 1.6153315917, 0.0167563477)),
        dot(v, vec3<f32>(0.0117218943, -0.0082844420, 0.9883948585)),
      );
      v = max(v, vec3<f32>(0.0));
    }
    return clamp(vec3<f32>(hlgOetfChannel(v.x), hlgOetfChannel(v.y), hlgOetfChannel(v.z)), vec3<f32>(0.0), vec3<f32>(1.0));
  }
  // z≈2 → PQ (ST.2084) foothold: map linear scene → PQ then re-expand for
  // SDR canvas preview. Not a real HDR10 encode — just a selectable ODT.
  if (srcSpace.z > 1.5) {
    var v = max(rgb, vec3<f32>(0.0));
    if (srcSpace.y > 0.5) {
      // ACEScg → approx linear Rec.709 for the PQ curve.
      v = vec3<f32>(
        dot(v, vec3<f32>(1.6410233797, -0.3248032942, -0.2364246952)),
        dot(v, vec3<f32>(-0.6636628587, 1.6153315917, 0.0167563477)),
        dot(v, vec3<f32>(0.0117218943, -0.0082844420, 0.9883948585)),
      );
      v = max(v, vec3<f32>(0.0));
    }
    let m1 = 0.1593017578125;
    let m2 = 78.84375;
    let c1 = 0.8359375;
    let c2 = 18.8515625;
    let c3 = 18.6875;
    let Y = max(v, vec3<f32>(0.0)) / 100.0; // assume ~100 nit scene white
    let Ym = pow(Y, vec3<f32>(m1));
    let pq = pow((c1 + c2 * Ym) / (1.0 + c3 * Ym), vec3<f32>(m2));
    return clamp(pq, vec3<f32>(0.0), vec3<f32>(1.0));
  }
  if (srcSpace.z > 0.5) {
    var v = rgb;
    if (srcSpace.y < 0.5) { v = linearSrgbToAcesCg(v); }
    return acesOdtSrgb(v);
  }
  return linearToSrgbRgb(rgb);
}


fn workingFromSample(rgb : vec3<f32>, srcLinear : f32) -> vec3<f32> {
  return select(srgbToLinearRgb(rgb), rgb, srcLinear > 0.5);
}
fn workingToStorage(rgb : vec3<f32>) -> vec3<f32> { return rgb; }
fn storageToWorking(rgb : vec3<f32>) -> vec3<f32> { return rgb; }


fn viewerSlice(rg : vec2<f32>, slice : f32, n : f32) -> vec3<f32> {
  let xIn = clamp(rg.x * (n - 1.0) + 0.5, 0.5, n - 0.5);
  let u = (slice * n + xIn) / (n * n);
  let v = clamp(rg.y * (n - 1.0) + 0.5, 0.5, n - 0.5) / n;
  return textureSampleLevel(lutTex, smp, vec2<f32>(u, v), 0.0).rgb;
}
@fragment
fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let c = unpremul(textureSample(tex, smp, uv)) * obj.tint;
  var rgb = workingToDisplay(c.rgb, obj.srcSpace);
  let signedSize = obj.cr0.x;
  let n = abs(signedSize);
  let intensity = clamp(obj.cr0.y, 0.0, 1.0);
  if (n >= 2.0 && intensity > 0.0001) {
    let lo = obj.cr0.z;
    let hi = obj.cr0.w;
    let span = max(hi - lo, 0.0001);
    let d = clamp((rgb - vec3<f32>(lo)) / span, vec3<f32>(0.0), vec3<f32>(1.0));
    var graded : vec3<f32>;
    if (signedSize < 0.0) {
      let w = n;
      let rr = textureSampleLevel(lutTex, smp, vec2<f32>((d.r * (w - 1.0) + 0.5) / w, 0.5), 0.0).r;
      let gg = textureSampleLevel(lutTex, smp, vec2<f32>((d.g * (w - 1.0) + 0.5) / w, 0.5), 0.0).g;
      let bb = textureSampleLevel(lutTex, smp, vec2<f32>((d.b * (w - 1.0) + 0.5) / w, 0.5), 0.0).b;
      graded = vec3<f32>(rr, gg, bb);
    } else {
      let bz = d.b * (n - 1.0);
      let z0 = floor(bz);
      let z1 = min(z0 + 1.0, n - 1.0);
      let f = bz - z0;
      graded = mix(viewerSlice(d.rg, z0, n), viewerSlice(d.rg, z1, n), f);
    }
    rgb = mix(rgb, graded, intensity);
  }
  // View ▸ Show Channel (RenderView.channel → cr1.x): 1–3 red / green / blue and
  // 4 alpha, each as an opaque grey image; 5 the colour without its alpha.
  let ch = obj.cr1.x;
  if (ch > 0.5) {
    if (ch > 4.5) { return vec4<f32>(rgb, 1.0); }
    var v = c.a;
    if (ch < 1.5) { v = rgb.r * c.a; } else if (ch < 2.5) { v = rgb.g * c.a; } else if (ch < 3.5) { v = rgb.b * c.a; }
    return vec4<f32>(v, v, v, 1.0);
  }
  return vec4<f32>(rgb * c.a, c.a);
}
