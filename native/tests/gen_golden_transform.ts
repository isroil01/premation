/**
 * Golden-table generator for motion_transform — the transform/parenting/camera
 * parity contract.
 *
 * RUNS the TypeScript: `Matrix`, `Matrix4Math`, `Project3D` (packages/scene),
 * `worldMatrixOf` / `matrixToLocal` / `localUnderParent` (src/core/scene/
 * worldTransform.ts), `composeNodeWorld3d` / `parentWorld3d` (nodeMatrix.ts)
 * and `cameraFromNode` (camera3d.ts), bundled on the fly with esbuild (the app
 * modules use tsconfig path aliases plain Node cannot resolve) — and writes
 * `golden_transform.inc`, which test_transform.cpp checks bit for bit.
 *
 * Two compositions are NOT importable because the TypeScript builds them
 * inside scene-graph-bound functions: layerSpace.ts `layerSpaceAt` (3D branch)
 * and buildSnapshot.ts `affineAt`. For those the generator composes the SAME
 * exported primitives in the same order (quoted below from those files); the
 * primitives themselves are the real TypeScript.
 *
 *     node native/tests/gen_golden_transform.ts
 */

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const require = createRequire(join(root, 'package.json'));
const esbuild = require('esbuild');
const bundlePath = join(tmpdir(), `motion-golden-transform-${process.pid}.mjs`);
await esbuild.build({
  stdin: {
    contents: `
      export { worldMatrixOf, matrixToLocal, localUnderParent, localMatrix } from '@core/scene/worldTransform';
      export { composeNodeWorld3d, parentWorld3d } from '@core/scene/nodeMatrix';
      export { cameraFromNode } from '@core/scene/camera3d';
      export { Matrix, Matrix4Math, Project3D } from '@motion/scene';`,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: bundlePath,
  tsconfig: join(root, 'tsconfig.json'),
  logLevel: 'error',
  loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty', '.wgsl': 'text', '.glsl': 'text' },
});
const T = await import(pathToFileURL(bundlePath).href);
const { Matrix, Matrix4Math, Project3D, worldMatrixOf, matrixToLocal, localUnderParent, composeNodeWorld3d, parentWorld3d, cameraFromNode } = T;

// ── Encoding ────────────────────────────────────────────────────────────────

const dv = new DataView(new ArrayBuffer(8));
const hex = (x: number): string => {
  dv.setFloat64(0, x);
  return `0x${dv.getBigUint64(0).toString(16).padStart(16, '0')}ull`;
};
const KIND = {
  COMPOSE2D: 1, DECOMPOSE2D: 2, M2L: 3, INVERT2D: 4, SCENE2D: 5, LUP: 6, COMPOSE3D: 7, SCENE3D: 8, INVERT4: 9,
  XPOINT4: 10, XVECTOR4: 11, CAMERA: 12, PROJECT: 13, CAMMATS: 14, UNPROJECT: 15, RAYPLANE: 16, LOOKAT: 17,
  ORBIT: 18, FOCAL: 19, FOV: 20, ORTHOPROJ: 21, ORTHOMATS: 22, SPACE3D: 23, AFFINE3D: 24, DEFCAM: 25, MUL4: 26, MUL2D: 27,
} as const;
// One flat array of bit patterns + a row table into it: a per-row initializer
// list of thousands of arguments made the test translation unit take minutes.
const rows: string[] = [];
const data: string[] = [];
const counts: Record<string, number> = {};
function row(kind: keyof typeof KIND, input: number[], output: number[]): void {
  const all = [...input, ...output];
  rows.push(`MOTION_XF(${KIND[kind]}, ${data.length}, ${input.length}, ${all.length})`);
  for (const x of all) data.push(hex(x));
  counts[kind] = (counts[kind] ?? 0) + 1;
}

// xorshift64* — seeded
let state = 0x2545f4914f6cdd1dn;
function u(): number {
  state ^= state >> 12n;
  state ^= (state << 25n) & 0xffffffffffffffffn;
  state ^= state >> 27n;
  return Number(((state * 0x2545f4914f6cdd1dn) & 0xffffffffffffffffn) >> 11n) / 2 ** 53;
}
const r = (lo: number, hi: number) => lo + (hi - lo) * u();
const pick = <X>(a: X[]): X => a[Math.floor(u() * a.length)]!;
const angle = () => pick([0, 0, 90, -90, 180, 45, 30, r(-720, 720), r(-45, 45), 1e-9, 359.999]);
const scale = () => pick([1, 1, 0.5, 2, -1, 0, r(-3, 3), r(0.01, 5), 100]);
const coord = () => pick([0, r(-2000, 2000), r(-10, 10), 960, 540, 1e6, -1e-3]);

const m2d = (m: any) => [m.a, m.b, m.c, m.d, m.e, m.f];
const loc = (l: any) => [l.x, l.y, l.rotation, l.scaleX, l.scaleY];
const randLocal = () => ({ x: coord(), y: coord(), rotation: angle(), scaleX: scale(), scaleY: scale() });
const randM2 = () => ({ a: r(-3, 3), b: r(-3, 3), c: r(-3, 3), d: r(-3, 3), e: coord(), f: coord() });
const randNode3 = () => ({
  x: coord(), y: coord(), z: pick([0, r(-3000, 3000), 500]),
  rotationX: angle(), rotationY: angle(), rotationZ: angle(),
  orientationX: angle(), orientationY: angle(), orientationZ: angle(),
  scaleX: scale(), scaleY: scale(), scaleZ: pick([1, scale()]),
  anchorX: pick([0, r(-500, 500)]), anchorY: pick([0, r(-500, 500)]), anchorZ: pick([0, r(-200, 200)]),
});
const n3 = (v: any) => [v.x, v.y, v.z, v.rotationX, v.rotationY, v.rotationZ, v.orientationX, v.orientationY,
  v.orientationZ, v.scaleX, v.scaleY, v.scaleZ, v.anchorX, v.anchorY, v.anchorZ];
const camArr = (c: any) => [c.position.x, c.position.y, c.position.z, c.focalLength, c.principal.x, c.principal.y,
  c.orientation ? 1 : 0, c.orientation && c.orientation.roll !== undefined ? 1 : 0,
  c.orientation?.yaw ?? 0, c.orientation?.pitch ?? 0, c.orientation?.roll ?? 0];
const randCam = (): any => {
  const w = pick([1920, 1280, 3840]);
  const cam = Project3D.defaultCamera(w, w * 9 / 16, pick([39.6, 15, 90, 120]));
  cam.position = { x: r(-500, 2500), y: r(-500, 1500), z: pick([-2666, r(-5000, -100), r(-500, 500)]) };
  const k = u();
  if (k < 0.3) cam.orientation = { yaw: angle(), pitch: angle() };
  else if (k < 0.5) cam.orientation = { yaw: angle(), pitch: angle(), roll: angle() };
  return cam;
};
const randMat4 = () => {
  const n = randNode3();
  return Matrix4Math.compose({
    position: { x: n.x, y: n.y, z: n.z },
    rotation: { x: n.rotationX * Math.PI / 180, y: n.rotationY * Math.PI / 180, z: n.rotationZ * Math.PI / 180 },
    scale: { x: n.scaleX, y: n.scaleY, z: n.scaleZ },
    anchor: { x: n.anchorX, y: n.anchorY, z: n.anchorZ },
  });
};

// ── 2D ──────────────────────────────────────────────────────────────────────

for (let i = 0; i < 150; i++) {
  const t = { position: { x: coord(), y: coord() }, rotation: angle() * Math.PI / 180, scale: { x: scale(), y: scale() },
    skew: { x: pick([0, r(-1, 1)]), y: pick([0, r(-1, 1)]) }, anchor: { x: pick([0, r(-300, 300)]), y: pick([0, r(-300, 300)]) } };
  row('COMPOSE2D', [t.position.x, t.position.y, t.rotation, t.scale.x, t.scale.y, t.skew.x, t.skew.y, t.anchor.x, t.anchor.y], m2d(Matrix.compose(t)));
}
for (let i = 0; i < 120; i++) {
  const m = i % 10 === 0 ? { a: 0, b: 0, c: 1, d: 2, e: 3, f: 4 } : randM2();
  const d = Matrix.decompose(m);
  row('DECOMPOSE2D', m2d(m), [d.position.x, d.position.y, d.rotation, d.scale.x, d.scale.y]);
  row('M2L', m2d(m), loc(matrixToLocal(m)));
  row('INVERT2D', m2d(m), m2d(Matrix.invert(m)));
  const n = randM2();
  row('MUL2D', [...m2d(m), ...m2d(n)], m2d(Matrix.multiply(m, n)));
  row('LUP', [...m2d(m), ...m2d(n)], loc(localUnderParent(m, n)));
}
// Parent chains 1..50 deep, plus random trees, plus a 400-layer forest (the
// 2000-layer build is the benchmark's; one macro row that size is too big).
function scene2d(n: number, parentGen: (i: number) => number): void {
  const parents = Array.from({ length: n }, (_, i) => parentGen(i));  // drawn once: the generator may be random
  const parentOf = (i: number) => parents[i]!;
  const locals = Array.from({ length: n }, (_, i) => (i % 17 === 5 ? null : randLocal()));
  const cache = new Map();
  const input = [n];
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const l = locals[i];
    input.push(l ? 1 : 0, parentOf(i), ...(l ? loc(l) : [0, 0, 0, 1, 1]));
  }
  for (let i = 0; i < n; i++) {
    const w = worldMatrixOf(String(i), (id: string) => locals[Number(id)] ?? null,
      (id: string) => (parentOf(Number(id)) >= 0 ? String(parentOf(Number(id))) : null), cache);
    out.push(...m2d(w), ...loc(matrixToLocal(w)));
  }
  row('SCENE2D', input, out);
}
for (let depth = 1; depth <= 50; depth++) scene2d(depth, (i) => i - 1);
for (let k = 0; k < 20; k++) scene2d(40, (i) => (i === 0 ? -1 : Math.floor(u() * i)));
scene2d(400, (i) => (i === 0 ? -1 : i % 50 === 0 ? -1 : Math.max(0, i - 1 - Math.floor(u() * 3))));

