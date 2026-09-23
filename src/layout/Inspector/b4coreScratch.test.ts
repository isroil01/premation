import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import { documentMirror } from '@stores/documentMirror';
import { membersOf } from '@core/mirror/trackIndex';

test('scratch', async () => {
  const h = await setupAppEngine();
  const out: string[] = [];
  for (const kind of ['shape', 'text', 'path'] as const) {
    const { layer } = await h.run({ type: 'createLayer', comp: 'comp_root', kind, name: kind, init: [] } as never) as { layer: string };
    await h.run({ type: 'setLayerSwitches', layers: [layer], patch: { threeD: true } } as never);
    const m = documentMirror();
    out.push(`== ${kind}`);
    const t = m.tree(layer);
    for (const n of t?.nodes.values() ?? []) if (!n.path.startsWith('text/') && !n.path.startsWith('material')) out.push(`${n.path} | ${n.matchName} | ${n.kind} ${n.valueType} d${n.dimensions} [${membersOf(n).join(',')}] ${JSON.stringify(n.value)?.slice(0, 60)}`);
  }
  require('fs').writeFileSync(process.env.SCRATCH_OUT!, out.join('\n'));
  await h.dispose();
});
