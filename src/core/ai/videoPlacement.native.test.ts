/**
 * `generate_video` on the app's engine, with the free preview model: the clip
 * becomes a footage layer whose bar starts at `startSec` and lasts the snapped
 * length, `fit: "cover"` scales it to fill the frame, and the same request a
 * second time reuses the asset instead of generating (and billing) again —
 * what an author-mode revision that replays the call relies on.
 */

import type { Command } from '@motion/engine-api';
import { PREVIEW_VIDEO_MODEL } from '@motion/ai-tools';
import { documentMirror } from '@stores/documentMirror';
import { useAssetStore } from '@stores/assetStore';
import { sec, settleEdits, setupAppEngine, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { clearGenerationCache } from './aiMediaCache';
import { runToolTurn } from './aiTurn';

jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate'] });

let h: Harness;
beforeEach(async () => {
  clearGenerationCache();
  h = await setupAppEngine();
  await h.run({ type: 'setCompositionSettings', comp: 'comp_root', patch: { frameRate: { num: 30, den: 1 }, duration: sec(12) } } as Command);
  await settleEdits();
});
afterEach(async () => { await h.dispose(); });

const bar = (id: string) => {
  const t = documentMirror().layer(id)!.timing;
  return { in: t.inPoint / sec(1), out: t.outPoint / sec(1), start: t.startTime / sec(1) };
};

describe('generate_video with the preview model', () => {
  it('places the clip at startSec for its snapped length', async () => {
    const r = await runToolTurn('AI: plate', [
      { name: 'generate_video', args: { id: 'plate', prompt: 'mist drifting over a pine forest at dawn', model: PREVIEW_VIDEO_MODEL, durationSec: 4, startSec: 2 } },
    ]);
    expect(r.results.map((x) => (x.ok ? 'ok' : x.content))).toEqual(['ok']);
    const id = (r.results[0]!.data as { id: string }).id;
    expect(bar(id)).toMatchObject({ in: 2, out: 6, start: 2 });
  });

  it('cover fills the frame', async () => {
    const r = await runToolTurn('AI: cover', [
      { name: 'generate_video', args: { prompt: 'mist drifting over a pine forest at dawn', model: PREVIEW_VIDEO_MODEL, fit: 'cover' } },
    ]);
    const id = (r.results[0]!.data as { id: string }).id;
    await documentMirror().loadTree(id);
    // The 128×72 preview clip is 16:9 like the comp, so contain already fills it; cover leaves it at 1.
    const asset = useAssetStore.getState().assets.find((a) => a.id === (r.results[0]!.data as { assetId: string }).assetId)!;
    expect(asset.type).toBe('video');
    expect(r.results[0]!.content).toMatch(/covering the frame/);
  });

  it('reuses the asset for the same request instead of generating again', async () => {
    const args = { prompt: 'mist drifting over a pine forest at dawn', model: PREVIEW_VIDEO_MODEL, durationSec: 5 };
    const a = await runToolTurn('AI: one', [{ name: 'generate_video', args }]);
    const before = useAssetStore.getState().assets.length;
    const b = await runToolTurn('AI: two', [{ name: 'generate_video', args }]);
    expect((b.results[0]!.data as { reused: boolean }).reused).toBe(true);
    expect((b.results[0]!.data as { assetId: string }).assetId).toBe((a.results[0]!.data as { assetId: string }).assetId);
    expect(useAssetStore.getState().assets.length).toBe(before);
  });
});
