/**
 * The animatable gate's explicit list, held against the ENGINE's catalog.
 *
 * `SAMPLED_LAYER_PROPS` is hand-written on purpose (the catalog has no
 * `keyframeable: false` rows, so it cannot be the filter). What keeps a
 * hand-written list honest is this suite: every name in it is keyed through
 * `set_keyframes` on a real layer of a kind that draws it, and must come back
 * as an animatable property with both keys stored. A name the engine does
 * not address fails here, by name, instead of failing every AI run that
 * trusts the gate.
 */

import type { Command } from '@motion/engine-api';
import { documentMirror } from '@stores/documentMirror';
import { propRefForTrack } from '@core/engine/propRefs';
import { sec, settleEdits, setupAppEngine, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';
import { runToolTurn } from './aiTurn';
import { SAMPLED_LAYER_PROPS, isAnimatableProp } from './toolContext';

jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate'] });

let h: Harness;
beforeEach(async () => {
  h = await setupAppEngine();
  await h.run({ type: 'setCompositionSettings', comp: 'comp_root', patch: { frameRate: { num: 30, den: 1 }, duration: sec(5) } } as Command);
  await settleEdits();
});
afterEach(async () => { await h.dispose(); });

/** The layer kind each sampled prop is drawn by (text tracking needs type; the rest a stroked shape). */
const KIND_FOR: Partial<Record<(typeof SAMPLED_LAYER_PROPS)[number], 'text'>> = { letterSpacing: 'text' };

/** Two distinct values within every listed prop's range. */
const VALUES: Partial<Record<(typeof SAMPLED_LAYER_PROPS)[number], [number, number]>> = {
  fillOpacity: [0, 100],
  strokeOpacity: [0, 100],
  strokeWidth: [1, 8],
};

const named = (name: string): string => {
  const m = documentMirror();
  return m.layerIds().find((c) => m.layer(c)?.name === name)!;
};

describe('SAMPLED_LAYER_PROPS', () => {
  it('is admitted by the gate', () => {
    for (const p of SAMPLED_LAYER_PROPS) expect([p, isAnimatableProp(p)]).toEqual([p, true]);
  });

  it.each(SAMPLED_LAYER_PROPS.map((p) => [p]))('%s keys on a real layer and reads back animated', async (prop) => {
    const kind = KIND_FOR[prop] ?? 'shape';
    const [a, b] = VALUES[prop] ?? [0, 12];
    const r = await runToolTurn(`AI: ${prop}`, [
      kind === 'text'
        ? { name: 'create_layer', args: { id: 'l', kind: 'text', name: 'L', text: 'Tracking' } }
        : { name: 'create_layer', args: { id: 'l', kind: 'shape', shape: 'rect', name: 'L', width: 200, height: 120 } },
      ...(kind === 'shape' ? [{ name: 'update_layer', args: { nodeId: 'l', stroke: '#ffffff', strokeWidth: 4 } }] : []),
      { name: 'set_keyframes', args: { keyframes: [{ nodeId: 'l', prop, t: 0, value: a }, { nodeId: 'l', prop, t: 1, value: b }] } },
    ]);
    expect(r.results.filter((x) => !x.ok).map((x) => x.content)).toEqual([]);
    const id = named('L');
    expect(propRefForTrack(id, prop)?.animatable).toBe(true);
    expect(((await docView()).getTrackKeyframes(id, prop) ?? []).length).toBe(2);
  });
});
