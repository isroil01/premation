/**
 * A 3D shape layer spread far from its origin by stacked repeaters stays drawn
 * as the camera moves in (CLAUDE.md reliability). Found 2026-10-10 through the
 * AI tools: a 5 px dot at (-1290, -810), repeated 31 × 150 px across and
 * 19 × 150 px down, z 1400, with the camera keyed in from -2666 to 500 —
 * gone from camera z 0 on, nothing on layerErrors. The repeaters grow the
 * layer box to 9000 × 5400, the closer camera raises its raster tier, and the
 * raster's single WriteTexture was over Dawn's 256 MB staging buffer: the
 * upload failed and the texture stayed empty. At full size it was gone at
 * every depth. Uploads go in bands now (render_graph/texture_upload.hpp).
 *
 * Needs a GPU adapter, so it runs only with PREMATION_GPU_TESTS=1 (CI runs the
 * engine with `--no-gpu`). The engine-side regression runs everywhere with a
 * GPU: native/engine/tests/test_render_graph_gpu.cpp.
 */

import { PNG } from 'pngjs';
import type { Command } from '@motion/engine-api';
import { activeCompRootId } from '@core/scene/activeComp';
import { runToolTurn } from '@core/ai/aiTurn';
import { sec, settleEdits, setupAppEngine, type Harness } from './__testHelpers__/appEngine';

jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate'] });

const suite = process.env.PREMATION_GPU_TESTS === '1' ? describe : describe.skip;

/** Camera z, one per second (held). */
const DEPTHS = [-2666, -2000, -1500, -1000, -500, 0, 500];

suite('a 3D repeater lattice as the camera moves in', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setupAppEngine({ gpu: true });
    await h.run({ type: 'setCompositionSettings', comp: 'comp_root', patch: { frameRate: { num: 30, den: 1 }, duration: sec(10) } } as Command);
    await settleEdits();
    const r = await runToolTurn('AI: lattice repro', [
      { name: 'create_layer', args: { id: 'l', kind: 'shape', shape: 'ellipse', name: 'Lattice', width: 5, height: 5, x: -1290, y: -810, fill: '#ece8df' } },
      { name: 'update_layer', args: { nodeId: 'l', threeD: true, z: 1400 } },
      { name: 'add_repeater', args: { nodeId: 'l', copies: 31, positionX: 150, rotation: 0 } },
      { name: 'add_repeater', args: { nodeId: 'l', copies: 19, positionY: 150, rotation: 0 } },
      { name: 'create_layer', args: { id: 'cam', kind: 'camera', name: 'Camera' } },
      { name: 'set_keyframes', args: { keyframes: DEPTHS.map((z, i) => ({ nodeId: 'cam', prop: 'z', t: i, value: z, easing: 'hold' })) } },
    ]);
    expect(r.results.filter((x) => !x.ok).map((x) => x.content)).toEqual([]);
    await settleEdits();
  }, 60_000);
  afterAll(async () => { await h.dispose(); });

  /** Pixels of the frame at `t` with red over 80 (the lattice's dots; the comp is black). */
  async function lit(t: number, maxSize: number): Promise<number> {
    const th = await h.query({ type: 'getThumbnail', item: activeCompRootId() as string, time: sec(t), maxSize });
    expect(th.format).toBe('png');
    const png = PNG.sync.read(Buffer.from(th.data));
    let n = 0;
    for (let i = 0; i < png.data.length; i += 4) if (png.data[i]! > 80) n++;
    return n;
  }

  it('is drawn at every camera depth', async () => {
    // Before: [676, 708, 546, 502, 434, 0, 0].
    const seen: Array<{ z: number; lit: boolean }> = [];
    for (let i = 0; i < DEPTHS.length; i++) seen.push({ z: DEPTHS[i]!, lit: (await lit(i + 0.5, 640)) > 100 });
    expect(seen).toEqual(DEPTHS.map((z) => ({ z, lit: true })));
  }, 120_000);

  it('is drawn in a full-size frame, far and near', async () => {
    // Before: 0 at every depth (a full-size raster is over the staging limit even far away).
    for (const i of [0, DEPTHS.length - 1]) expect({ z: DEPTHS[i], lit: (await lit(i + 0.5, 1920)) > 100 }).toEqual({ z: DEPTHS[i], lit: true });
  }, 120_000);

  it('is drawn, not skipped: nothing on layerErrors', async () => {
    const { errors } = await h.query({ type: 'getLayerErrors', comp: activeCompRootId() as string });
    expect(errors).toEqual([]);
  });
});
