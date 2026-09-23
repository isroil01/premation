import { defaultAnimation } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import { catalogFor } from '@core/engine/props';
import { readPathOps } from '@core/scene/pathOps';

test('scratch', async () => {
  const h = await setupAppEngine();
  const { layer } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'particle', name: 'P', init: [] });
  defaultAnimation.setKeyframe(layer, 'particle.birthRate', 0, 5);
  const cat = catalogFor(layer);
  console.log(cat.props.filter((b) => b.path.includes('particle')).map((b) => `${b.path} ${b.valueType} ${b.members.join(',')}`).join('\n'));
  const before = h.doc();
  await h.run({ type: 'setProperty', prop: { layer, path: 'layer/particle.speed' }, value: { kind: 'scalar', value: 77 } });
  await h.run({ type: 'setProperty', prop: { layer, path: 'layer/particle.colorMid' }, value: { kind: 'color', value: { r: 1, g: 0, b: 0, a: 1 } } });
  await h.run({ type: 'setAnimated', prop: { layer, path: 'layer/particle.lifetime' }, animated: true, time: 0 });
  console.log(JSON.stringify(defaultSceneGraph.getNode(layer)!.components.find((c) => c.type === 'fx')!.props.particle));
  console.log(JSON.stringify(defaultAnimation.getTrackKeyframes(layer, 'particle.lifetime')));
  await h.run({ type: 'undo' }); await h.run({ type: 'undo' }); await h.run({ type: 'undo' });
  expect(h.doc()).toBe(before);

  const { layer: s } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'shape', name: 'S', init: [] });
  const r = await h.run({ type: 'addPropertyGroup', layer: s, parent: 'contents', matchName: 'pathop:zigzag', init: [] });
  const r2 = await h.run({ type: 'addPropertyGroup', layer: s, parent: 'contents', matchName: 'pathop:repeater', init: [] });
  console.log(JSON.stringify(r), JSON.stringify(r2));
  console.log(catalogFor(s).props.filter((b) => b.path.startsWith('contents')).map((b) => `${b.path} ${b.valueType} ${b.special ?? ''}`).join('\n'));
  const op = readPathOps(defaultSceneGraph.getNode(s)!)[0]!;
  const b2 = h.doc();
  await h.run({ type: 'setProperty', prop: { layer: s, path: `contents/${op.id}/type` }, value: { kind: 'choice', value: 'roundCorners' } });
  console.log(JSON.stringify(readPathOps(defaultSceneGraph.getNode(s)!)));
  await h.run({ type: 'undo' });
  expect(h.doc()).toBe(b2);
  await h.dispose();
});