// ── 3D ──────────────────────────────────────────────────────────────────────

for (let i = 0; i < 200; i++) {
  const v = randNode3();
  row('COMPOSE3D', n3(v), composeNodeWorld3d(v));
}
for (let i = 0; i < 80; i++) {
  const a = i % 4 === 0 ? [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 1e-3, 5, 6, 7, 1] : randMat4();
  const b = randMat4();
  row('MUL4', [...a, ...b], Matrix4Math.multiply(a, b));
  const inv = Matrix4Math.invert(a);
  row('INVERT4', a, inv ? [1, ...inv] : [0, ...new Array(16).fill(0)]);
  const p = { x: coord(), y: coord(), z: r(-500, 500) };
  const q = Matrix4Math.transformPoint(a, p);
  row('XPOINT4', [...a, p.x, p.y, p.z], [q.x, q.y, q.z]);
  const vv = Matrix4Math.transformVector(a, p);
  row('XVECTOR4', [...a, p.x, p.y, p.z], [vv.x, vv.y, vv.z]);
}
// Singular + general (projective) inverses.
for (const a of [new Array(16).fill(0), [1, 2, 3, 0.5, 4, 5, 6, 0.25, 7, 8, 10, 0.1, 1, 1, 1, 2], [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]]) {
  const inv = Matrix4Math.invert(a);
  row('INVERT4', a, inv ? [1, ...inv] : [0, ...new Array(16).fill(0)]);
}
// parentWorld3d over mixed 2D/3D chains 1..50 deep (a 2D ancestor replaces the accumulator).
function scene3d(n: number, parentOf: (i: number) => number, is3d: (i: number) => boolean): void {
  const locals = Array.from({ length: n }, (_, i) => (i % 13 === 7 ? null : randNode3()));
  const world2 = Array.from({ length: n }, () => randM2());
  const input = [n, n - 1];
  for (let i = 0; i < n; i++) {
    const l = locals[i];
    input.push(parentOf(i), is3d(i) ? 1 : 0, l ? 1 : 0, ...(l ? n3(l) : new Array(15).fill(0)), ...m2d(world2[i]));
  }
  const res = parentWorld3d(String(n - 1), {
    parentOf: (id: string) => (parentOf(Number(id)) >= 0 ? String(parentOf(Number(id))) : null),
    local3DOf: (id: string) => locals[Number(id)] ?? null,
    is3DOf: (id: string) => is3d(Number(id)),
    world2DOf: (id: string) => world2[Number(id)],
  });
  row('SCENE3D', input, res ? [1, ...res] : [0, ...new Array(16).fill(0)]);
}
for (let depth = 1; depth <= 50; depth++) {
  scene3d(depth, (i) => i - 1, (i) => i % 5 !== 3);
  scene3d(depth, (i) => i - 1, () => true);
  scene3d(depth, (i) => i - 1, (i) => i === 0);
}
scene3d(6, (i) => (i === 0 ? 4 : i - 1), () => true);  // a cycle: the `seen` set stops the walk
scene3d(5, (i) => i - 1, () => false);                  // no 3D ancestor → null

