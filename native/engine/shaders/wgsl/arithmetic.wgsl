
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, p0: vec4<f32>, p1: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
fn bits(x : f32) -> u32 { return u32(clamp(x, 0.0, 1.0) * 255.0 + 0.5); }
fn unbits(x : u32) -> f32 { return f32(x) / 255.0; }
fn arith(c : f32, v : f32, op : f32) -> f32 {
  if (op < 0.5)  { return c + v; }                       // Add
  if (op < 1.5)  { return c - v; }                       // Subtract
  if (op < 2.5)  { return c * v; }                       // Multiply
  if (op < 3.5)  { return abs(c - v); }                  // Difference
  if (op < 4.5)  { return max(c, v); }                   // Max
  if (op < 5.5)  { return min(c, v); }                   // Min
  if (op < 6.5)  { return select(c, 0.0, c > v); }       // Block Above
  if (op < 7.5)  { return select(c, 0.0, c < v); }       // Block Below
  if (op < 8.5)  { return unbits(bits(c) & bits(v)); }   // And
  if (op < 9.5)  { return unbits(bits(c) | bits(v)); }   // Or
  return unbits(bits(c) ^ bits(v));                      // Xor
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let op = obj.p0.x;
  let v = obj.p0.yzw;
  let clipResult = obj.p1.x;

  let src = textureSample(tex, smp, uv);
  // Straight colour: the operators describe COLOUR, not coverage.
  let a = max(src.a, 0.00001);
  let c = select(src.rgb / a, vec3<f32>(0.0, 0.0, 0.0), src.a <= 0.0);

  var outC = vec3<f32>(arith(c.r, v.x, op), arith(c.g, v.y, op), arith(c.b, v.z, op));
  // Clipping OFF keeps out-of-range results, which is what lets Add then
  // Subtract round-trip; ON is AE's default and matches 8-bpc behaviour.
  outC = select(outC, clamp(outC, vec3<f32>(0.0), vec3<f32>(1.0)), clipResult > 0.5);
  return vec4<f32>(outC * src.a, src.a);
}
