// Goo, pass 2 (stream D L3): the blob (tex0) shaded from its alpha distance
// field (tex1, op 4: r = signed distance in buffer texels, + outside). The
// surface is a dome over `dome` layer px — sideways at the contour, flat
// inside — lit by a direction with a Blinn highlight and a Fresnel rim in the
// highlight colour. Transparent wherever the blob is.
// p0 = (dome px, shine, shininess, rim), p1 = (light dir xyz, ambient), p2 = highlight (linear).
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let s = at0(uv);
  let f = at1(uv);
  let dome = max(P(0).x, 0.5);
  // Layer px inside the contour (the field is in texels of its target).
  let inside = clamp(-f.r * pxPerOut().x / dome, 0.0, 1.0);
  let e = 1.0 / vec2<f32>(textureDimensions(tex1));
  let gx = at1(uv + vec2<f32>(e.x, 0.0)).r - at1(uv - vec2<f32>(e.x, 0.0)).r;
  let gy = at1(uv + vec2<f32>(0.0, e.y)).r - at1(uv - vec2<f32>(0.0, e.y)).r;
  let gmag = length(vec2<f32>(gx, gy));
  var gdir = vec2<f32>(0.0);
  if (gmag > 0.00001) { gdir = vec2<f32>(gx, gy) / gmag; }
  // The light is authored top-down (field space); the gradient was measured in
  // sample space, whose V flips per backend (glass-composite.wgsl).
  let gfield = gdir * sign(obj.uvRect.zw);
  let tilt = 1.0 - inside;
  let n = normalize(vec3<f32>(gfield * tilt, sqrt(max(1.0 - tilt * tilt, 0.0)) + 0.001));
  let l = normalize(P(1).xyz);
  let ambient = P(1).w;
  let diff = max(dot(n, l), 0.0);
  let hv = normalize(l + vec3<f32>(0.0, 0.0, 1.0));
  let spec = pow(max(dot(n, hv), 0.0), P(0).z) * P(0).y;
  let fres = pow(1.0 - clamp(n.z, 0.0, 1.0), 3.0) * P(0).w;
  let lit = s.rgb * (ambient + (1.0 - ambient) * diff);
  return vec4<f32>(lit + P(2).rgb * (spec + fres) * s.a, s.a);
}
