// Refraction (docs/PROGRAM_DEEP_EFFECTS.md #10): normals from the smoothed
// height (tex1), the view ray refracted per wavelength (six samples across the
// spectrum, each at its own index: dispersion), reading the (frosted) picture
// (tex2); a Phong highlight on top. Alpha follows the refracted sample.
// p0 = (depth px, index, dispersion, specular), p1 = (light dir xyz, shininess),
// p2.x = 1: the picture is the scene under the layer (stream D Source: Backdrop)
// and the result is cut by the layer's own alpha (tex0).
fn hAt(uv : vec2<f32>) -> f32 { return at1(uv).r; }
fn spectrum(t : f32) -> vec3<f32> {
  return clamp(vec3<f32>(1.5 - abs(t * 3.0 - 0.0), 1.5 - abs(t * 3.0 - 1.5), 1.5 - abs(t * 3.0 - 3.0)), vec3<f32>(0.0), vec3<f32>(1.0));
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let e = dpxUv(vec2<f32>(1.0, 1.0));
  let h = hAt(uv);
  let dx = (hAt(uv + vec2<f32>(e.x, 0.0)) - hAt(uv - vec2<f32>(e.x, 0.0))) * 0.5;
  let dy = (hAt(uv + vec2<f32>(0.0, e.y)) - hAt(uv - vec2<f32>(0.0, e.y))) * 0.5;
  let depth = P(0).x;
  let n = normalize(vec3<f32>(-dx * depth, -dy * depth, 1.0));
  let iv = vec3<f32>(0.0, 0.0, -1.0);
  var acc = vec4<f32>(0.0);
  var wsum = vec3<f32>(0.0);
  for (var k = 0; k < 6; k++) {
    let t = (f32(k) + 0.5) / 6.0;
    let ior = max(P(0).y + P(0).z * 0.06 * (t - 0.5), 1.0);
    let tr = refract(iv, n, 1.0 / ior);
    let off = tr.xy / max(-tr.z, 0.2) * depth * (0.25 + h);
    let s = at2(uv + dpxUv(off));
    let w = spectrum(t);
    acc += vec4<f32>(s.rgb * w, s.a * (w.r + w.g + w.b) / 3.0);
    wsum += w;
  }
  var res = vec4<f32>(acc.rgb / max(wsum, vec3<f32>(0.0001)), acc.a / max((wsum.r + wsum.g + wsum.b) / 3.0, 0.0001));
  let l = normalize(P(1).xyz);
  let r = reflect(-l, n);
  let spec = pow(max(r.z, 0.0), P(1).w) * P(0).w * clamp(length(vec2<f32>(dx, dy)) * depth * 0.5 + 0.15, 0.0, 1.0);
  res = vec4<f32>(res.rgb + vec3<f32>(spec) * res.a, res.a);
  if (P(2).x > 0.5) { res = res * at0(uv).a; }
  return res;
}
