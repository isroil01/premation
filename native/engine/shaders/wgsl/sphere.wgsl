
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, p0: vec4<f32>, p1: vec4<f32>, fxBox: vec4<f32>, lightColor: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let radius = max(obj.p0.x, 0.0001);
  let rotX = obj.p0.y;
  let rotY = obj.p0.z;
  let shading = obj.p0.w;
  let aspect = max(obj.p1.x, 0.0001);
  let rotZ = obj.p1.y;

  // ASPECT-CORRECTED, or the sphere is an ellipse on a non-square layer: raw
  // UV compresses x by w/h, so the silhouette test below describes an oval.
  // Distances are taken in units of the layer's SHORT side, so a radius of 1
  // touches the nearer pair of edges whatever the layer's shape.
  // Field coordinate: fxBox is authored top-down; uv's V is backend-
  // dependent on FBO round-trips (targetSampleUv).
  let fq = (uv - obj.uvRect.xy) / obj.uvRect.zw;
  let l = (fq - obj.fxBox.xy) / max(obj.fxBox.zw, vec2<f32>(0.000001, 0.000001));
  let scale = vec2<f32>(max(aspect, 1.0), max(1.0 / aspect, 1.0));
  var p = (l - vec2<f32>(0.5, 0.5)) * 2.0 * scale / radius;
  // Rotation about the viewing axis spins the map in the plane of the screen —
  // AE's third rotation, which this shader shipped without.
  let cz = cos(-rotZ); let sz = sin(-rotZ);
  p = vec2<f32>(p.x * cz - p.y * sz, p.x * sz + p.y * cz);
  let r2 = dot(p, p);
  // Off the silhouette there is no surface, so nothing is drawn. Clamping
  // instead would smear the limb pixels across the rest of the frame.
  if (r2 > 1.0) { return vec4<f32>(0.0, 0.0, 0.0, 0.0); }
  let z = sqrt(1.0 - r2);

  // Inverse-rotate the normal: about X first, then Y, undoing the forward order.
  let cx = cos(-rotX); let sx = sin(-rotX);
  let y1 = p.y * cx - z * sx;
  let z1 = p.y * sx + z * cx;
  let cy = cos(-rotY); let sy = sin(-rotY);
  let x2 = p.x * cy + z1 * sy;
  let z2 = -p.x * sy + z1 * cy;

  // Equirectangular: longitude from atan2, latitude from asin.
  let su = fract(0.5 + atan2(x2, z2) * 0.15915494);           // ÷2π
  let sv = clamp(0.5 - asin(clamp(y1, -1.0, 1.0)) * 0.31830989, 0.0, 1.0); // ÷π
  // textureSampleLEVEL: the silhouette test above is an early return, so this
  // is non-uniform control flow and the derivative-computing form is invalid
  // WGSL. See the note in compound-blur.
  let c = textureSampleLevel(tex, smp, obj.uvRect.xy + vec2<f32>(su, sv) * obj.uvRect.zw, 0.0);
  // shading at 0 is a flat unlit map; at 1 the limb falls fully dark.
  let lam = mix(1.0, z, shading);
  return vec4<f32>(c.rgb * obj.lightColor.rgb * lam, c.a);
}
