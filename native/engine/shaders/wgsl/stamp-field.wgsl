// E4: Plexus and Write-on's brush dabs. The data texture (binding 3) is one
// float32 per RGBA8 texel, row width 1024, same packing as vegas-gpu.wgsl.
// Header: triCount, lineCount, pointCount, layer width, layer height, line
// width, 0, 0. Then triangles (12 floats: x0 y0 x1 y1 x2 y2 r g b a 0 0),
// lines (8: x0 y0 x1 y1 r g b a) and points (8: x y radius hardness r g b a).
// One instance per primitive, a unit quad grown into a capsule, a disc or the
// triangle's box. Fragments write premultiplied working-space colour; the
// chain blends them onto the layer.
struct Object { mvp : mat3x3<f32>, uvRect : vec4<f32>, color : vec4<f32>, p0 : vec4<f32>, p1 : vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
@group(0) @binding(3) var data : texture_2d<f32>;

const ROW : u32 = 1024u;
const HEADER : u32 = 8u;

fn fetch(i : u32) -> f32 {
  let t = textureLoad(data, vec2<i32>(i32(i % ROW), i32(i / ROW)), 0);
  let b = vec4<u32>(round(t * 255.0));
  return bitcast<f32>(b.x | (b.y << 8u) | (b.z << 16u) | (b.w << 24u));
}

struct VOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) px : vec2<f32>,
  @location(1) @interpolate(flat) kind : f32,
  @location(2) @interpolate(flat) a : vec2<f32>,
  @location(3) @interpolate(flat) b : vec2<f32>,
  @location(4) @interpolate(flat) c : vec2<f32>,
  @location(5) @interpolate(flat) shape : vec4<f32>,
  @location(6) @interpolate(flat) rgba : vec4<f32>,
};

fn place(p : vec2<f32>, size : vec2<f32>) -> vec4<f32> {
  let uv = p / size;
  let local = (uv - obj.uvRect.xy) / obj.uvRect.zw;
  return vec4<f32>((obj.mvp * vec3<f32>(local, 1.0)).xy, 0.0, 1.0);
}

@vertex fn vs(@location(0) pos : vec2<f32>, @builtin(instance_index) inst : u32) -> VOut {
  var o : VOut;
  let tris = u32(fetch(0u));
  let lines = u32(fetch(1u));
  let points = u32(fetch(2u));
  let size = vec2<f32>(fetch(3u), fetch(4u));
  let lineW = fetch(5u);
  if (inst >= tris + lines + points) {
    o.pos = vec4<f32>(2.0, 2.0, 0.0, 1.0);
    return o;
  }
  if (inst < tris) {
    let base = HEADER + inst * 12u;
    let a = vec2<f32>(fetch(base), fetch(base + 1u));
    let b = vec2<f32>(fetch(base + 2u), fetch(base + 3u));
    let c = vec2<f32>(fetch(base + 4u), fetch(base + 5u));
    let mn = min(a, min(b, c)) - vec2<f32>(1.0);
    let mx = max(a, max(b, c)) + vec2<f32>(1.0);
    let p = mix(mn, mx, pos);
    o.pos = place(p, size);
    o.px = p;
    o.kind = 2.0;
    o.a = a;
    o.b = b;
    o.c = c;
    o.rgba = vec4<f32>(fetch(base + 6u), fetch(base + 7u), fetch(base + 8u), fetch(base + 9u));
    return o;
  }
  if (inst < tris + lines) {
    let base = HEADER + tris * 12u + (inst - tris) * 8u;
    let a = vec2<f32>(fetch(base), fetch(base + 1u));
    let b = vec2<f32>(fetch(base + 2u), fetch(base + 3u));
    let halfW = max(lineW, 0.0) * 0.5;
    let reach = halfW + 1.5;
    var dir = b - a;
    let len = length(dir);
    dir = select(vec2<f32>(1.0, 0.0), dir / max(len, 1e-6), len > 1e-6);
    let nrm = vec2<f32>(-dir.y, dir.x);
    let along = mix(-reach, len + reach, pos.x);
    let across = mix(-reach, reach, pos.y);
    let p = a + dir * along + nrm * across;
    o.pos = place(p, size);
    o.px = p;
    o.kind = 1.0;
    o.a = a;
    o.b = b;
    o.shape = vec4<f32>(halfW, 0.0, 0.0, 0.0);
    o.rgba = vec4<f32>(fetch(base + 4u), fetch(base + 5u), fetch(base + 6u), fetch(base + 7u));
    return o;
  }
  let base = HEADER + tris * 12u + lines * 8u + (inst - tris - lines) * 8u;
  let center = vec2<f32>(fetch(base), fetch(base + 1u));
  let radius = fetch(base + 2u);
  let reach = radius + 1.5;
  let p = center + (pos * 2.0 - vec2<f32>(1.0)) * reach;
  o.pos = place(p, size);
  o.px = p;
  o.kind = 0.0;
  o.a = center;
  o.shape = vec4<f32>(radius, fetch(base + 3u), 0.0, 0.0);
  o.rgba = vec4<f32>(fetch(base + 4u), fetch(base + 5u), fetch(base + 6u), fetch(base + 7u));
  return o;
}

fn coverage(d : f32, radius : f32, hardness : f32) -> f32 {
  if (d >= radius + 0.5) { return 0.0; }
  let inner = clamp(hardness, 0.0, 1.0) * radius;
  let soft = radius - inner;
  if (soft < 1.0) { return clamp(radius + 0.5 - d, 0.0, 1.0); }
  if (d <= inner) { return 1.0; }
  if (d >= radius) { return 0.0; }
  let t = (d - inner) / soft;
  return 1.0 - t * t * (3.0 - 2.0 * t);
}

@fragment fn fs(v : VOut) -> @location(0) vec4<f32> {
  var cov = 0.0;
  if (v.kind < 0.5) {
    cov = coverage(distance(v.px, v.a), max(v.shape.x, 0.25), v.shape.y);
  } else if (v.kind < 1.5) {
    let ab = v.b - v.a;
    let len2 = max(dot(ab, ab), 1e-12);
    let t = clamp(dot(v.px - v.a, ab) / len2, 0.0, 1.0);
    let q = v.a + ab * t;
    cov = clamp(v.shape.x - distance(v.px, q) + 0.5, 0.0, 1.0);
  } else {
    let e0 = (v.px.x - v.a.x) * (v.b.y - v.a.y) - (v.px.y - v.a.y) * (v.b.x - v.a.x);
    let e1 = (v.px.x - v.b.x) * (v.c.y - v.b.y) - (v.px.y - v.b.y) * (v.c.x - v.b.x);
    let e2 = (v.px.x - v.c.x) * (v.a.y - v.c.y) - (v.px.y - v.c.y) * (v.a.x - v.c.x);
    let inside = (e0 >= 0.0 && e1 >= 0.0 && e2 >= 0.0) || (e0 <= 0.0 && e1 <= 0.0 && e2 <= 0.0);
    cov = select(0.0, 1.0, inside);
  }
  // `tex` stays in the material layout (binding 1), matching the other effect passes.
  let a = cov * v.rgba.a + textureSample(tex, smp, vec2<f32>(0.5)).a * 0.0;
  if (a <= 0.0) { discard; }
  return vec4<f32>(v.rgba.rgb * a, a);
}
