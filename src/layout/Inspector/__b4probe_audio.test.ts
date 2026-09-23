import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { documentMirror } from '@stores/documentMirror';
import { engineIdle } from '@core/engine/engineInstance';

type P = { path: string; value?: unknown };
const flat = (t: unknown): P[] => { const o: P[] = []; const w = (x: unknown): void => { if (Array.isArray(x)) { x.forEach(w); return; } if (x && typeof x === 'object') { const r = x as Record<string, unknown>; if (typeof r.path === 'string') o.push(r as P); for (const v of Object.values(r)) if (v && typeof v === 'object') w(v); } }; w(t); return o; };
test('probe', async () => {
  const h = await setupAppEngine();
  const { items: [sound, clip] } = await h.run({ type: 'importFiles', files: [
    { path: 'C:/m/vo.wav', asSequence: false, createComposition: false },
    { path: 'C:/m/v.mp4', asSequence: false, createComposition: false },
  ] });
  const { layer: a } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'audio', source: sound!, init: [] }) as { layer: string };
  const { layer: v } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'video', source: clip!, init: [] }) as { layer: string };
  const node = defaultSceneGraph.getNode(a)!;
  const ac = node.components.find((c) => c.type === 'Audio')!;
  const out: string[] = [];
  out.push('audio props ' + JSON.stringify(ac.props));
  defaultSceneGraph.writeProp(a, ac.id, '__level', 50);
  defaultSceneGraph.writeProp(a, ac.id, '__out', undefined);
  await h.run({ type: 'setLayerSwitches', layers: [a], patch: { visible: true } });
  await engineIdle();
  const tree = await h.query({ type: 'getPropertyTree', layer: a, path: '', depth: 0 });
  out.push('tree a ' + JSON.stringify(flat(tree).filter((p) => p.path.startsWith('audio')).map((p) => [p.path, p.value])));
  const m = documentMirror();
  out.push('mirror layer a ' + JSON.stringify(m.layer(a)));
  out.push('item ' + JSON.stringify(m.item?.(sound!) ?? null));
  const vt = await h.query({ type: 'getPropertyTree', layer: v, path: '', depth: 0 });
  out.push('tree v ' + JSON.stringify(flat(vt).filter((p) => p.path.startsWith('audio') || p.path.startsWith('layer/seq')).map((p) => [p.path, p.value])));
  const vn = defaultSceneGraph.getNode(v)!;
  out.push('video comps ' + JSON.stringify(vn.components.map((c) => [c.type, c.props])));
  console.log(out.join('\n'));
  await h.dispose();
});
