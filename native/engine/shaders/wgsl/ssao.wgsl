
struct Object {
  mvp : mat3x3<f32>,
  uvRect : vec4<f32>,
  params : vec4<f32>,
  params2 : vec4<f32>,
  proj : mat4x4<f32>,
};
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
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

// Field coordinate -> texture coordinate. uvRect carries the backend's V
// orientation, so going through it is what makes one piece of arithmetic
// correct on a bottom-up and a top-down render target alike.
fn texUvOf(q : vec2<f32>) -> vec2<f32> { return obj.uvRect.xy + q * obj.uvRect.zw; }
fn rawDepthAt(q : vec2<f32>) -> f32 {
  return unpackLinear(textureSampleLevel(tex, smp, texUvOf(q), 0.0));
}
/*
  Field coordinate -> camera space, at a known linear depth.

  obj.proj is camera space -> CLIP, so this is its inverse restricted to the
  plane z = depth -- solved rather than inverted, because the only unknowns are
  x and y and the 2x2 system for them is exact:

    clip.x = K00*x + K10*y + K20*z + K30      ndc.x = clip.x / w
    clip.y = K01*x + K11*y + K21*z + K31      ndc.y = clip.y / w
    w      = K23*z + K33

  which covers BOTH camera families this app has without a branch: a
  perspective projection leaves w = z (K23 = 1, K33 = 0) and an ortho one
  leaves w = 1 (K23 = 0, K33 = 1).
*/
fn viewPosOf(q : vec2<f32>, z : f32) -> vec3<f32> {
  let ndc = vec2<f32>(q.x * 2.0 - 1.0, 1.0 - q.y * 2.0);
  let K = obj.proj;
  let w = K[2].w * z + K[3].w;
  let rx = ndc.x * w - K[2].x * z - K[3].x;
  let ry = ndc.y * w - K[2].y * z - K[3].y;
  let det0 = K[0].x * K[1].y - K[1].x * K[0].y;
  let det = select(det0, 1e-6, abs(det0) < 1e-12);
  return vec3<f32>(
    (K[1].y * rx - K[1].x * ry) / det,
    (K[0].x * ry - K[0].y * rx) / det,
    z,
  );
}
// Camera space -> field coordinate, plus the clip w so a sample behind the
// camera can be rejected instead of wrapping to the far side of the screen.
fn projectQ(p : vec3<f32>) -> vec3<f32> {
  let c = obj.proj * vec4<f32>(p, 1.0);
  let iw = 1.0 / max(c.w, 1e-6);
  return vec3<f32>(c.x * iw * 0.5 + 0.5, 0.5 - c.y * iw * 0.5, c.w);
}
// The Dissolve hash -- u32 only, so every driver agrees bit for bit.
fn aoHash(px : u32, py : u32, key : u32) -> f32 {
  var h = (px + 1u) * 374761393u + (py + 1u) * 668265263u + (key + 1u) * 2246822519u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  h = h ^ (h >> 16u);
  return f32(h) / 4294967296.0;
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let q = (uv - obj.uvRect.xy) / obj.uvRect.zw;
  let raw = rawDepthAt(q);
  // The prepass clears to WHITE, which decodes just short of 1 -- "no geometry
  // here". Answering UNOCCLUDED there is what keeps the background clean.
  if (raw > 0.9995) { return vec4<f32>(1.0, 1.0, 1.0, 1.0); }
  let far = obj.params.z;
  let z = raw * far;
  let P = viewPosOf(q, z);
  let dq = vec2<f32>(1.0 / max(obj.params2.x, 1.0), 1.0 / max(obj.params2.y, 1.0));
  // Normal from the NEARER neighbour on each axis, not from a plain central
  // difference: across a silhouette the far neighbour belongs to another
  // surface, and averaging the two tilts the normal into the gap -- which is
  // exactly where AO is most visible.
  let zR = rawDepthAt(q + vec2<f32>(dq.x, 0.0)) * far;
  let zL = rawDepthAt(q - vec2<f32>(dq.x, 0.0)) * far;
  let zD = rawDepthAt(q + vec2<f32>(0.0, dq.y)) * far;
  let zU = rawDepthAt(q - vec2<f32>(0.0, dq.y)) * far;
  var dpx = viewPosOf(q + vec2<f32>(dq.x, 0.0), zR) - P;
  if (abs(zL - z) < abs(zR - z)) { dpx = P - viewPosOf(q - vec2<f32>(dq.x, 0.0), zL); }
  var dpy = viewPosOf(q + vec2<f32>(0.0, dq.y), zD) - P;
  if (abs(zU - z) < abs(zD - z)) { dpy = P - viewPosOf(q - vec2<f32>(0.0, dq.y), zU); }
  let cr = cross(dpy, dpx);
  if (dot(cr, cr) < 1e-12) { return vec4<f32>(1.0, 1.0, 1.0, 1.0); }
  // cross(dpy, dpx) faces the camera: camera space is +x right, +y DOWN and
  // +z away, so a plane facing the viewer gives -z from this order.
  let N = normalize(cr);
  // The rotation is keyed on the buffer pixel MOD 4, which is what makes the
  // noise pattern four texels wide and the 4x4 blur an exact cancellation.
  let px = u32(clamp(floor(q.x * obj.params2.x), 0.0, 16777215.0)) % 4u;
  let py = u32(clamp(floor(q.y * obj.params2.y), 0.0, 16777215.0)) % 4u;
  let rot = aoHash(px, py, 0u) * 6.2831853;
  // A tangent basis; which tangent is chosen does not matter, only that it is
  // perpendicular to N -- the kernel is rotationally symmetric about it.
  let upv = select(vec3<f32>(0.0, 0.0, 1.0), vec3<f32>(1.0, 0.0, 0.0), abs(N.z) > 0.9);
  let T = normalize(cross(upv, N));
  let B = cross(N, T);
  let n = max(1.0, obj.params2.z);
  let radius = obj.params.x;
  var occ = 0.0;
  for (var i = 0; i < 16; i = i + 1) {
    if (f32(i) >= n) { break; }
    let fi = f32(i);
    let u = (fi + 0.5) / n;
    // Cosine-weighted hemisphere by the concentric-disk identity: radius
    // sqrt(u) on the disk, height sqrt(1-u) above it.
    let a = fi * 2.3999632 + rot;
    let rr = sqrt(u);
    let dir = T * (rr * cos(a)) + B * (rr * sin(a)) + N * sqrt(max(0.0, 1.0 - u));
    // Samples crowd toward the origin, so contact darkening reads as CONTACT
    // rather than as a uniform haze out at the radius.
    let sp = P + dir * (radius * mix(0.25, 1.0, u * u));
    let sq = projectQ(sp);
    if (sq.z <= 1e-6 || sq.x < 0.0 || sq.x > 1.0 || sq.y < 0.0 || sq.y > 1.0) { continue; }
    let sceneRaw = rawDepthAt(sq.xy);
    if (sceneRaw > 0.9995) { continue; }
    let sceneZ = sceneRaw * far;
    // Range check: an occluder far in FRONT of this fragment is a different
    // object, not a crevice wall, and counting it is what smears AO haloes
    // around every silhouette.
    let range = smoothstep(0.0, 1.0, radius / max(abs(z - sceneZ), 1e-4));
    if (sceneZ <= sp.z - obj.params.w) { occ = occ + range; }
  }
  let ao = clamp(1.0 - (occ / n) * obj.params.y, 0.0, 1.0);
  return vec4<f32>(ao, ao, ao, 1.0);
}
