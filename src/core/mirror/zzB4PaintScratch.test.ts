import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import { documentMirror } from '@stores/documentMirror';
import { engineIdle } from '@core/engine/engineInstance';

it('corners', async () => {
  const h = await setupAppEngine();
  const res = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'rectangle', name: 'r', init: [] } as never);
  const id = (res as { layer: string }).layer;
  await h.run({ type: 'setProperty', prop: { layer: id, path: 'layer/cornerRadius' }, value: { kind: 'scalar', value: 20 } } as never);
  await engineIdle();
  const m = documentMirror();
  m.tree(id);
  for (const p of ['layer/cornerRadius', 'layer/cornerRadiusTL', 'layer/cornersLinked']) console.log('P', p, JSON.stringify(m.property(id, p)?.value));
  await h.dispose();
});
