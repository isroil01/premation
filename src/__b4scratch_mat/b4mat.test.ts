import { setupEngine } from '@core/engine/__testHelpers__/harness';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeMaterial } from '@core/scene/material';
import { readNodeFill } from '@core/paint/fill';

test('dump', async () => {
  const h = await setupEngine();
  const r: any = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'rectangle', name: 's', init: [] } as any);
  const id = r.layer ?? r.id ?? r;
  await h.run({ type: 'setLayerSwitches', layers: [id], patch: { threeD: true } } as any).catch((e: any) => console.log('sw', e));
  const node = defaultSceneGraph.getNode(id)!;
  const t: any = await h.query({ type: 'getPropertyTree', layer: id, path: '', depth: 0 } as any);
  const out: string[] = [];
  const walk = (n: any) => { if (/^(material|layer\/fill|geometry)/.test(n.path)) out.push(`${n.path}=${JSON.stringify(n.value)}`); for (const c of n.children ?? []) if (typeof c === 'object') walk(c); };
  for (const n of t.nodes ?? []) walk(n);
  console.log(out.join('\n'));
  console.log(JSON.stringify(readNodeMaterial(node)));
  console.log(JSON.stringify(node.components.map((c) => [c.type, c.props])).slice(0, 1500));
  console.log('fill', JSON.stringify(readNodeFill(node)));
  await h.dispose();
});
