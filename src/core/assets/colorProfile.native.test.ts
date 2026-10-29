/**
 * Interpret Footage ▸ Color ▸ Assign Profile on the C++ engine: a colour space
 * (by its RenderColorSpace name) stored on the item over the file's own tags,
 * reported back, cleared by `auto`, refused by name when it is not one — one
 * undo entry each.
 */

import { setupAppEngine, type Harness } from '@core/engine/__testHelpers__/appEngine';

let h: Harness;
let item = '';

beforeEach(async () => {
  h = await setupAppEngine();
  item = (await h.run({ type: 'importFiles', files: [{ path: '/footage/drone_slog3.mov', asSequence: false, createComposition: false }] })).items[0]!;
});
afterEach(async () => { await h.dispose(); });

async function profile(): Promise<string> {
  const r = await h.query({ type: 'getItems', items: [item] });
  return (r.items[0] as unknown as { interpretation: { colorProfile: string } }).interpretation.colorProfile;
}

it('assigns, reports, clears and undoes a footage colour profile', async () => {
  expect(await profile()).toBe('auto');
  await h.run({ type: 'setInterpretation', items: [item], patch: { colorProfile: 'sLog3SGamut3Cine' } });
  expect(await profile()).toBe('sLog3SGamut3Cine');
  await h.run({ type: 'setInterpretation', items: [item], patch: { colorProfile: 'displayP3' } });
  expect(await profile()).toBe('displayP3');
  await h.run({ type: 'undo' });
  expect(await profile()).toBe('sLog3SGamut3Cine');
  await h.run({ type: 'setInterpretation', items: [item], patch: { colorProfile: 'auto' } });
  expect(await profile()).toBe('auto');
});

it('refuses a name that is not a colour profile', async () => {
  await expect(h.run({ type: 'setInterpretation', items: [item], patch: { colorProfile: 'cineon' } })).rejects.toThrow(/not a colour profile/);
  expect(await profile()).toBe('auto');
});
