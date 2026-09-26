
struct Object {
  mvp : mat3x3<f32>,
  color : vec4<f32>,
  shape : vec4<f32>,
};
@group(0) @binding(0) var<uniform> obj : Object;

struct VOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) local : vec2<f32>,
};

@vertex
fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut;
  let p = obj.mvp * vec3<f32>(pos, 1.0);
  o.pos = vec4<f32>(p.xy, 0.0, p.z);
  o.local = pos;
  return o;
}

fn shapeAlpha(local : vec2<f32>) -> f32 {
  let kind = i32(obj.shape.x + 0.5);
  if (kind == 2) {
    let p = (local - vec2<f32>(0.5)) * 2.0;
    let d = length(p) - 1.0;
    let aa = fwidth(d) + 1e-6;
    return 1.0 - smoothstep(-aa, aa, d);
  }
  if (kind == 1) {
    let r = obj.shape.y;
    let sz = obj.shape.zw;
    let p = (local - vec2<f32>(0.5)) * sz;
    let b = sz * 0.5 - r;
    let q = abs(p) - b;
    let d = length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - r;
    let aa = fwidth(d) + 1e-6;
    return 1.0 - smoothstep(-aa, aa, d);
  }
  return 1.0;
}

@fragment
fn fs(@location(0) local : vec2<f32>) -> @location(0) vec4<f32> {
  let a = obj.color.a * shapeAlpha(local);
  return vec4<f32>(obj.color.rgb * a, a);
}
