
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, p0: vec4<f32>, p1: vec4<f32>, p2: vec4<f32>, fxBox: vec4<f32>, lightColor: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  // 'from' is a RESERVED WORD in WGSL (fine in GLSL) — naming this binding
  // 'from' failed CreateShaderModule, which invalidated the pipeline and then
  // the whole frame's command buffer: ONE spotlight blanked the ENTIRE scene.
  let fromPt    = obj.p0.xy;
  let to        = obj.p0.zw;
  let coneHalf  = max(obj.p1.x, 0.0001);
  let softness  = clamp(obj.p1.y, 0.0, 1.0);
  let intensity = obj.p1.z;
  let ambient   = obj.p1.w;
  let aspect    = obj.p2.x;
  let lightOnly = obj.p2.y;
  let reachCtl  = max(obj.p2.z, 0.0001);

  let c = textureSample(tex, smp, uv);
  // Field coordinate: fxBox and the From/To handles are authored top-down;
  // uv's V is backend-dependent on FBO round-trips (targetSampleUv).
  let fq = (uv - obj.uvRect.xy) / obj.uvRect.zw;
  let l = (fq - obj.fxBox.xy) / max(obj.fxBox.zw, vec2<f32>(0.000001, 0.000001));
  let q = vec2<f32>(l.x * aspect, l.y);

  let axis = to - fromPt;
  let reach = length(axis);
  let p = q - fromPt;
  let dist = length(p);

  var cone = 1.0;
  if (reach > 0.0001 && dist > 0.00001) {
    // Angle off the From→To axis, via the dot product rather than atan2 — no
    // ±π seam to tear on.
    let ang = acos(clamp(dot(p / dist, axis / reach), -1.0, 1.0));
    /*
      Softness widens the falloff INWARD from the cone edge: 0 is a hard edge,
      1 fades from the axis outward. The inner limit is held strictly below the
      outer one — at softness 0 they would be equal, and smoothstep with
      low == high divides by zero, giving NaN for every pixel in the cone.
    */
    let inner = min(coneHalf * (1.0 - softness), coneHalf - 0.0001);
    cone = 1.0 - smoothstep(inner, coneHalf, ang);
  }
  /*
    Reach is its OWN control (AE's Height), not the From→To distance.

    Welding it to the handles is what made this effect look like it deleted the
    layer: the default handles sit half a layer-height apart, so everything
    further than that from the lamp fell to ambient — and a layer at low ambient
    on a dark composition is indistinguishable from a layer that is not there.

    Falloff plateaus through most of the reach, then softens at the edge — a
    linear decline from the lamp (smoothstep from 0) darkened the subject even
    inside the cone.
  */
  let fallInner = reachCtl * 0.65;
  let falloff = 1.0 - smoothstep(min(fallInner, reachCtl - 0.0001), reachCtl, dist);
  // var, not let - WGSL lets are immutable and the floor below reassigns.
  var lightAmt = ambient + cone * falloff * intensity;
  // Floor at ambient so the beam can only BRIGHTEN relative to the outside
  // level — never punch a hole darker than the user asked for. With the
  // default ambient of 1 the layer is unchanged outside the cone (and on an
  // adjustment layer that means the rest of the scene stays visible).
  lightAmt = max(lightAmt, ambient);
  // Multiplies the layer: a spotlight reveals what is there. Light Only drops
  // the layer's colour and keeps the beam (AE's second Render mode).
  let base = select(c.rgb, vec3<f32>(c.a, c.a, c.a), lightOnly > 0.5);
  return vec4<f32>(base * obj.lightColor.rgb * lightAmt, c.a);
}
