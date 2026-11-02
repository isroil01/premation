// Object Matte (After Effects' Object Matte card): the layer cut by its stored
// per-frame Object Matte, refined live. tex0 = the input (the footage, whole),
// tex1 = the refined matte (fxx-selcol-matte: shifted by its distance field,
// then feathered; every channel), tex2 = the stored matte itself (stream B1:
// coverage in every channel — the footage keeps its own colour).
// p0 = (contrast 0..1, invert, decontaminate 0..1, 0).
// Contrast steepens the soft edge about its 1/2-contour (100 % = slope 5);
// Invert keeps the background. Decontaminate unmixes the edge's colour: the
// footage at a soft-edge pixel is m·F + (1−m)·B (F the subject, B what was
// behind it); B is estimated from the footage around the pixel where the
// stored matte is clear, and F = (f − (1−m)·B) / m replaces f by the amount —
// so a wall's colour does not ring the subject when it is cut out. The
// propagation controls (Quality, Edge Radius, Motion Blur, Reduce Chatter,
// Render Refine Edge) were baked into the frames. No frame: the chain keeps
// its input.
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let base = at0(uv);
  var m = clamp(at1(uv).r, 0.0, 1.0);
  let contrast = clamp(P(0).x, 0.0, 1.0);
  if (contrast > 0.0) { m = clamp((m - 0.5) * (1.0 + 4.0 * contrast) + 0.5, 0.0, 1.0); }
  let invert = P(0).y > 0.5;
  if (invert) { m = 1.0 - m; }
  var rgb = base.rgb;
  let amount = clamp(P(0).z, 0.0, 1.0);
  let m0 = clamp(at2(uv).a, 0.0, 1.0);
  if (!invert && amount > 0.0 && base.a > 0.00001 && m0 > 0.02 && m0 < 0.98) {
    // The background around the pixel: two rings (3 and 6 layer px), each tap
    // weighted by how clear the stored matte is there.
    var bg = vec3<f32>(0.0);
    var wsum = 0.0;
    for (var i = 0; i < 8; i = i + 1) {
      let a = f32(i) * 0.7853982;
      let d = vec2<f32>(cos(a), sin(a));
      for (var ring = 1; ring <= 2; ring = ring + 1) {
        let q = uv + dpxUv(d * 3.0 * f32(ring));
        let c = at0(q);
        let w = (1.0 - clamp(at2(q).a, 0.0, 1.0)) * c.a;
        bg = bg + unpremul(c) * w;
        wsum = wsum + w;
      }
    }
    if (wsum > 0.05) {
      bg = bg / wsum;
      let f = base.rgb / base.a;
      let unmixed = clamp((f - (1.0 - m0) * bg) / m0, vec3<f32>(0.0), vec3<f32>(1.0));
      rgb = mix(f, unmixed, amount) * base.a;
    }
  }
  return vec4<f32>(rgb * m, base.a * m);
}
