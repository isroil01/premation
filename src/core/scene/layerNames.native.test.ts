import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { documentMirror } from '@stores/documentMirror';
import { uniqueLayerName } from './layerNames';

/**
 * Three drawn rectangles were three rows called "Rectangle" — in the timeline,
 * the Layers panel, every parent menu and every expression that names a layer.
 * The names are the document's (the mirror), so the layers are made through the engine.
 */
let h: Harness;

const add = async (name: string): Promise<void> => {
  await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'shape', name, init: [] });
  await documentMirror().whenIdle();
};

beforeEach(async () => {
  h = await setupAppEngine();
  await documentMirror().whenIdle();
});
afterEach(async () => {
  await h.dispose();
});

describe('uniqueLayerName', () => {
  it('keeps the bare word for the first layer of its kind', async () => {
    expect(uniqueLayerName('Rectangle')).toBe('Rectangle');
  });

  it('numbers the ones after it', async () => {
    await add('Rectangle');
    expect(uniqueLayerName('Rectangle')).toBe('Rectangle 2');
    await add('Rectangle 2');
    expect(uniqueLayerName('Rectangle')).toBe('Rectangle 3');
  });

  it('fills a gap a deleted layer left, and ignores other names', async () => {
    await add('Rectangle'); await add('Rectangle 3'); await add('Star');
    expect(uniqueLayerName('Rectangle')).toBe('Rectangle 2');
    expect(uniqueLayerName('Circle')).toBe('Circle');
  });
});
