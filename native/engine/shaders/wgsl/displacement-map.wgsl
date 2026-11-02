// Displacement Map (After Effects parity, stream D 2026-11-02): each texel of
// the layer (or, Source: Backdrop, of the scene under it, cut by the layer's
// alpha) is read from where a channel of the map says. Before this the map's
// R and G moved x and y by ±amount: that is the default row (Red / Green,
// Max = amount, map as placed in the comp, edges clamped, output expanded),
// bit for bit.
//   binding 1  the layer (the chain buffer)   binding 3  the map, drawn where it sits
//   binding 4  the backdrop (Source: Backdrop; else the layer again)
// p0 = (max horizontal, max vertical — in FIELD units, channel h, channel v)
// p1 = (map behaviour 0 as placed 1 centre 2 stretch 3 tile, edge 0 clamp 1 wrap
//       2 transparent, source 0 layer 1 backdrop, expand output)
// p2 = the map layer's box in field space (x, y, w, h); fxBox = the layer's.
// Channels: 0 red 1 green 2 blue 3 alpha 4 luminance 5 hue 6 lightness
// 7 saturation 8 full 9 half 10 off.
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, p0: vec4<f32>, p1: vec4<f32>, p2: vec4<f32>, p3: vec4<f32>, fxBox: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
@group(0) @binding(3) var mapTex : texture_2d<f32>;
@group(0) @binding(4) var backTex : texture_2d<f32>;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
fn hsl(c : vec3<f32>) -> vec3<f32> {
  let mx = max(c.r, max(c.g, c.b)); let mn = min(c.r, min(c.g, c.b));
  let l = (mx + mn) * 0.5;
  if (mx - mn < 0.00001) { return vec3<f32>(0.0, 0.0, l); }
  let d = mx - mn;
  let s = select(d / (mx + mn), d / (2.0 - mx - mn), l > 0.5);
  var h = 0.0;
  if (mx == c.r) { h = (c.g - c.b) / d + select(0.0, 6.0, c.g < c.b); }
  else if (mx == c.g) { h = (c.b - c.r) / d + 2.0; }
  else { h = (c.r - c.g) / d + 4.0; }
  return vec3<f32>(h / 6.0, s, l);
}
// The channel's value 0..1 (0.5 = no move). Red / green / blue / alpha are the
// map's own texels (the original rows); the derived ones read its straight colour.
fn channel(m : vec4<f32>, k : i32) -> f32 {
  switch (k) {
    case 0: { return m.r; }
    case 1: { return m.g; }
    case 2: { return m.b; }
    case 3: { return m.a; }
    case 8: { return 1.0; }
    case 9: { return 0.5; }
    case 10: { return 0.5; }
    default: {
      let c = select(vec3<f32>(0.0), m.rgb / m.a, m.a > 0.00001);
      if (k == 4) { return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722)); }
      let h = hsl(clamp(c, vec3<f32>(0.0), vec3<f32>(1.0)));
      if (k == 5) { return h.x; }
      if (k == 6) { return h.z; }
      return h.y;
    }
  }
}
fn sampleAt(q : vec2<f32>) -> vec2<f32> { return obj.uvRect.xy + q * obj.uvRect.zw; }
fn inRect(q : vec2<f32>, r : vec4<f32>) -> bool {
  return q.x >= r.x && q.y >= r.y && q.x <= r.x + r.z && q.y <= r.y + r.w;
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  // Displace in FIELD space: d.y is authored down-positive (top-down), but
  // uv's V runs the opposite way per backend on FBO round-trips
  // (targetSampleUv) — adding d to uv flipped vertical displacement on WebGL2.
  // No early-outs: WGSL wants every textureSample in uniform control flow
  // (glass-composite.wgsl has the story), so visibility is a multiplier.
  let q = (uv - obj.uvRect.xy) / obj.uvRect.zw;
  let box = obj.fxBox;
  let mapBox = obj.p2;
  let expand = obj.p1.w > 0.5;
  var vis = select(0.0, 1.0, expand || inRect(q, box));
  // Where the map is read for this texel.
  var mq = q;
  let mode = i32(obj.p1.x);
  if (mode == 1) {
    mq = q - (box.xy + box.zw * 0.5) + (mapBox.xy + mapBox.zw * 0.5);
  } else if (mode == 2) {
    mq = mapBox.xy + (q - box.xy) / max(box.zw, vec2<f32>(0.000001)) * mapBox.zw;
  } else if (mode == 3) {
    mq = mapBox.xy + fract((q - box.xy) / max(mapBox.zw, vec2<f32>(0.000001))) * mapBox.zw;
  }
  let mapC = textureSample(mapTex, smp, sampleAt(mq));
  let hk = i32(obj.p0.z);
  let vk = i32(obj.p0.w);
  var d = (vec2<f32>(channel(mapC, hk), channel(mapC, vk)) - 0.5) * 2.0 * obj.p0.xy;
  if (hk == 10) { d.x = 0.0; }
  if (vk == 10) { d.y = 0.0; }
  var s = q + d;
  let edge = i32(obj.p1.y);
  if (edge == 1) {
    s = box.xy + fract((s - box.xy) / max(box.zw, vec2<f32>(0.000001))) * box.zw;
  } else if (edge == 2) {
    vis = vis * select(0.0, 1.0, inRect(s, box));
  } else {
    s = clamp(s, vec2<f32>(0.0), vec2<f32>(1.0));
  }
  let moved = textureSample(tex, smp, sampleAt(s));
  let back = textureSample(backTex, smp, sampleAt(s));
  let a = textureSample(tex, smp, uv).a;
  // Source: Backdrop — the scene under the layer, moved by the map, cut by the layer's silhouette.
  let out = select(moved, back * a, obj.p1.z > 0.5);
  return out * vis;
}
