const fs = require('fs');

const NEW_UNIFORMS = `
export function packGradientRamp(mvp: Mat3, uvRect: Rect, colors: [Color, Color], points: [number, number, number, number], blend: number): Float32Array {
  const out = new Float32Array(MAT3_STD140_FLOATS + 4 + 16 + 4 + 4);
  let o = packMat3(mvp, out, 0);
  o = packRect(uvRect, out, o);
  // colors: mat4x4
  out[o + 0] = colors[0].r; out[o + 1] = colors[0].g; out[o + 2] = colors[0].b; out[o + 3] = colors[0].a; o += 4;
  out[o + 0] = colors[1].r; out[o + 1] = colors[1].g; out[o + 2] = colors[1].b; out[o + 3] = colors[1].a; o += 4;
  o += 8; // mat4 padding
  // points
  out[o + 0] = points[0]; out[o + 1] = points[1]; out[o + 2] = points[2]; out[o + 3] = points[3]; o += 4;
  // blend
  out[o + 0] = blend; o += 4;
  return out;
}

export function packFractalNoise(mvp: Mat3, uvRect: Rect, scale: number, offsetX: number, offsetY: number, octaves: number): Float32Array {
  const out = new Float32Array(MAT3_STD140_FLOATS + 4 + 4);
  let o = packMat3(mvp, out, 0);
  o = packRect(uvRect, out, o);
  out[o + 0] = scale; out[o + 1] = offsetX; out[o + 2] = offsetY; out[o + 3] = octaves;
  return out;
}

export function packDisplacementMap(mvp: Mat3, uvRect: Rect, amountX: number, amountY: number): Float32Array {
  const out = new Float32Array(MAT3_STD140_FLOATS + 4 + 4);
  let o = packMat3(mvp, out, 0);
  o = packRect(uvRect, out, o);
  out[o + 0] = amountX; out[o + 1] = amountY; out[o + 2] = 0; out[o + 3] = 0;
  return out;
}

export function packMotionTile(mvp: Mat3, uvRect: Rect, scaleX: number, scaleY: number, offsetX: number, offsetY: number): Float32Array {
  const out = new Float32Array(MAT3_STD140_FLOATS + 4 + 4);
  let o = packMat3(mvp, out, 0);
  o = packRect(uvRect, out, o);
  out[o + 0] = scaleX; out[o + 1] = scaleY; out[o + 2] = offsetX; out[o + 3] = offsetY;
  return out;
}
`;

let content = fs.readFileSync('packages/renderer/src/pipeline/uniforms.ts', 'utf8');
if (!content.includes('packGradientRamp')) {
  fs.appendFileSync('packages/renderer/src/pipeline/uniforms.ts', NEW_UNIFORMS);
  console.log('Added uniform packers');
} else {
  console.log('Uniform packers already added');
}
