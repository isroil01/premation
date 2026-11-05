/**
 * A nested composition with nothing live is transparent. Its layer falls through
 * to a plain quad otherwise, in the comp layer's own default fill: a solid black
 * box over whatever is beneath it.
 *
 * Needs the full engine and a GPU adapter; skipped (with a note) without them.
 */

import type { Command } from '@motion/engine-api';
import { decodePng } from '@core/ai/author/eval/contactSheet';
import { runToolTurn } from '@core/ai/aiTurn';
import { activeCompRootId } from '@core/scene/activeComp';
import { setupAppEngine, sec, settleEdits, type Harness } from './__testHelpers__/appEngine';
import { nativeEngineIsHeadless } from './__testHelpers__/nativeEngine';

jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate'] });
jest.setTimeout(120_000);

const suite = nativeEngineIsHeadless() ? describe.skip : describe;
const BLUE = [0x33, 0x66, 0x99];
const near = (a: readonly number[], b: readonly number[], tol = 3): boolean => b.every((v, c) => Math.abs((a[c] ?? NaN) - v) <= tol);

suite('an empty nested composition', () => {
  let h: Harness;
  let gpu = true;
  let parent = '';

  beforeEach(async () => {
    if (!gpu) return;
    try {
      h = await setupAppEngine({ gpu: true, panels: true });
    } catch (e) {
      gpu = false;
      console.log(`[emptyPrecomp] the engine did not start with a GPU: skipped (${String(e)})`);
      return;
    }
    parent = activeCompRootId() as string;
    await h.run({ type: 'setCompositionSettings', comp: parent, patch: { background: { r: 0.2, g: 0.4, b: 0.6, a: 1 } } } as Command);
  });
  afterEach(async () => {
    if (gpu) await h.dispose();
  });

  const newComp = async (): Promise<string> => (await h.run({
    type: 'createComposition',
    settings: { name: 'Inner', width: 1920, height: 1080, frameRate: { num: 30, den: 1 }, duration: 10 * 705_600_000, background: { r: 1, g: 0, b: 0, a: 1 } },
    fromItems: [],
  } as Command) as unknown as { item: string }).item;
  const nest = async (inner: string): Promise<string> =>
    (await h.run({ type: 'createLayer', comp: parent, kind: 'precomp', source: inner, init: [] } as Command) as unknown as { layer: string }).layer;
  const centre = async (seconds: number): Promise<number[]> => {
    const th = await h.query({ type: 'getThumbnail', item: parent, time: sec(seconds), maxSize: 1920 });
    const d = decodePng(th.data);
    const at = (Math.floor(d.height / 2) * d.width + Math.floor(d.width / 2)) * 4;
    return Array.from(d.data.slice(at, at + 3));
  };

  it('shows the background through it, not a black box', async () => {
    if (!gpu) return;
    await nest(await newComp());
    expect(await centre(0.5)).toEqual(BLUE);
  });

  it('with its only layer not yet started, shows the background until it does', async () => {
    if (!gpu) return;
    const inner = await newComp();
    const { layer } = await h.run({ type: 'createLayer', comp: inner, kind: 'rectangle', name: 'Late', init: [] } as Command) as unknown as { layer: string };
    await h.run({ type: 'setProperty', prop: { layer, path: 'layer/fill' }, value: { kind: 'color', value: { r: 0, g: 1, b: 0, a: 1 } }, time: sec(0) } as Command);
    await h.run({ type: 'trimLayers', layers: [layer], edge: 'in', time: sec(5), ripple: false } as Command);
    await nest(inner);
    expect(await centre(0.5)).toEqual(BLUE);
    expect(near(await centre(6), [0, 255, 0])).toBe(true);
  });

  it.each(['circle', 'lens-flare'])('still draws %s, which paints without any content under it', async (type) => {
    if (!gpu) return;
    const layer = await nest(await newComp());
    await settleEdits();
    const r = await runToolTurn(type, [{ name: 'add_effect', args: { nodeId: layer, type, id: 'f', params: {} } }]);
    expect(r.results[0]!.ok).toBe(true);
    await settleEdits();
    const th = await h.query({ type: 'getThumbnail', item: parent, time: sec(0.5), maxSize: 1920 });
    const d = decodePng(th.data);
    let changed = 0;
    for (let i = 0; i < d.data.length; i += 4 * 97) if (!near(Array.from(d.data.slice(i, i + 3)), BLUE)) changed += 1;
    expect(changed).toBeGreaterThan(0);
    // The rest of the box stays see-through: the black box is not back.
    expect(near(Array.from(d.data.slice(0, 3)), BLUE)).toBe(true);
  });

  it('an empty nested comp on top does not hide a real one beneath it', async () => {
    if (!gpu) return;
    const content = await newComp();
    const { layer } = await h.run({ type: 'createLayer', comp: content, kind: 'rectangle', name: 'R', init: [] } as Command) as unknown as { layer: string };
    await h.run({ type: 'setProperty', prop: { layer, path: 'layer/fill' }, value: { kind: 'color', value: { r: 0, g: 1, b: 0, a: 1 } }, time: sec(0) } as Command);
    await nest(content);
    await nest(await newComp()); // on top: it must not hide what is under it
    expect(near(await centre(0.5), [0, 255, 0])).toBe(true);
  });
});
