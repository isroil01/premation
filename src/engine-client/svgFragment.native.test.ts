/**
 * The SVG document layer as an engine client (svgFragment.ts) builds the SAME
 * fragment as the off-document run of sceneInsert.ts `insertSvgLayer`
 * (offDocument.ts buildLayerFragment): row, components (the sanitized markup
 * with its ids scoped to the layer), fx — the scratch id normalised,
 * including where the sanitizer baked it into the markup. And it pastes as
 * one undoable entry.
 */

import { unwrap } from '@motion/engine-api';
import { insertSvgLayer } from '@core/scene/sceneInsert';
import { buildLayerFragment } from '@core/engine/offDocument';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { useCompositionStore } from '@stores/compositionStore';
import { decodeFragmentLayers, type FragmentLayer } from './fragmentBuilder';
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

function normalize(layers: FragmentLayer[], compFrames: number): unknown {
  const ids = layers.map((l) => l.row.id);
  const swap = (s: string): string => {
    let out = s;
    ids.forEach((id, i) => {
      out = out.split(id.replace(/[^\w-]/g, '_')).join(`L${i}`).split(id).join(`L${i}`);
    });
    return out;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return swap(v);
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== 'object') return v;
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
  };
  return layers.map((l) => ({
    row: {
      ...(walk(l.row) as Record<string, unknown>),
      parent: null,
      solo: l.row.solo === true,
      components: l.row.components.map((c) => ({ type: c.type, props: walk(c.props) })),
    },
    anim: l.anim,
    bars: l.bars.length > 0 ? l.bars : [{ start: 0, duration: compFrames, sourceIn: 0, sourceDuration: null }],
  }));
}

describe('SVG document layer as an engine client', () => {
  it('builds the same fragment as insertSvgLayer off-document', async () => {
    const c = useCompositionStore.getState().comp();
    const legacy = buildLayerFragment('comp_root', () => insertSvgLayer(LOGO, 'logo.svg', { x: 300, y: 200 }));
    const mine = buildSvgLayerFragment(LOGO, 'logo.svg', { compWidth: c.width, compHeight: c.height, x: 300, y: 200 });
    expect(legacy).not.toBeNull();
    expect(mine).not.toBeNull();
    const frames = Math.round(c.durationSeconds * c.fps);
    const decoded = decodeFragmentLayers(mine!.built.fragment);
    // The ids inside the markup are scoped to the layer.
    expect(JSON.stringify(decoded[0]!.row.components)).toContain(mine!.layer.replace(/[^\w-]/g, '_'));
    expect(normalize(decoded, frames)).toEqual(normalize(decodeFragmentLayers(legacy!.fragment), frames));
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
