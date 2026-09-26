
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, params: vec4<f32>, dims: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
// Per-PIXEL integer hash — the same construction Dissolve uses, and for the
// same reason: fract(sin(x)·43758) amplifies the implementation-defined ULPs
// of sin() and of varying interpolation into a completely different grain per
// backend (the webgl2-vs-webgpu effect-noise divergence). Keys are the
// BUFFER-pixel index (dims = buffer size; pixel centres sit half a texel from
// any cell boundary, so interpolation jitter can never straddle one) plus the
// channel and quantized evolution; u32 maths is bit-exact on every driver.
fn rand(q: vec2<f32>, dims: vec2<f32>, key: u32) -> f32 {
  let px = u32(clamp(floor(q.x * dims.x), 0.0, 16777215.0));
  let py = u32(clamp(floor(q.y * dims.y), 0.0, 16777215.0));
  var h : u32 = (px + 1u) * 374761393u + (py + 1u) * 668265263u + (key + 1u) * 2246822519u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  h = h ^ (h >> 16u);
  return f32(h) / 4294967296.0;
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let c = textureSample(tex, smp, uv);
  if (c.a == 0.0) { return c; }
  let amount = obj.params.x;
  let evolution = obj.params.y;
  let monochrome = obj.params.z;
  // FIELD coordinate, not the sample coordinate: on WebGL2 the chain samples
  // its FBO with a flipped V (targetSampleUv), so uv.y runs the OPPOSITE way
  // per backend and any procedural use of it decorrelates the two engines.
  // Normalizing by uvRect recovers the quad's own top-down position, which is
  // identical on both.
  let q = (uv - obj.uvRect.xy) / obj.uvRect.zw;
  // Evolution re-seeds the whole field (quantized to its authored 0.01 step).
  let ek = u32(clamp(floor(evolution * 100.0 + 0.5) + 8388608.0, 0.0, 16777215.0));
  var rnd: vec3<f32>;
  if (monochrome > 0.5) {
    let r = rand(q, obj.dims.xy, ek * 4u) - 0.5;
    rnd = vec3<f32>(r);
  } else {
    rnd = vec3<f32>(
      rand(q, obj.dims.xy, ek * 4u) - 0.5,
      rand(q, obj.dims.xy, ek * 4u + 1u) - 0.5,
      rand(q, obj.dims.xy, ek * 4u + 2u) - 0.5
    );
  }
  // c.rgb is premultiplied; unpremultiply, add noise in straight-alpha space,
  // clamp, then re-premultiply so the output stays premultiplied.
  //
  // The guard is not cosmetic: a fully transparent pixel divides by zero, and
  // what that produces is DRIVER-DEPENDENT - NaN, Inf, or a flushed zero. NaN
  // survives the clamp on some hardware and NaN times 0.0 is still NaN, so the
  // premultiply cannot rescue it. Matches the gradient-ramp guard above.
  let straight = select(c.rgb / c.a, vec3<f32>(0.0), c.a == 0.0);
  let rgb = clamp(straight + rnd * amount, vec3<f32>(0.0), vec3<f32>(1.0));
  return vec4<f32>(rgb * c.a, c.a);
}
