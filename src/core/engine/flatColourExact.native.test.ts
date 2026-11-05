/**
 * Pure white and black come out exact, and a flat colour within a level, under
 * both Blend Colors settings.
 *
 * Two losses, both found through a matte test that read white as 254:
 *  - Gamma blending round-trips each list through sRGB in a float16 target. In
 *    f32 the curve gives 1 as 0.99999994, the target's next step down is 0.99951
 *    (254.87 in 8 bits), and the output dither then took about 17 % of a white
 *    frame to 254.
 *  - The dither's offset reached exactly -0.5 of a step, a tie that dropped about
 *    0.1 % of the pixels of any flat colour by one level, in both modes.
 *
 * Mid-tones are NOT exact, by design: float16 holds them a few hundredths of a
 * level off, and the dither carries some pixels (7-17 % here) across that line.
 * One level, never more, is what is pinned.
 *
 * Needs the full engine and a GPU adapter; skipped (with a note) without them.
 */

import { PNG } from 'pngjs';
import type { Command } from '@motion/engine-api';
import { runToolTurn } from '@core/ai/aiTurn';
import { activeCompRootId } from '@core/scene/activeComp';
import { setupAppEngine, sec, settleEdits, type Harness } from './__testHelpers__/appEngine';
import { nativeEngineIsHeadless } from './__testHelpers__/nativeEngine';

jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate'] });
jest.setTimeout(120_000);

const suite = nativeEngineIsHeadless() ? describe.skip : describe;

suite('flat colours through the output', () => {
  let h: Harness;
  let gpu = true;

  beforeEach(async () => {
    if (!gpu) return;
    try {
      h = await setupAppEngine({ gpu: true, panels: true });
    } catch (e) {
      gpu = false;
      console.log(`[flatColourExact] the engine did not start with a GPU: skipped (${String(e)})`);
      return;
    }
    await h.run({ type: 'setCompositionSettings', comp: activeCompRootId() as string, patch: { width: 1920, height: 1080, duration: sec(4) } } as Command);
  });
  afterEach(async () => {
    if (gpu) await h.dispose();
  });

  /** The frame's distinct RGB triples and how many pixels hold each. */
  async function colours(): Promise<Map<string, number>> {
    await settleEdits();
    const th = await h.query({ type: 'getThumbnail', item: activeCompRootId() as string, time: sec(1), maxSize: 1920 } as never) as { data: Uint8Array };
    const f = PNG.sync.read(Buffer.from(th.data));
    const seen = new Map<string, number>();
    for (let i = 0; i < f.data.length; i += 4) {
      const k = `${f.data[i]},${f.data[i + 1]},${f.data[i + 2]}`;
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    return seen;
  }

  const rect = (id: string, fill: string): { name: string; args: Record<string, unknown> } => ({
    name: 'create_layer',
    args: { id, kind: 'shape', shape: 'rect', name: id, x: 960, y: 540, width: 1920, height: 1080, fill },
  });

  describe.each([['gamma', false], ['linear', true]] as const)('%s blending', (_name, linearBlending) => {
    beforeEach(async () => {
      if (gpu) await h.run({ type: 'setProjectSettings', patch: { linearBlending } } as Command);
    });

    it.each([['white', '#ffffff', '255,255,255'], ['black', '#000000', '0,0,0']])('%s, every pixel exact', async (_label, fill, want) => {
      if (!gpu) return;
      await runToolTurn('flat', [rect('flat', fill)]);
      expect([...(await colours()).keys()]).toEqual([want]);
    });

    it.each([['mid grey', '#808080', [128, 128, 128]], ['a colour', '#336699', [51, 102, 153]]] as const)(
      '%s, every pixel within one level, most of them exact',
      async (_label, fill, want) => {
        if (!gpu) return;
        await runToolTurn('flat', [rect('flat', fill)]);
        const seen = await colours();
        for (const k of seen.keys()) {
          k.split(',').map(Number).forEach((v, c) => expect(Math.abs(v - want[c]!)).toBeLessThanOrEqual(1));
        }
        expect(seen.get(want.join(',')) ?? 0).toBeGreaterThan(1920 * 1080 * 0.8);
      },
    );

    it('white through a precomp: at most a stray pixel in ten thousand, one level off', async () => {
      if (!gpu) return;
      await runToolTurn('nested', [rect('flat', '#ffffff'), { name: 'create_precomp', args: { id: 'T', nodeIds: ['flat'], name: 'T' } }]);
      const seen = await colours();
      expect([...seen.keys()].filter((k) => k !== '255,255,255' && k !== '254,254,254')).toEqual([]);
      expect(seen.get('254,254,254') ?? 0).toBeLessThan((1920 * 1080) / 10_000);
    });

    it('white screened over white, every pixel exact', async () => {
      if (!gpu) return;
      await runToolTurn('screen', [rect('a', '#ffffff'), rect('b', '#ffffff'), { name: 'update_layer', args: { nodeId: 'b', blendMode: 'screen' } }]);
      expect([...(await colours()).keys()]).toEqual(['255,255,255']);
    });
  });
});
