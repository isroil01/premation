/**
 * The mirror's effect stack (core/mirror/effects.ts) against the engine's own
 * `getNodeEffects` — on the app engine, for one effect of every parameter
 * type, with Compositing Options set on one of them.
 */

import { defaultAnimation } from '@motion/animation';
import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { EFFECT_DEFS, getNodeEffects, paramsOf, type EffectParamDef } from '@core/effects/effects';
import { documentMirror, resetDocumentMirror } from '@stores/documentMirror';
import { mirrorEffectHeaders, mirrorEffects } from './effects';

jest.useFakeTimers();

let h: Harness & { engine: LocalEngine };
let s: Scene;
beforeEach(async () => {
  h = await setupAppEngine();
  s = await buildScene(h);
  resetDocumentMirror();
});
afterEach(async () => {
  await h.dispose();
  defaultAnimation.clear();
});

const TYPES: ReadonlyArray<EffectParamDef['type']> = ['number', 'color', 'checkbox', 'enum', 'curve', 'layer', 'maskPath'];

const norm = (v: unknown): unknown => (typeof v === 'string' && /^#[0-9a-f]{6}(ff)?$/i.test(v) ? v.toLowerCase().slice(0, 7) : v);

test('mirrorEffects reads the stack getNodeEffects holds: order, switches, params, compositing', async () => {
  // One effect per parameter type (the first registry entry that declares one).
  const types = new Set<string>();
  for (const t of TYPES) {
    const def = EFFECT_DEFS.find((d) => d.params.some((p) => p.type === t));
    if (def) types.add(def.type);
  }
  for (const type of types) await h.run({ type: 'addEffect', layers: [s.A], effect: type, params: [] });
  const stack = getNodeEffects(s.A);
  const second = stack[1]!;
  await h.run({ type: 'setGroupEnabled', groups: [{ layer: s.A, path: `effects/${second.id}` }], enabled: false });
  await h.run({ type: 'setProperty', prop: { layer: s.A, path: `effects/${second.id}/compositing/opacity` }, value: { kind: 'scalar', value: 40 } });
  await h.run({ type: 'setProperty', prop: { layer: s.A, path: `effects/${second.id}/compositing/label` }, value: { kind: 'string', value: '#e24a4a' } });
  await engineIdle();

  const m = documentMirror();
  const tree = m.tree(s.A);
  const legacy = getNodeEffects(s.A);
  expect(mirrorEffectHeaders(tree).map((e) => [e.id, e.type, e.enabled])).toEqual(legacy.map((e) => [e.id, e.type, e.enabled !== false]));

  expect(legacy.length).toBeGreaterThanOrEqual(types.size);
  expect(legacy[1]).toMatchObject({ enabled: false, opacity: 40, labelColor: '#e24a4a' });
  const mirrored = mirrorEffects(tree);
  expect(mirrored.map((e) => e.id)).toEqual(legacy.map((e) => e.id));
  for (const [i, e] of legacy.entries()) {
    const got = mirrored[i]!;
    expect(got.opacity).toBe(e.opacity);
    expect(got.maskId).toBe(e.maskId);
    expect(got.labelColor).toBe(e.labelColor);
    const want = paramsOf(e);
    const have = paramsOf(got);
    for (const [key, v] of Object.entries(want)) {
      if (typeof v === 'number') expect(have[key]).toBeCloseTo(v, 6);
      else expect(norm(have[key])).toEqual(norm(v));
    }
  }
});
