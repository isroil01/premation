// Goo, pass 1 (stream D L3): the blurred layer (tex0) thresholded into one
// blob — alpha a soft step over the blurred alpha, colour the blurred layer's
// own (merged blobs blend their colours) or a tint. tex1 is the layer itself.
// p0 = (threshold, softness, colour 0 layer 1 tint, 0), p1 = tint (linear).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let b = at0(uv);
  let thr = P(0).x;
  let soft = P(0).y * thr;
  let e0 = thr - soft;
  let e1 = thr + soft;
  let cov = select(step(thr, b.a), smoothstep(e0, e1, b.a), soft > 0.0001);
  let own = unpremul(b);
  let col = select(own, P(1).rgb, P(0).z > 0.5);
  return vec4<f32>(col * cov, cov);
}
