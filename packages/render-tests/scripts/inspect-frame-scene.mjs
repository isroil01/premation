#!/usr/bin/env node
/**
 * Summarise exported RenderFrameFiles (.artifacts/scenes/<scene>/<frame>.pfs) —
 * which FrameScene features each golden scene exercises. The D2 porting order
 * comes from this histogram.
 *
 *   node packages/render-tests/scripts/inspect-frame-scene.mjs [dir] [--scene id] [--dump]
 */

import { build } from 'esbuild';
import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--')) ?? path.join(here, '..', '.artifacts', 'scenes');
const only = args.includes('--scene') ? args[args.indexOf('--scene') + 1] : null;
const dump = args.includes('--dump');

const tmp = mkdtempSync(path.join(tmpdir(), 'pfs-'));
try {
  const out = path.join(tmp, 'codec.mjs');
  await build({ entryPoints: [path.join(root, 'packages/engine-api/src/generated/codec.ts')], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' });
  const { codecs } = await import(pathToFileURL(out).href);

  const features = new Map();
  const bump = (k, scene) => {
    if (!features.has(k)) features.set(k, new Set());
    features.get(k).add(scene);
  };
  const walk = (r, scene) => {
    bump(`kind:${r.kind}`, scene);
    if (r.blend !== 'normal') bump(`blend:${r.blend}`, scene);
    if (r.advancedBlend) bump('advancedBlend', scene);
    if (r.preserveTransparency) bump('preserveTransparency', scene);
    if (r.sdf) bump(`sdf:${r.sdf.shape}`, scene);
    if (r.colorMatrix) bump('colorMatrix', scene);
    if (r.maskTextureKey) bump('maskTexture', scene);
    if (r.lutTextureKey) bump('lut', scene);
    if (r.adjustment) bump('adjustment', scene);
    if (r.matte) bump('matte', scene);
    if (r.motionSamples.length > 1) bump('motionBlur', scene);
    if (r.cornerPin.length) bump('cornerPin', scene);
    if (r.glass) bump('glass', scene);
    if (r.backdropBlur) bump('backdropBlur', scene);
    if (r.generator) bump('generator', scene);
    if (r.deformedMesh) bump('deformedMesh', scene);
    if (r.extrudedMesh) bump('extrudedMesh', scene);
    if (r.threeD) bump('threeD', scene);
    if (r.lightWash) bump('lightWash', scene);
    if (r.sampling === 'nearest') bump('sampling:nearest', scene);
    if (r.precomp) bump(r.precomp.camera3d ? 'precomp:3d' : r.precomp.flatWidth ? 'precomp:flat' : 'precomp', scene);
    for (const e of r.effects) bump(`fx:${e.type}`, scene);
    for (const c of r.precompChildren) walk(c, scene);
  };
  const scenes = (await fs.readdir(dir)).filter((s) => !only || s === only).sort();
  for (const s of scenes) {
    const frames = (await fs.readdir(path.join(dir, s))).filter((f) => f.endsWith('.pfs'));
    for (const f of frames) {
      const bytes = new Uint8Array(await fs.readFile(path.join(dir, s, f)));
      const file = codecs.RenderFrameFile.decode(bytes);
      if (dump) {
        const blobs = file.blobs.map((b) => ({ ...b, pixels: `<${b.pixels.length} bytes>` }));
        const strip = (k, v) => (v instanceof Uint8Array ? `<${v.length} bytes>` : v);
        console.log(JSON.stringify({ ...file, blobs }, strip, 1));
      }
      if (file.scene.camera3d) bump('scene:camera3d', s);
      if (file.scene.lights3d.length) bump('scene:lights3d', s);
      if (file.scene.envMap) bump('scene:envMap', s);
      if (file.scene.ssao?.enabled) bump('scene:ssao', s);
      if (file.view.overlaysActive) bump('view:overlays', s);
      if (file.view.workingSpace !== 'srgbLinear' || file.view.displayTransform !== 'srgb') bump('view:colorPipeline', s);
      for (const b of file.blobs) {
        bump(`blob:${b.format}`, s);
        if (b.mipmapped) bump('blob:mipmapped', s);
      }
      for (const r of file.scene.renderables) walk(r, s);
    }
  }
  if (!dump) {
    const rows = [...features.entries()].sort((a, b) => b[1].size - a[1].size);
    for (const [k, v] of rows) console.log(`${String(v.size).padStart(4)}  ${k}`);
    console.log(`${scenes.length} scenes`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
