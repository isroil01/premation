/** A deleted composition leaves the mirror's comps / compIds (itemsRemoved), and undo brings it back. */
import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import { documentMirror } from './documentMirror';

it('removing a composition item removes its mirror composition; undo restores it', async () => {
  const h = await setupAppEngine();
  try {
    const m = documentMirror().start();
    const { item } = await h.run({ type: 'createComposition', settings: { name: 'C2' }, fromItems: [] });
    await m.whenIdle();
    expect(m.compIds).toContain(item);
    await h.run({ type: 'removeItems', items: [item], removeUsingLayers: true });
    await m.whenIdle();
    expect(m.compIds).not.toContain(item);
    expect(m.comp(item)).toBeUndefined();
    await h.run({ type: 'undo' });
    await m.whenIdle();
    expect(m.compIds).toContain(item);
  } finally {
    await h.dispose();
  }
});