// ── Camera ──────────────────────────────────────────────────────────────────

const PROP_KEYS = ['x', 'y', 'z', 'focalLength', 'orbitYaw', 'orbitPitch', 'poiX', 'poiY', 'poiZ', 'orientationX', 'orientationY', 'orientationZ'];
for (let i = 0; i < 160; i++) {
  const w = pick([1920, 1280, 1000]);
  const h = pick([1080, 720, 1000]);
  const props: Record<string, number> = {};
  let mask = 0;
  const values: number[] = [];
  PROP_KEYS.forEach((k, j) => {
    const present = (k.startsWith('poi') ? i % 2 === 0 && u() < 0.7 : u() < 0.5);
    let v = 0;
    if (present) {
      v = k === 'focalLength' ? r(300, 4000) : k.startsWith('orbit') || k.startsWith('orientation') ? angle() : coord();
      props[k] = v;
      mask |= 1 << j;
    }
    values.push(v);
  });
  const lift = i % 3 === 0 ? randMat4() : null;
  const node = { id: 'cam', components: [{ type: 'Camera', props }] };
  const cam = cameraFromNode(node, w, h, undefined,
    lift ? (_id: string, p: { x: number; y: number; z: number }) => Matrix4Math.transformPoint(lift, p) : undefined);
  row('CAMERA', [w, h, mask, ...values, lift ? 1 : 0, ...(lift ?? new Array(16).fill(0))], camArr(cam));
  for (const p of [{ x: 960, y: 540, z: 0 }, { x: coord(), y: coord(), z: r(-3000, 3000) }, { x: 0, y: 0, z: cam.position.z + 0.5 }]) {
    const o = Project3D.projectPoint(p, cam);
    row('PROJECT', [...camArr(cam), p.x, p.y, p.z], [o.x, o.y, o.scale, o.depth, o.clipped ? 1 : 0]);
  }
  row('CAMMATS', camArr(cam), [...Project3D.cameraViewMatrix(cam), ...Project3D.cameraProjectionMatrix(cam)]);
  const sx = r(0, w);
  const sy = r(0, h);
  const ortho = i % 4 === 0 ? pick([0, 1, 2, 3, 4, 5]) : -1;
  const VIEWS = ['front', 'back', 'left', 'right', 'top', 'bottom'];
  const ray = Project3D.unprojectScreenRay(sx, sy, cam, ortho >= 0 ? VIEWS[ortho] : null, w, h);
  row('UNPROJECT', [...camArr(cam), sx, sy, w, h, ortho], [ray.origin.x, ray.origin.y, ray.origin.z, ray.direction.x, ray.direction.y, ray.direction.z]);
  const pp = { x: coord(), y: coord(), z: r(-100, 100) };
  const pn = pick([{ x: 0, y: 0, z: 1 }, { x: r(-1, 1), y: r(-1, 1), z: r(-1, 1) }, { x: 1, y: 0, z: 0 }]);
  const hit = Project3D.intersectRayPlane(ray, pp, pn);
  row('RAYPLANE', [ray.origin.x, ray.origin.y, ray.origin.z, ray.direction.x, ray.direction.y, ray.direction.z, pp.x, pp.y, pp.z, pn.x, pn.y, pn.z],
    hit ? [1, hit.x, hit.y, hit.z] : [0, 0, 0, 0]);
}
for (let i = 0; i < 60; i++) {
  const e = { x: coord(), y: coord(), z: r(-3000, 3000) };
  const t = i % 10 === 0 ? { ...e } : { x: coord(), y: coord(), z: r(-3000, 3000) };
  const l = Project3D.lookAtOrientation(e, t);
  row('LOOKAT', [e.x, e.y, e.z, t.x, t.y, t.z], [l.yaw, l.pitch]);
  const yaw = i % 7 === 0 ? 0 : angle();
  const pitch = i % 7 === 0 ? 0 : angle();
  const o = Project3D.orbitCamera(e, t, yaw, pitch);
  row('ORBIT', [e.x, e.y, e.z, t.x, t.y, t.z, yaw, pitch], [o.position.x, o.position.y, o.position.z, o.orientation.yaw, o.orientation.pitch]);
  const w = pick([1920, 1280, 640]);
  const fov = pick([39.6, 0.5, 200, r(1, 179)]);
  row('FOCAL', [w, fov], [Project3D.focalLengthForFov(w, fov)]);
  const f = pick([1e-9, 2666.6, r(10, 5000)]);
  row('FOV', [w, f], [Project3D.fovForFocalLength(w, f)]);
  const dc = Project3D.defaultCamera(w, w / 2, fov);
  row('DEFCAM', [w, w / 2, fov], camArr(dc));
  const VIEWS = ['front', 'back', 'left', 'right', 'top', 'bottom'];
  const v = i % 6;
  const p = { x: coord(), y: coord(), z: r(-500, 500) };
  const op = Project3D.projectOrtho(p, VIEWS[v], w, w / 2);
  row('ORTHOPROJ', [p.x, p.y, p.z, v, w, w / 2], [op.x, op.y, op.scale, op.depth]);
  const om = Project3D.orthoCameraMatrices(VIEWS[v], w, w / 2);
  row('ORTHOMATS', [v, w, w / 2], [...om.view, ...om.projection]);
}

