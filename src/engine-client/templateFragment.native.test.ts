/**
 * Templates as engine clients (templateFragment.ts): every registered
 * template's layout + choreography laid into a FragmentBuilder gives the same
 * fragment as the off-document build templateStore.apply used
 * (offDocument.ts buildLayerFragment over the live scene graph) — rows,
 * components, keyframes; the scratch ids are the template's own authored ids
 * in both, so the exposed fields' targets map the same way.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { TEMPLATES } from '@core/template/registry';
import { liveKf } from '@core/template/templates/builders';
import { buildLayerFragment } from '@core/engine/offDocument';
import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { useCompositionStore } from '@stores/compositionStore';
import { decodeFragmentLayers, type FragmentKeyframe, type FragmentLayer } from './fragmentBuilder';
import { buildTemplateFragment } from './templateFragment';

let h: Harness;
beforeEach(async () => {
  h = await setupAppEngine();
});
afterEach(async () => {
  await h.dispose();
});

/** Gradient stop ids come from a module counter (builders.ts `gs_<n>`): only their order matters. */
function stopIds(v: unknown): unknown {
  if (typeof v === 'string') return /^gs_\d+$/.test(v) ? 'gs' : v;
  if (Array.isArray(v)) return v.map(stopIds);
  if (!v || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, stopIds(x)]));
}

/** Legacy fragments spell the default bar out; the builder leaves it to the engine (the whole comp). */
function normalize(layers: FragmentLayer[], compFrames: number): unknown {
  const ids = new Set(layers.map((l) => l.row.id));
  return layers.map((l) => ({
    row: {
      ...l.row,
      parent: l.row.parent && ids.has(l.row.parent) ? l.row.parent : null,
      solo: l.row.solo === true,
      components: l.row.components.map((c) => ({ type: c.type, props: stopIds(c.props) })),
    },
    anim: l.anim
      ? {
          ...l.anim,
          tracks: Object.fromEntries(Object.entries(l.anim.tracks).map(([k, keys]) => [k, keys.map((k) => { const { id: _id, ...rest } = k as FragmentKeyframe & { id?: string }; return rest; })])),
        }
      : null,
    bars: l.bars.length > 0 ? l.bars : [{ start: 0, duration: compFrames, sourceIn: 0, sourceDuration: null }],
  }));
}

describe('templates as engine clients', () => {
  it.each(TEMPLATES.map((t) => [t.id]))('%s: the same fragment as the off-document build', async (id) => {
    const t = TEMPLATES.find((x) => x.id === id)!;
    const comp = 'comp_root';
    const old = (await docView()).layerIdsOfComp(comp);
    if (old.length > 0) await h.run({ type: 'deleteLayers', layers: old });
    const legacy = buildLayerFragment(comp, () => {
      (t.layout as (g: typeof defaultSceneGraph, rootId: string) => void)(defaultSceneGraph, comp);
      t.animate?.(liveKf);
    });
    const mine = buildTemplateFragment(t, comp);
    expect(mine).not.toBeNull();
    expect(legacy).not.toBeNull();
    const c = useCompositionStore.getState().comp();
    const frames = Math.round(c.durationSeconds * c.fps);
    expect(mine!.scratchIds).toEqual(legacy!.scratchIds);
    expect(normalize(decodeFragmentLayers(mine!.fragment), frames)).toEqual(normalize(decodeFragmentLayers(legacy!.fragment), frames));
  });
});
