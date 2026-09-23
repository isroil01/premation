import { setupEngine, type Harness } from '@core/engine/__testHelpers__/harness';
import { setLayerStyles } from '@core/effects/layerStyles';
import * as fs from 'fs';
jest.useFakeTimers();
let h: Harness;
beforeEach(async () => { h = await setupEngine(); });
afterEach(async () => { await h.dispose(); });
test('dump', async () => {
  const comp = 'comp_root';
  const { layer: t } = await h.run({ type: 'createLayer', comp, kind: 'text', name: 'T', init: [] });
  const { groups: [a] } = await h.run({ type: 'addPropertyGroup', layer: t, parent: 'text/animators', matchName: 'ADBE Text Animator', init: [] });
  await h.run({ type: 'addPropertyGroup', layer: t, parent: `${a}/selectors`, matchName: 'ADBE Text Wiggly Selector', init: [] });
  await h.run({ type: 'addProperties', parent: { layer: t, path: `${a}/props` }, names: ['skewAxis', 'axisGRAD', 'color'] });
  await h.run({ type: 'addMask', layer: t, mode: 'add', inverted: false, name: 'M', path: { vertices: [0, 0, 10, 0, 10, 10], inTangents: [], outTangents: [], closed: true, featherPoints: [] } } as any);
  const { layer: s } = await h.run({ type: 'createLayer', comp, kind: 'solid', name: 'S', init: [] } as any);
  for (const e of ['levels', 'fill', 'gaussian-blur', 'curves', 'set-matte', 'glow']) {
    const r = await h.engine.execute({ type: 'addEffect', layers: [s], effect: e, params: [] } as any);
    if (!r.ok) console.log('addEffect fail', e, r.error);
  }
  setLayerStyles(s, { dropShadow: { enabled: true } } as any);
  const out: string[] = [];
  for (const id of [t, s]) {
    const tree = await h.query({ type: 'getPropertyTree', layer: id, path: '', depth: 0 });
    out.push(...tree.nodes.filter((n: any) => /^(effects|styles|masks|text\/animators|text\/pathOptions)/.test(n.path)).map((n: any) => `${n.path}\t${n.kind}\t${n.matchName}\t${n.name}\t${n.valueType}\t${n.enabled}\t${n.choices?.join('|')}\t${JSON.stringify(n.value ?? null).slice(0, 120)}\t${n.animatable}\t${n.hidden}`));
  }
  fs.writeFileSync(process.env.OUT!, out.join('\n'));
});
