// E4 (fx_distance.cpp): one jump-flood step of p0.x texels over both offsets
// (nearest inside in rg, nearest outside in ba).
struct Object { mvp : mat3x3<f32>, uvRect : vec4<f32>, p0 : vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
@fragment fn fs(v : VOut) -> @location(0) vec4<f32> {
  let dims = vec2<i32>(textureDimensions(tex));
  let p = vec2<i32>(v.pos.xy);
  let s = i32(obj.p0.x);
  let own = textureLoad(tex, p, 0);
  var bestIn = own.xy;
  var bestOut = own.zw;
  var dIn = dot(bestIn, bestIn);
  var dOut = dot(bestOut, bestOut);
  for (var j = -1; j <= 1; j = j + 1) {
    for (var i = -1; i <= 1; i = i + 1) {
      if (i == 0 && j == 0) { continue; }
      let q = p + vec2<i32>(i, j) * s;
      if (q.x < 0 || q.y < 0 || q.x >= dims.x || q.y >= dims.y) { continue; }
      let n = textureLoad(tex, q, 0);
      // The neighbour's offset is to ITS nearest seed: seen from p, add (q - p).
      let off = vec2<f32>(f32(i * s), f32(j * s));
      let ci = n.xy + off;
      let di = dot(ci, ci);
      if (di < dIn) { dIn = di; bestIn = ci; }
      let co = n.zw + off;
      let dc = dot(co, co);
      if (dc < dOut) { dOut = dc; bestOut = co; }
    }
  }
  return vec4<f32>(bestIn, bestOut);
}
