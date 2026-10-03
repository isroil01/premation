/**
 * Inserted layers keep their links when the ENGINE pastes them: a Lottie's
 * parenting and track mattes point at the pasted copies (pasteLayers remaps
 * every id inside the fragment), and a template lands as ONE entry whose
 * fields follow the new ids. (The off-document `insertBuiltLayers` builders
 * this file used to sweep went with the page replica, block 3; each builder's
 * fragment is pinned in src/engine-client/*Fragment.native.test.ts.)
 */

import { unwrap } from '@motion/engine-api';
import { LOTTIE_ITEMS } from '@core/library/lottieLibrary';
import { planLottieImport } from '@core/lottie/lottieImport';
import { readMatte } from '@core/effects/matte';
import { useTemplateStore } from '@stores/templateStore';
import { useCompositionStore } from '@stores/compositionStore';
import { TEMPLATES } from '@core/template/registry';
import { buildLottieFragment } from '@/engine-client/lottieFragment';
import { setupAppEngine, historyLabels } from '../__testHelpers__/appEngine';
import { docView } from '../__testHelpers__/docView';
import type { Harness } from '../__testHelpers__/appEngine';

let h: Harness;
beforeEach(async () => {
  h = await setupAppEngine();
});
afterEach(async () => {
  await h.dispose();
});

it('a Lottie with parenting and track mattes keeps them on the pasted copies', async () => {
  // Every bundled item whose importer produced links: the copies' links point at copies.
  const comp = useCompositionStore.getState().comp();
  let parented = 0;
  for (const item of LOTTIE_ITEMS) {
    const { built } = buildLottieFragment(planLottieImport(item.doc), { compFps: comp.fps, compDurationSeconds: comp.durationSeconds });
    const ids = unwrap(await h.client.execute({ type: 'pasteLayers', comp: 'comp_root', fragment: built!.fragment })).layers;
    const set = new Set(ids);
    const view = await docView();
    for (const id of ids) {
      const n = view.getNode(id)!;
      if (n.parent !== 'comp_root') { expect(set.has(n.parent!)).toBe(true); parented += 1; }
      const fx = n.components.find((c) => c.type === 'fx')?.props;
      const m = readMatte(fx?.matte);
      if (m?.sourceId) expect(set.has(m.sourceId)).toBe(true);
    }
  }
  expect(parented).toBeGreaterThan(0);
});

it('a template: comp settings + layers as ONE entry; the fields follow the new ids; undo is exact', async () => {
  const t = TEMPLATES[0]!;
  const doc = (await h.doc());
  const entries = (await historyLabels()).length;
  await useTemplateStore.getState().apply(t.id);
  expect((await historyLabels()).length).toBe(entries + 1);
  const active = useTemplateStore.getState().active!;
  const stack = new Set((await docView()).layerIdsOfComp('comp_root'));
  for (const f of active.fields) expect(stack.has(f.target.nodeId)).toBe(true);
  await h.run({ type: 'undo' });
  expect((await h.doc())).toEqual(doc);
  useTemplateStore.getState().exit();
});
