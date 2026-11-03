/*@fx
{
  "name": "Dot Grid",
  "family": "Generate",
  "summary": "An anti-aliased grid of dots whose size breathes with a travelling noise wave.",
  "generator": true,
  "animated": true,
  "params": [
    { "id": 1, "key": "spacing", "type": "float", "name": "Spacing", "unit": "px", "default": 48, "min": 4, "max": 1000, "smax": 200, "precision": 0 },
    { "id": 2, "key": "size", "type": "float", "name": "Dot Size", "default": 40, "min": 0, "max": 100, "precision": 0, "unit": "%" },
    { "id": 3, "key": "wave", "type": "float", "name": "Wave", "default": 50, "min": 0, "max": 100, "precision": 0, "unit": "%", "desc": "How much the noise wave changes each dot's size." },
    { "id": 4, "key": "speed", "type": "float", "name": "Speed", "default": 0.5, "min": 0, "max": 10, "precision": 2 },
    { "id": 5, "key": "color", "type": "color", "name": "Color", "default": "#f2f2f2" }
  ],
  "presets": [
    { "name": "Still", "values": { "wave": 0, "speed": 0 } }
  ]
}
*/
fn effect(p: vec2f) -> vec4f {
  let q = to_layer(p);
  let s = max(prm.spacing, 1.0);
  let cell = floor(q / s);
  let f = q - (cell + vec2f(0.5)) * s;
  let n = gnoise_t(cell * 0.15, time_s() * prm.speed, 7u) * 0.5 + 0.5;
  let rad = 0.5 * s * clamp(prm.size * 0.01 * mix(1.0, n, prm.wave * 0.01), 0.0, 1.0);
  let px = max(px_scale(), 1e-3);
  let cov = 1.0 - aa_step(rad, length(f), 0.75 / px);
  return vec4f(prm.color.rgb * prm.color.a, prm.color.a) * cov;
}
