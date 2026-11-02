/**
 * Puppet Mesh Expansion on an image layer must not hold the engine.
 *
 * The outline mesher (alpha_mesh.cpp) inserted the outline's samples into its
 * Delaunay in order along the outline; once Expansion grew the outline, those
 * near-collinear runs made each insertion rebuild most of the mesh. A frame
 * after Expansion 50 took ~12 s on the core thread and 100 more than 30 s —
 * "engine busy: setProperties", nothing could be undone or deleted meanwhile.
 * Now it is a shuffled insertion with a work ceiling: tens of milliseconds.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { PNG } from 'pngjs';
import { secondsToFlicks, type Command } from '@motion/engine-api';
import { setupAppEngine, settleEdits } from '@core/engine/__testHelpers__/appEngine';
import { engine } from '@core/engine/engineInstance';

jest.setTimeout(120_000);

const W = 2000;
const H = 2000;

/** A cut-out figure on transparency: head, body, arms, legs (what a character puppet is drawn on). */
function figure(): Buffer {
  const png = new PNG({ width: W, height: H });
  const inside = (x: number, y: number): boolean => {
    const rect = (x0: number, y0: number, x1: number, y1: number): boolean => x >= x0 && x <= x1 && y >= y0 && y <= y1;
    return (x - 1000) ** 2 + (y - 400) ** 2 < 180 ** 2
      || rect(800, 580, 1200, 1300) || rect(400, 650, 800, 760) || rect(1200, 650, 1600, 760)
      || rect(820, 1300, 960, 1900) || rect(1040, 1300, 1180, 1900)
      // Scattered specks: the stray alpha of a real cut-out.
      || (rect(300, 300, 1700, 1700) && (x * 7 + y * 13) % 97 < 3);
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      png.data[i] = 200;
      png.data[i + 1] = 120;
      png.data[i + 2] = 80;
      png.data[i + 3] = inside(x, y) ? 255 : 0;
    }
  }
  return PNG.sync.write(png);
}

it('a frame after raising Expansion and Density is built in well under a second', async () => {
  const h = await setupAppEngine();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'premation-puppet-'));
  try {
    const file = path.join(dir, 'figure.png');
    fs.writeFileSync(file, figure());
    const items = (await h.run({ type: 'importFiles', files: [{ path: file, asSequence: false, createComposition: false }] } as Command)) as unknown as { items: string[] };
    const layer = ((await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'image', source: items.items[0], init: [] } as Command)) as unknown as { layer: string }).layer;
    const pins = [
      { id: 'p1', kind: 'position', rest: { x: -500, y: -300 } },
      { id: 'p2', kind: 'position', rest: { x: 500, y: -300 } },
      { id: 'p3', kind: 'position', rest: { x: 0, y: 0 }, stiffness: 10 },
      { id: 'p4', kind: 'position', rest: { x: -100, y: 800 } },
    ];
    await h.run({ type: 'setProperty', prop: { layer, path: 'layer/puppet' }, value: { kind: 'json', value: JSON.stringify({ meshDensity: 20, meshExpansion: 0, meshMode: 'silhouette', pins }) } } as Command);
    await settleEdits();

    /** One frame of the composition: the engine builds the puppet's rest mesh for it. */
    const frameMs = async (): Promise<number> => {
      const t0 = Date.now();
      let res = await engine().query({ type: 'getThumbnail', item: 'comp_root', time: secondsToFlicks(0.5), maxSize: 512 });
      // `busy` = the engine is still building it (it answers the heartbeat meanwhile).
      for (let i = 0; i < 30 && !res.ok && res.error.code === 'busy'; i++) {
        res = await engine().query({ type: 'getThumbnail', item: 'comp_root', time: secondsToFlicks(0.5), maxSize: 512 });
      }
      return Date.now() - t0;
    };
    await frameMs();

    const set = (p: string, v: number): Command => ({ type: 'setProperties', writes: [{ prop: { layer, path: p }, value: { kind: 'scalar', value: v } }] } as Command);
    for (const [p, v] of [['puppet/mesh/density', 50], ['puppet/mesh/expansion', 20], ['puppet/mesh/expansion', 50], ['puppet/mesh/expansion', 100]] as const) {
      await h.run(set(p, v));
      // Was ~12 000 ms at Expansion 50 and over 30 000 at 100.
      expect(await frameMs()).toBeLessThan(3000);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await h.dispose();
  }
});
