/**
 * The SVG document layer as an engine client (svgFragment.ts): one layer
 * holding the sanitized markup with its ids scoped to the layer, placed where
 * asked — and it pastes as one undoable entry.
 */

import { unwrap } from '@motion/engine-api';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { useCompositionStore } from '@stores/compositionStore';
import { decodeFragmentLayers } from './fragmentBuilder';
import { buildSvgLayerFragment } from './svgFragment';

let h: Harness;
beforeEach(async () => {
  h = await setupAppEngine();
});
afterEach(async () => {
  await h.dispose();
});

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80" width="120" height="80">
  <defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs>
  <rect id="box" x="10" y="10" width="100" height="60" fill="url(#g)"/><circle cx="60" cy="40" r="12" fill="#fff"/>
</svg>`;

describe('SVG document layer as an engine client', () => {
  it('builds one layer holding the sanitized markup, its ids scoped to the layer, placed where asked', async () => {
    const c = useCompositionStore.getState().comp();
    const mine = buildSvgLayerFragment(LOGO, 'logo.svg', { compWidth: c.width, compHeight: c.height, x: 300, y: 200 });
    expect(mine).not.toBeNull();
    const decoded = decodeFragmentLayers(mine!.built.fragment);
    expect(decoded).toHaveLength(1);
    const comps = decoded[0]!.row.components;
    // The ids inside the markup are scoped to the layer (a second paste cannot collide).
    expect(JSON.stringify(comps)).toContain(mine!.layer.replace(/[^\w-]/g, '_'));
    expect(JSON.stringify(comps)).toContain('linearGradient');
    const t = comps.find((x) => x.type === 'Transform')!.props as Record<string, unknown>;
    expect([t.x, t.y]).toEqual([300, 200]);
  });

  it('pastes as ONE undoable entry; markup the sanitizer refuses builds nothing', async () => {
    const c = useCompositionStore.getState().comp();
    const made = buildSvgLayerFragment(LOGO, 'logo.svg', { compWidth: c.width, compHeight: c.height });
    const entries = (await historyLabels()).length;
    const before = (await h.doc());
    const ids = unwrap(await h.client.execute({ type: 'pasteLayers', comp: 'comp_root', fragment: made!.built.fragment })).layers;
    expect(ids).toHaveLength(1);
    expect((await historyLabels()).length).toBe(entries + 1);
    await h.run({ type: 'undo' });
    expect((await h.doc())).toEqual(before);
    expect(buildSvgLayerFragment('not svg at all', 'x.svg', { compWidth: 100, compHeight: 100 })).toBeNull();
  });
});