// ── layerSpace.ts 3D branch (composition quoted from layerSpaceAt) ─────────
//
//   const plane = planeOf(m);   point = m·(0,0,0); normal = m·(0,0,1) − point
//   toWorld  = transformPoint(m, {x, y, z: 0})
//   fromWorld= mi ? transformPoint(mi, p).xy : p.xy
//   toComp   = projectPoint(toWorld(p), camera).xy
//   fromComp = hit = intersectRayPlane(unprojectScreenRay(p, camera, null, w, h), plane)
//              hit ? fromWorld(hit) : [0, 0]
for (let i = 0; i < 150; i++) {
  const m = i % 25 === 0 ? [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1] : randMat4();
  const cam = randCam();
  const w = cam.principal.x * 2;
  const h = cam.principal.y * 2;
  const mi = Matrix4Math.invert(m);
  const point = Matrix4Math.transformPoint(m, { x: 0, y: 0, z: 0 });
  const zAxis = Matrix4Math.transformPoint(m, { x: 0, y: 0, z: 1 });
  const normal = { x: zAxis.x - point.x, y: zAxis.y - point.y, z: zAxis.z - point.z };
  const toWorld = (p: number[]) => { const q = Matrix4Math.transformPoint(m, { x: p[0], y: p[1], z: 0 }); return [q.x, q.y, q.z]; };
  const fromWorld = (p: number[]) => { if (!mi) return [p[0], p[1]]; const q = Matrix4Math.transformPoint(mi, { x: p[0], y: p[1], z: p[2] }); return [q.x, q.y]; };
  const p = [r(-400, 400), r(-400, 400)];
  const s = [r(0, w), r(0, h)];
  const wp = [coord(), coord(), r(-300, 300)];
  const tw = toWorld(p);
  const o = Project3D.projectPoint({ x: tw[0], y: tw[1], z: tw[2] }, cam);
  const ray = Project3D.unprojectScreenRay(s[0], s[1], cam, null, w, h);
  const hit = Project3D.intersectRayPlane(ray, point, normal);
  const fc = hit ? fromWorld([hit.x, hit.y, hit.z]) : [0, 0];
  row('SPACE3D', [...m, ...camArr(cam), w, h, ...p, ...s, ...wp], [...tw, o.x, o.y, ...fc, ...fromWorld(wp)]);
}

