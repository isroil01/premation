/**
 * Templates as engine clients (templateFragment.ts): every registered
 * template's layout + choreography laid into a FragmentBuilder gives a
 * fragment the engine takes — every authored layer pasted, as one undoable
 * entry — with the template's own authored ids as the scratch ids, so the
 * exposed fields' targets map through the paste. (The parity with the
 * off-document build over the page replica went with the replica, block 3.)
 */

import { unwrap } from '@motion/engine-api';
import { TEMPLATES } from '@core/template/registry';
import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';
import { buildTemplateFragment } from './templateFragment';

let h: Harness;
beforeEach(async () => {
  h = await setupAppEngine();
});
afterEach(async () => {
  await h.dispose();
});

describe('templates as engine clients', () => {
  it.each(TEMPLATES.map((t) => [t.id]))('%s: a fragment the engine takes', async (id) => {
    const t = TEMPLATES.find((x) => x.id === id)!;
    const built = buildTemplateFragment(t, 'comp_root');
    expect(built).not.toBeNull();
    // Every field the template exposes targets a layer it builds.
    for (const f of t.fields) expect(built!.scratchIds).toContain(f.target.nodeId);
    const before = await h.doc();
    const ids = unwrap(await h.client.execute({ type: 'pasteLayers', comp: 'comp_root', fragment: built!.fragment })).layers;
    expect(ids).toHaveLength(built!.scratchIds.length);
    expect((await docView()).layerIdsOfComp('comp_root').length).toBeGreaterThanOrEqual(ids.length);
    await h.run({ type: 'undo' });
    expect(await h.doc()).toBe(before);
  });
});
