const fs = require('fs');

const NEW_SHADERS = `
export const GRADIENT_RAMP: ShaderSource = {
  name: 'gradient-ramp',
  wgsl: \`
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, colors: mat4x4<f32>, points: vec4<f32>, blend: f32 };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let p0 = obj.points.xy; let p1 = obj.points.zw;
  let dir = p1 - p0; let len2 = dot(dir, dir);
  let t = clamp(dot(uv - p0, dir) / max(len2, 0.0001), 0.0, 1.0);
  let rampColor = mix(obj.colors[0], obj.colors[1], t);
  let c = textureSample(tex, smp, uv);
  let outColor = mix(c.rgb, rampColor.rgb, rampColor.a * obj.blend);
  return vec4<f32>(outColor * c.a, c.a);
}
\`,
  glsl: {
    vertex: \`#version 300 es
layout(location = 0) in vec2 pos;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; mat4 colors; vec4 points; float blend; };
out vec2 vUv;
void main() {
  vec3 p = mvp * vec3(pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
  vUv = uvRect.xy + pos * uvRect.zw;
}
\`,
    fragment: \`#version 300 es
precision highp float;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; mat4 colors; vec4 points; float blend; };
uniform sampler2D uTex;
in vec2 vUv;
out vec4 frag;
void main() {
  vec2 p0 = points.xy; vec2 p1 = points.zw;
  vec2 dir = p1 - p0; float len2 = dot(dir, dir);
  float t = clamp(dot(vUv - p0, dir) / max(len2, 0.0001), 0.0, 1.0);
  vec4 rampColor = mix(colors[0], colors[1], t);
  vec4 c = texture(uTex, vUv);
  vec3 outColor = mix(c.rgb, rampColor.rgb, rampColor.a * blend);
  frag = vec4(outColor * c.a, c.a);
}
\`
  }
};

export const FRACTAL_NOISE: ShaderSource = {
  name: 'fractal-noise',
  wgsl: \`
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, params: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
fn hash22(p: vec2<f32>) -> vec2<f32> {
  var p3 = fract(vec3<f32>(p.xyx) * vec3<f32>(.1031, .1030, .0973));
  p3 = p3 + dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy) * 2.0 - 1.0;
}
fn perlin(p: vec2<f32>) -> f32 {
  let pi = floor(p); let pf = fract(p);
  let w = pf * pf * (3.0 - 2.0 * pf);
  return mix(
    mix(dot(hash22(pi + vec2<f32>(0.0, 0.0)), pf - vec2<f32>(0.0, 0.0)),
        dot(hash22(pi + vec2<f32>(1.0, 0.0)), pf - vec2<f32>(1.0, 0.0)), w.x),
    mix(dot(hash22(pi + vec2<f32>(0.0, 1.0)), pf - vec2<f32>(0.0, 1.0)),
        dot(hash22(pi + vec2<f32>(1.0, 1.0)), pf - vec2<f32>(1.0, 1.0)), w.x), w.y);
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let scale = obj.params.x; let offset = obj.params.yz; let octaves = i32(obj.params.w);
  var n = 0.0; var amp = 0.5; var p = uv * scale + offset;
  for (var i = 0; i < 4; i = i + 1) {
    if (i >= octaves) { break; }
    n = n + perlin(p) * amp;
    p = p * 2.0; amp = amp * 0.5;
  }
  let c = textureSample(tex, smp, uv);
  n = n * 0.5 + 0.5;
  return vec4<f32>(vec3<f32>(n), 1.0) * c.a;
}
\`,
  glsl: {
    vertex: \`#version 300 es
layout(location = 0) in vec2 pos;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 params; };
out vec2 vUv;
void main() {
  vec3 p = mvp * vec3(pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
  vUv = uvRect.xy + pos * uvRect.zw;
}
\`,
    fragment: \`#version 300 es
precision highp float;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 params; };
uniform sampler2D uTex;
in vec2 vUv;
out vec4 frag;
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy) * 2.0 - 1.0;
}
float perlin(vec2 p) {
  vec2 pi = floor(p); vec2 pf = fract(p);
  vec2 w = pf * pf * (3.0 - 2.0 * pf);
  return mix(
    mix(dot(hash22(pi + vec2(0.0, 0.0)), pf - vec2(0.0, 0.0)),
        dot(hash22(pi + vec2(1.0, 0.0)), pf - vec2(1.0, 0.0)), w.x),
    mix(dot(hash22(pi + vec2(0.0, 1.0)), pf - vec2(0.0, 1.0)),
        dot(hash22(pi + vec2(1.0, 1.0)), pf - vec2(1.0, 1.0)), w.x), w.y);
}
void main() {
  float scale = params.x; vec2 offset = params.yz; int octaves = int(params.w);
  float n = 0.0; float amp = 0.5; vec2 p = vUv * scale + offset;
  for (int i = 0; i < 4; i++) {
    if (i >= octaves) break;
    n += perlin(p) * amp;
    p *= 2.0; amp *= 0.5;
  }
  vec4 c = texture(uTex, vUv);
  n = n * 0.5 + 0.5;
  frag = vec4(vec3(n), 1.0) * c.a;
}
\`
  }
};

export const DISPLACEMENT_MAP: ShaderSource = {
  name: 'displacement-map',
  wgsl: \`
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, params: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
@group(0) @binding(3) var mapTex : texture_2d<f32>;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let mapC = textureSample(mapTex, smp, uv);
  let d = (mapC.rg - 0.5) * 2.0 * obj.params.xy;
  let nuv = clamp(uv + d, vec2<f32>(0.0), vec2<f32>(1.0));
  return textureSample(tex, smp, nuv);
}
\`,
  glsl: {
    vertex: \`#version 300 es
layout(location = 0) in vec2 pos;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 params; };
out vec2 vUv;
void main() {
  vec3 p = mvp * vec3(pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
  vUv = uvRect.xy + pos * uvRect.zw;
}
\`,
    fragment: \`#version 300 es
precision highp float;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 params; };
uniform sampler2D uTex;
uniform sampler2D uMapTex;
in vec2 vUv;
out vec4 frag;
void main() {
  vec4 mapC = texture(uMapTex, vUv);
  vec2 d = (mapC.rg - 0.5) * 2.0 * params.xy;
  vec2 nuv = clamp(vUv + d, vec2(0.0), vec2(1.0));
  frag = texture(uTex, nuv);
}
\`
  }
};

export const MOTION_TILE: ShaderSource = {
  name: 'motion-tile',
  wgsl: \`
struct Object { mvp: mat3x3<f32>, uvRect: vec4<f32>, params: vec4<f32> };
@group(0) @binding(0) var<uniform> obj : Object;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;
struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {
  var o : VOut; o.pos = vec4<f32>((obj.mvp * vec3<f32>(pos, 1.0)).xy, 0.0, 1.0); o.uv = obj.uvRect.xy + pos * obj.uvRect.zw; return o;
}
@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let scale = obj.params.xy; let offset = obj.params.zw;
  var p = uv * scale + offset;
  p = p - floor(p);
  return textureSample(tex, smp, p);
}
\`,
  glsl: {
    vertex: \`#version 300 es
layout(location = 0) in vec2 pos;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 params; };
out vec2 vUv;
void main() {
  vec3 p = mvp * vec3(pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
  vUv = uvRect.xy + pos * uvRect.zw;
}
\`,
    fragment: \`#version 300 es
precision highp float;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; vec4 params; };
uniform sampler2D uTex;
in vec2 vUv;
out vec4 frag;
void main() {
  vec2 scale = params.xy; vec2 offset = params.zw;
  vec2 p = vUv * scale + offset;
  p -= floor(p);
  frag = texture(uTex, p);
}
\`
  }
};
`;

let content = fs.readFileSync('packages/renderer/src/shaders/builtin.ts', 'utf8');
if (!content.includes('GRADIENT_RAMP')) {
  content = content.replace('export const BUILTIN_SHADERS', NEW_SHADERS + '\\nexport const BUILTIN_SHADERS');
  content = content.replace('[SOLID, TEXTURED, MASKED_TEXTURED, BLUR]', '[SOLID, TEXTURED, MASKED_TEXTURED, BLUR, GRADIENT_RAMP, FRACTAL_NOISE, DISPLACEMENT_MAP, MOTION_TILE]');
  fs.writeFileSync('packages/renderer/src/shaders/builtin.ts', content);
  console.log('Added shaders');
} else {
  console.log('Shaders already added');
}
