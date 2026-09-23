import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import { buildScene } from '@core/engine/__testHelpers__/scene';
import { documentMirror } from '@stores/documentMirror';
import { membersOf } from '@core/mirror/trackIndex';
import { buildPropertyRows } from './buildPropertyRows';
import { buildStaticPropertyTree } from '@core/timeline/propertyTree';
import { sec } from '@core/engine/__testHelpers__/harness';

test('scratch', async () => {
  const h = await setupAppEngine();
  const s = await buildScene(h);
  await h.run({ type: 'addKeyframes', keys: [0, 1].map((i) => ({ prop: { layer: s.A, path: 'transform/scale' }, time: sec(i), value: { kind: 'vec2' as const, value: { x: 50 + i * 10, y: 50 } }, spatialIn: [], spatialOut: [] })) } as never);
  await h.run({ type: 'addKeyframes', keys: [0, 1].map((i) => ({ prop: { layer: s.A, path: 'transform/opacity' }, time: sec(i + 0.5), value: { kind: 'scalar' as const, value: 50 + i * 10 }, spatialIn: [], spatialOut: [] })) } as never);
  const out: string[] = [];
  const m = documentMirror();
  const comp = m.comp(s.comp);
  out.push(`comp layers ${JSON.stringify(comp?.layers)} wa ${JSON.stringify(comp?.settings.workArea)} markers ${JSON.stringify(comp?.markers)}`);
  for (const id of [s.A, s.B, s.T, s.V, s.P]) {
    const l = m.layer(id);
    out.push(`== ${id} ${JSON.stringify(l)}`);
    out.push(`-- keys ${JSON.stringify([...m.layerKeyframes(id)].map(([p, k]) => [p, k.map((x) => [x.id, x.time, x.easing])]))}`);
    const t = m.tree(id);
    out.push(`-- roots ${t?.roots.join(',')}`);
    for (const n of t?.nodes.values() ?? []) out.push(`${n.path} | ${n.name} | ${n.matchName} | ${n.kind} ${n.valueType} anim=${n.animatable}/${n.animated} hidden=${n.hidden} [${membersOf(n).join(',')}] ch=${n.children.length}`);
    out.push('-- static rows');
    for (const r of buildStaticPropertyTree(id)) out.push(`${r.prop} | ${r.label} | ${r.group} | m=[${r.members.join(',')}] v=[${r.valueProps.join(',')}] merged=${r.merged ?? ''} mask=${r.maskTrack ?? ''}`);
    out.push('-- legacy rows');
    for (const r of buildPropertyRows(id)) out.push(`${r.prop} | ${r.label} | ${r.group} | anim=${r.animated} sw=[${r.stopwatchProps?.join(',')}] v=[${r.valueProps?.join(',') ?? ''}] u=${r.valueUnit ?? ''} keys=${r.keyframes.map((k) => `${k.id}@${k.time}`).join(' ')}`);
  }
  require('fs').writeFileSync(process.env.SCRATCH_OUT!, out.join('\n'));
  await h.dispose();
});
