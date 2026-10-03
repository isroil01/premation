/**
 * The Lottie import as an engine client (lottieFragment.ts): every bundled
 * Lottie builds a fragment the engine takes — every layer pasted, as one
 * undoable entry — and trim paths, strokes, track mattes and layer windows
 * come through. (The parity with the legacy off-document importer went with
 * the page replica, block 3.)
 */

import { unwrap } from '@motion/engine-api';
import { useCompositionStore } from '@stores/compositionStore';
import { LOTTIE_DESIGN_CENTER, LOTTIE_ITEMS } from '@core/library/lottieLibrary';
import { planLottieImport, type LottieJson } from '@core/lottie/lottieImport';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { decodeFragmentLayers } from './fragmentBuilder';
import { buildLottieFragment } from './lottieFragment';

let h: Harness;
beforeEach(async () => {
  h = await setupAppEngine();
});
afterEach(async () => {
  await h.dispose();
});

/** The fragment pastes through the engine as one entry with every built layer; undo is exact. */
async function expectPastes(built: { fragment: unknown; scratchIds: string[] } | null): Promise<void> {
  expect(built).not.toBeNull();
  const before = await h.doc();
  const ids = unwrap(await h.client.execute({ type: 'pasteLayers', comp: 'comp_root', fragment: built!.fragment as never })).layers;
  expect(ids).toHaveLength(built!.scratchIds.length);
  await h.run({ type: 'undo' });
  expect(await h.doc()).toBe(before);
}

describe('Lottie import as an engine client', () => {
  it.each(LOTTIE_ITEMS.map((i) => [i.id]))('%s: a fragment the engine takes', async (lottieId) => {
    const item = LOTTIE_ITEMS.find((i) => i.id === lottieId)!;
    const comp = useCompositionStore.getState().comp();
    const mine = buildLottieFragment(planLottieImport(item.doc), {
      offset: { x: comp.width / 2 - LOTTIE_DESIGN_CENTER, y: comp.height / 2 - LOTTIE_DESIGN_CENTER },
      compFps: comp.fps,
      compDurationSeconds: comp.durationSeconds,
    });
    await expectPastes(mine.built);
  });

  it('trim paths, a stroke, a track matte and a layer window: built and taken by the engine', async () => {
    type L = NonNullable<LottieJson['layers']>[number];
    const ks = { o: { a: 0, k: 100 }, p: { a: 0, k: [200, 200, 0] }, a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] }, r: { a: 0, k: 0 } };
    const rect = (ind: number, nm: string, extra: Record<string, unknown>): L => ({
      ty: 4, ind, nm, ip: 0, op: 60, ks,
      shapes: [{ ty: 'gr', it: [
        { ty: 'rc', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [120, 80] }, r: { a: 0, k: 8 } },
        { ty: 'fl', c: { a: 0, k: [0.2, 0.6, 1, 1] }, o: { a: 0, k: 100 } },
        { ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
      ] }],
      ...extra,
    } as unknown as L);
    const line: L = {
      ty: 4, ind: 1, nm: 'line', ip: 10, op: 40, ks,
      shapes: [{ ty: 'gr', it: [
        { ty: 'sh', ks: { a: 0, k: { i: [[0, 0], [0, 0]], o: [[0, 0], [0, 0]], v: [[-100, 0], [100, 0]], c: false } } },
        { ty: 'st', c: { a: 0, k: [1, 1, 1, 1] }, o: { a: 0, k: 100 }, w: { a: 1, k: [{ t: 0, s: [2] }, { t: 30, s: [8] }] } },
        { ty: 'tm', s: { a: 0, k: 0 }, e: { a: 1, k: [{ t: 0, s: [0] }, { t: 60, s: [100] }] }, o: { a: 0, k: 90 }, m: 1 },
        { ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
      ] }],
    } as unknown as L;
    const json: LottieJson = {
      fr: 30, op: 60, w: 400, h: 400,
      layers: [line, rect(2, 'matte', { td: 1 }), rect(3, 'masked', { tt: 1 })],
    };
        const comp = useCompositionStore.getState().comp();
    const mine = buildLottieFragment(planLottieImport(json), { offset: { x: 5, y: 7 }, compFps: comp.fps, compDurationSeconds: comp.durationSeconds });
    const decoded = decodeFragmentLayers(mine.built!.fragment);
    expect(decoded.some((l) => JSON.stringify(l.row).includes('"pathOps"'))).toBe(true);
    expect(decoded.some((l) => JSON.stringify(l.row).includes('"matte"'))).toBe(true);
    // The line's layer window (frames 10–40) is its bar.
    expect(decoded.some((l) => l.bars.some((b) => b.start === 10 && b.duration === 30))).toBe(true);
    await expectPastes(mine.built);
  });

  it('pastes as ONE undoable entry', async () => {
    const item = LOTTIE_ITEMS[0]!;
    const comp = useCompositionStore.getState().comp();
    const { built } = buildLottieFragment(planLottieImport(item.doc), { compFps: comp.fps, compDurationSeconds: comp.durationSeconds });
    const entries = (await historyLabels()).length;
    const before = (await h.doc());
    const ids = unwrap(await h.client.execute({ type: 'pasteLayers', comp: 'comp_root', fragment: built!.fragment })).layers;
    expect(ids).toHaveLength(built!.scratchIds.length);
    expect((await historyLabels()).length).toBe(entries + 1);
    await h.run({ type: 'undo' });
    expect((await h.doc())).toEqual(before);
  });
});
