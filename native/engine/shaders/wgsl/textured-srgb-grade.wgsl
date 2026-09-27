// E4 GPU route: a colour-matrix grade (the CSS colour filters, Tint, Channel
// Mixer) applied the way the CPU bake the TypeScript runs applies it — to the
// straight, sRGB-ENCODED colour, clamped to [0, 1] (effectColorMatrix.ts /
// the canvas filter), then decoded back into the linear working space.
// Same uniform block as textured-linear (pack_textured).
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

struct VOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

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
fn acesCgToLinearSrgb(c : vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    dot(c, vec3<f32>(1.6410233797, -0.3248032942, -0.2364246952)),
    dot(c, vec3<f32>(-0.6636628587, 1.6153315917, 0.0167563477)),
    dot(c, vec3<f32>(0.0117218943, -0.0082844420, 0.9883948585)),
  );
}

@fragment
fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let c = unpremul(textureSample(tex, smp, uv)) * obj.tint;
  var lin = c.rgb;
  if (obj.srcSpace.y > 0.5) { lin = acesCgToLinearSrgb(lin); }
  let s = linearToSrgbRgb(clamp(lin, vec3<f32>(0.0), vec3<f32>(1.0)));
  let v = vec4<f32>(s, 1.0);
  let graded = clamp(vec3<f32>(dot(obj.cr0, v), dot(obj.cr1, v), dot(obj.cr2, v)), vec3<f32>(0.0), vec3<f32>(1.0));
  var outRgb = srgbToLinearRgb(graded);
  if (obj.srcSpace.y > 0.5) { outRgb = linearSrgbToAcesCg(outRgb); }
  return vec4<f32>(outRgb * c.a, c.a);
}
