struct Object {
  mvp : mat3x3<f32>,
  color : vec4<f32>,
  shape : vec4<f32>,
  edge : vec4<f32>,
};
@group(0) @binding(0) var<uniform> obj : Object;

struct VOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) local : vec2<f32>,
};

@vertex
fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut;
  // Grown by edge.xy each side (uniforms.hpp LayerEdge) so the antialiased
  // fringe outside the box — a circle's tangent points, a rotated edge — is drawn.
  let local = mix(-obj.edge.xy, vec2<f32>(1.0) + obj.edge.xy, pos);
  let p = obj.mvp * vec3<f32>(local, 1.0);
  o.pos = vec4<f32>(p.xy, 0.0, p.z);
  o.local = local;
  return o;
}

/// One-pixel box-filter coverage of a signed distance `d` (inside < 0), in
/// device pixels from its screen gradient: exact under rotation and squash,
/// where fwidth's |dx| + |dy| widened diagonal edges by up to √2.
fn coverage(d : f32) -> f32 {
  let g = max(length(vec2<f32>(dpdx(d), dpdy(d))), 1e-8);
  return clamp(0.5 - d / g, 0.0, 1.0);
}

/// The plain rect's coverage: the pixel's area inside the unit quad (textured.wgsl edgeCoverage).
fn edgeCoverage(local : vec2<f32>) -> f32 {
  let gx = max(length(vec2<f32>(dpdx(local.x), dpdy(local.x))), 1e-8);
  let gy = max(length(vec2<f32>(dpdx(local.y), dpdy(local.y))), 1e-8);
  let cx = clamp(local.x / gx + 0.5, 0.0, 1.0) + clamp((1.0 - local.x) / gx + 0.5, 0.0, 1.0) - 1.0;
  let cy = clamp(local.y / gy + 0.5, 0.0, 1.0) + clamp((1.0 - local.y) / gy + 0.5, 0.0, 1.0) - 1.0;
  return max(cx, 0.0) * max(cy, 0.0);
}

fn shapeAlpha(local : vec2<f32>) -> f32 {
  let kind = i32(obj.shape.x + 0.5);
  if (kind == 2) {
    let p = (local - vec2<f32>(0.5)) * 2.0;
    return coverage(length(p) - 1.0);
  }
  if (kind == 1) {
    let r = obj.shape.y;
    let sz = obj.shape.zw;
    let p = (local - vec2<f32>(0.5)) * sz;
    let b = sz * 0.5 - r;
    let q = abs(p) - b;
    let d = length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - r;
    // The distance's screen gradient along its own normal, from p's (smooth)
    // derivatives. Differencing d itself across a 2×2 pixel quad that straddles
    // the max() at a sharp corner's diagonal measured |∇d| ≈ √2, and the corner
    // pixels of every square rect — a comp-sized solid's included — came out
    // ~85 % covered (a grey corner, visible in gamma blending).
    let outside = max(q, vec2<f32>(0.0));
    var n = select(vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), q.x > q.y);
    if (outside.x > 0.0 || outside.y > 0.0) { n = normalize(outside); }
    n = n * select(vec2<f32>(-1.0), vec2<f32>(1.0), p >= vec2<f32>(0.0));
    let gd = vec2<f32>(dot(n, dpdx(p)), dot(n, dpdy(p)));
    return clamp(0.5 - d / max(length(gd), 1e-8), 0.0, 1.0);
  }
  // A plain rect is its box: covered by the layer edge when that is on.
  return select(1.0, edgeCoverage(local), obj.edge.z > 0.5);
}

@fragment
fn fs(@location(0) local : vec2<f32>) -> @location(0) vec4<f32> {
  let a = obj.color.a * shapeAlpha(local);
  return vec4<f32>(obj.color.rgb * a, a);
}
