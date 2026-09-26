
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, p0: vec4<f32>, p1: vec4<f32>, fxBox: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
// Undo the style profile: given how far through the bend a pixel is, recover
// how far along the SOURCE strip it came from. Exact for all three styles.
fn bendProfileInv(w : f32, style : f32) -> f32 {
  if (style < 0.5) {
    // Marilyn — smoothstep 3t²−2t³. Its real root, via the trigonometric
    // solution of the depressed cubic.
    return 0.5 - sin(asin(clamp(1.0 - 2.0 * w, -1.0, 1.0)) / 3.0);
  }
  if (style < 1.5) { return w; }            // Sharp — linear ramp, a crease
  return asin(clamp(w, 0.0, 1.0)) * 0.63661977;  // Circular — sin(t·π/2), ×2/π
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let theta   = obj.p0.x;
  let style   = obj.p0.y;
  let aspect  = obj.p0.z;
  let outside = obj.p0.w;   // 0 = carry the remainder, 1 = hold it still
  let top     = obj.p1.xy;  // bend line start, aspect-corrected layer units
  let base    = obj.p1.zw;  // bend line end

  /*
    LAYER-LOCAL via fxBox, NOT uvRect.

    On the 2D route the chain's buffer is SCREEN SPACE and the layer is a
    sub-rect of it. uvRect addresses the quad within that buffer, which is not
    the same thing. Deriving layer coordinates from uvRect therefore bends the
    whole buffer instead of the layer: content sweeps hundreds of pixels
    outside the layer box, which is exactly what it did. fxBox is the layer's
    box within the buffer, and it is the quantity Beam and Gradient Ramp
    already resolve against for this same reason.

    Then ASPECT-CORRECTED: UV is anisotropic on a non-square layer, which would
    shear any bend line that is not exactly axis-aligned. Working in units of
    the layer's HEIGHT makes distance mean the same thing on both axes.

    Outside the layer box there is nothing to bend, so those pixels pass
    through untouched rather than being dragged into the arc.
  */
  let box = obj.fxBox;
  // FIELD coordinate first: fxBox is authored top-down while uv's V is
  // backend-dependent on FBO round-trips (targetSampleUv) — mixing them
  // mirrored the bend line and arc direction on WebGL2.
  let fq = (uv - obj.uvRect.xy) / obj.uvRect.zw;
  let l = (fq - box.xy) / max(box.zw, vec2<f32>(0.000001, 0.000001));
  let q = vec2<f32>(l.x * aspect, l.y);

  // The two points ARE the bend: direction and span both come from them, so
  // there is no separate axis or extent to disagree with them.
  let axis = base - top;
  let L    = length(axis);

  var srcQ = q;
  if (abs(theta) > 0.0001 && L > 0.0001) {
    let d = axis / L;
    let n = vec2<f32>(-d.y, d.x);
    let rel = q - top;
    let a = dot(rel, d);      // 0 at Top, L at Base
    /*
      MIRROR a negative bend rather than signing the arc.

      A negative angle puts the arc centre on the OTHER side of the strip, so
      R = L/theta goes negative, dy = R - b with it, and atan2(a, dy)/theta
      comes out NEGATIVE for the whole band — which lands in the untouched
      "before Top" case below. The result is that a negative Amount did
      nothing at all, and because nothing ever reached the past-Base region,
      Style and Past Base looked dead too.

      Solving the POSITIVE problem in a frame flipped across the bend line, and
      flipping the answer back, keeps one code path and makes the two
      directions exactly symmetric.
    */
    let sgn = select(-1.0, 1.0, theta >= 0.0);
    let th = abs(theta);
    let b = dot(rel, n) * sgn;
    let R = L / th;
    let dy = R - b;
    let r  = length(vec2<f32>(a, dy));
    let w  = atan2(a, dy) / th;
    var sa = a;
    var sb = b;
    if (w > 1.0 && outside < 0.5) {
      /*
        CARRY (AE's CC Bender): past Base the remainder is rigid, rotated by the
        full bend — the object hinges and everything below the hinge swings.
      */
      let ce = cos(th); let se = sin(th);
      let ex = R * se; let ey = R - R * ce;
      let rx = a - ex;  let ry = b - ey;
      sa = L + (rx * ce + ry * se);
      sb = -rx * se + ry * ce;
    } else if (w > 1.0) {
      /*
        HOLD: past Base the layer is left exactly where it was, so the bend is
        confined to the Top→Base band and nothing else in the object moves.
        sa/sb are already a/b, so this branch deliberately does nothing — it
        exists to stop the carry branch above from claiming this region.
      */
    } else if (w >= 0.0) {
      sa = bendProfileInv(w, style) * L;
      sb = R - r;
    }
    // Before Top (w < 0) the layer is untouched, which is sa/sb as initialised.
    srcQ = top + d * sa + n * (sb * sgn);
  }

  let src = vec2<f32>(srcQ.x / aspect, srcQ.y);
  // A bend pulls source coordinates off the layer; those pixels are empty, not
  // the edge smeared outwards, so this reads transparent rather than clamping.
  if (src.x < 0.0 || src.x > 1.0 || src.y < 0.0 || src.y > 1.0) {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
  }
  // Back to BUFFER uv through the layer's box — the inverse of the mapping at
  // the top. Going back through uvRect instead would place the sampled pixel
  // in a different part of the buffer than it was read from.
  let bufUv = obj.uvRect.xy + (box.xy + src * box.zw) * obj.uvRect.zw;
  // textureSampleLEVEL, not textureSample. The plain form computes implicit
  // derivatives, and WGSL requires UNIFORM CONTROL FLOW for those — the bounds
  // check above is an early return, which makes this call non-uniform. Tint
  // rejects the module, pipeline creation fails, the effect pass draws nothing,
  // and because the chain relies on a draw to composite the layer back out the
  // LAYER DISAPPEARS. apply-color-lut and compound-blur hit this first; see the
  // note in compound-blur.
  return textureSampleLevel(tex, smp, bufUv, 0.0);
}