// ── buildSnapshot.ts affineAt (composition quoted) ──────────────────────────
//
//   L = compose({ position: {wx, wy, wz}, rotation: {(rX + oriX)·DEG, …},
//                 scale: {sX, sY, sZ}, anchor: {0, 0, anchorZ} })
//   M = parent3d ? multiply(parent3d, L) : L
//   O, X, Y = proj(transformPoint(M, (0,0,0) | (1,0,0) | (0,1,0)))
//   matrix = [X.x − O.x, X.y − O.y, Y.x − O.x, Y.y − O.y, O.x, O.y]
//   sx = hypot(m[0], m[1]); sy = hypot(m[2], m[3]); rot = atan2(m[1], m[0]) / DEG
const DEG = Math.PI / 180;
for (let i = 0; i < 150; i++) {
  const v = randNode3();
  const parent = i % 3 === 0 ? null : randMat4();
  const cam = randCam();
  const L = Matrix4Math.compose({
    position: { x: v.x, y: v.y, z: v.z },
    rotation: { x: (v.rotationX + v.orientationX) * DEG, y: (v.rotationY + v.orientationY) * DEG, z: (v.rotationZ + v.orientationZ) * DEG },
    scale: { x: v.scaleX, y: v.scaleY, z: v.scaleZ },
    anchor: { x: 0, y: 0, z: v.anchorZ },
  });
  const M = parent ? Matrix4Math.multiply(parent, L) : L;
  const proj = (p: any) => Project3D.projectPoint(p, cam);
  const O = proj(Matrix4Math.transformPoint(M, { x: 0, y: 0, z: 0 }));
  const X = proj(Matrix4Math.transformPoint(M, { x: 1, y: 0, z: 0 }));
  const Y = proj(Matrix4Math.transformPoint(M, { x: 0, y: 1, z: 0 }));
  const mm = [X.x - O.x, X.y - O.y, Y.x - O.x, Y.y - O.y, O.x, O.y];
  row('AFFINE3D', [...n3(v), parent ? 1 : 0, ...(parent ?? new Array(16).fill(0)), ...camArr(cam)],
    [...mm, O.x, O.y, O.scale, O.depth, O.clipped ? 1 : 0, ...M, Math.hypot(mm[0], mm[1]), Math.hypot(mm[2], mm[3]), Math.atan2(mm[1], mm[0]) / DEG]);
}

// ── Emit ────────────────────────────────────────────────────────────────────

const total = Object.values(counts).reduce((a, b) => a + b, 0);
const header = [
  '// GENERATED by native/tests/gen_golden_transform.ts — do not edit by hand.',
  '// Regenerate:  node native/tests/gen_golden_transform.ts',
  `// Reference: Node ${process.version}, V8 ${process.versions.v8}.`,
  '//',
  '// #ifdef MOTION_XF_DATA: the bit patterns, 4 per line. Otherwise MOTION_XF(kind, offset, n_inputs, n_total):',
  '// data[offset, offset + n_inputs) are the inputs, the rest the TypeScript outputs (KIND in gen_golden_transform.ts).',
  `// ${total} rows: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`,
  '',
];
const dataLines: string[] = [];
for (let i = 0; i < data.length; i += 4) dataLines.push(`${data.slice(i, i + 4).join(', ')},`);
writeFileSync(join(here, 'golden_transform.inc'),
  [...header, '#ifdef MOTION_XF_DATA', ...dataLines, '#else', ...rows, '#endif', ''].join('\n'));
console.log(`wrote golden_transform.inc: ${total} rows`, counts);
