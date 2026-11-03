/*@fx
{
  "name": "Chroma Split",
  "family": "Distort",
  "summary": "Pulls the red and blue channels apart along an angle, as a lens with lateral chromatic aberration does.",
  "params": [
    { "id": 1, "key": "amount", "type": "float", "name": "Amount", "unit": "px", "default": 12, "min": 0, "max": 400, "smax": 80, "precision": 1, "desc": "How far red and blue move, in layer px." },
    { "id": 2, "key": "angle", "type": "angle", "name": "Angle", "default": 0 },
    { "id": 3, "key": "radial", "type": "checkbox", "name": "Radial", "default": false, "desc": "Split away from the layer centre instead of along the angle." }
  ],
  "expand": "amount + 2",
  "presets": [
    { "name": "Subtle Lens", "values": { "amount": 4, "radial": true } },
    { "name": "Glitch Bar", "values": { "amount": 40, "angle": 0 } }
  ]
}
*/
fn effect(p: vec2f) -> vec4f {
  var d = rot2(vec2f(prm.amount, 0.0), radians(prm.angle));
  if (prm.radial != 0) {
    let c = to_world(layer_size() * 0.5);
    let off = p - c;
    let r = max(length(off), 1e-3);
    d = off / r * prm.amount * min(r / max(length(layer_size()) * 0.5, 1.0), 1.0);
  }
  let r = src(p - d);
  let g = src(p);
  let b = src(p + d);
  let a = max(max(r.a, g.a), b.a);
  return vec4f(r.r, g.g, b.b, a);
}
