
struct Object {
  mvp : mat3x3<f32>,
  uvRect : vec4<f32>,
  params : vec4<f32>,
};
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
@group(0) @binding(3) var depthTex : texture_2d<f32>;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut;
  let p = obj.mvp * vec3<f32>(pos, 1.0);
  o.pos = vec4<f32>(p.xy, 0.0, p.z);
  o.uv = obj.uvRect.xy + pos * obj.uvRect.zw;
  return o;
}

fn unpackLinear(c : vec4<f32>) -> f32 {
  return dot(c.rgb, vec3<f32>(1.0, 1.0 / 255.0, 1.0 / 65025.0));
}

fn texUvOf(q : vec2<f32>) -> vec2<f32> { return obj.uvRect.xy + q * obj.uvRect.zw; }
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let q = (uv - obj.uvRect.xy) / obj.uvRect.zw;
  let far = obj.params.z;
  let z0 = unpackLinear(textureSampleLevel(depthTex, smp, texUvOf(q), 0.0)) * far;
  var acc = 0.0;
  var wsum = 0.0;
  // -2..+1: four consecutive texels, exactly one period of the rotation tile.
  for (var y = -2; y <= 1; y = y + 1) {
    for (var x = -2; x <= 1; x = x + 1) {
      let sq = q + vec2<f32>(f32(x) * obj.params.x, f32(y) * obj.params.y);
      let suv = texUvOf(sq);
      let z = unpackLinear(textureSampleLevel(depthTex, smp, suv, 0.0)) * far;
      // Bilateral: a neighbour on another surface contributes nothing, which
      // is what stops the AO under an object leaking onto what is behind it.
      let w = max(0.0, 1.0 - abs(z - z0) / max(obj.params.w, 1e-4));
      acc = acc + textureSampleLevel(tex, smp, suv, 0.0).r * w;
      wsum = wsum + w;
    }
  }
  // Every neighbour rejected leaves the centre tap, never a divide by zero.
  let ao = select(textureSampleLevel(tex, smp, uv, 0.0).r, acc / wsum, wsum > 1e-4);
  return vec4<f32>(ao, ao, ao, 1.0);
}
