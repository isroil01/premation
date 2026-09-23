import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import { catalogFor } from '@core/engine/props';
import { unwrap } from '@motion/engine-api';

test('scratch polystar', async () => {
  const h = await setupAppEngine();
  const { layer: s } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'shape', name: 'S', init: [] });
  defaultSceneGraph.setFxKey(s, 'polystar', { starType: 'star', points: 5, rotation: 0, outerRadius: 100, innerRadius: 50, outerRoundness: 0, innerRoundness: 0 });
  console.log(catalogFor(s).props.filter((b) => b.path.startsWith('contents')).map((b) => `${b.path} ${b.valueType} ${b.special ?? ''}`).join('\n'));
  const r = await h.engine.execute({ type: 'setProperty', prop: { layer: s, path: 'contents/polystar/points' }, value: { kind: 'scalar', value: 7 } });
  console.log(JSON.stringify(r).slice(0, 300));
  const r2 = await h.engine.execute({ type: 'setProperty', prop: { layer: s, path: 'contents/polystar/type' }, value: { kind: 'choice', value: 'polygon' } });
  console.log(JSON.stringify(r2).slice(0, 300));
  console.log(JSON.stringify(defaultSceneGraph.getNode(s)!.components));
  void unwrap;
  await h.dispose();
});
