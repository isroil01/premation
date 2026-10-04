/**
 * Audio effects — the preview graph.
 *
 * The page's export mixdown (`audioMixdown`) is gone — the C++ engine renders
 * the exported audio — so the guard that kept the preview and export paths
 * building through one function went with it. What is left is ordinary unit
 * testing of the chain the preview builds.
 *
 * The thing pinned hardest is that an empty chain returns the input node
 * untouched. Existing projects must produce the identical audio graph they did
 * before this file existed; "no effects" has to mean no nodes, not a
 * pass-through gain that quietly changes nothing except the graph shape.
 */

import { readSource } from '@/__testHelpers__/readSource';
import {
  
  hasActiveAudioEffects,
  audioEffectPropPath,
  readAudioEffects,
  
  type AudioEffect,
} from './audioEffects';

const fx = (type: AudioEffect['type'], params: Record<string, number> = {}, over: Partial<AudioEffect> = {}): AudioEffect =>
  ({ id: `${type}-1`, type, params, ...over });

describe('an empty chain changes nothing', () => {

  it('hasActiveAudioEffects agrees', () => {
    expect(hasActiveAudioEffects(undefined)).toBe(false);
    expect(hasActiveAudioEffects([])).toBe(false);
    expect(hasActiveAudioEffects([fx('delay', {}, { enabled: false })])).toBe(false);
    expect(hasActiveAudioEffects([fx('delay')])).toBe(true);
  });
});

describe('chain semantics', () => {

  it('scopes keyframes by effect id, so reordering cannot steal automation', () => {
    expect(audioEffectPropPath('abc', 'gain')).toBe('audiofx.abc.gain');
    expect(audioEffectPropPath('abc', 'gain')).not.toBe(audioEffectPropPath('def', 'gain'));
  });
});

describe('the chain is readable, writable and reachable', () => {
  const node = (props: unknown): Parameters<typeof readAudioEffects>[0] =>
    ({ components: [{ type: 'fx', props: { audioEffects: props } }] });

  it('reads a stored chain', () => {
    const out = readAudioEffects(node([{ id: 'a', type: 'delay', params: { time: 0.2 } }]))!;
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe('delay');
    expect(out[0]!.params!.time).toBe(0.2);
  });

  it('returns undefined — not [] — when there is nothing, so no nodes are built', () => {
    expect(readAudioEffects(node(undefined))).toBeUndefined();
    expect(readAudioEffects(node([]))).toBeUndefined();
    expect(readAudioEffects({ components: [] })).toBeUndefined();
  });

  it.each([
    ['a missing id', [{ type: 'delay' }]],
    ['an unknown type', [{ id: 'a', type: 'rotary-klaxon' }]],
    ['a non-object entry', ['delay']],
  ])('drops %s rather than trusting the document', (_why, raw) => {
    expect(readAudioEffects(node(raw))).toBeUndefined();
  });

  it('drops non-finite params instead of passing NaN to the audio thread', () => {
    const out = readAudioEffects(node([{ id: 'a', type: 'delay', params: { time: NaN, mix: 50 } }]))!;
    expect(out[0]!.params).toEqual({ mix: 50 });
  });

  it('the inspector section writes the key the reader reads (through the engine: the audio/effects field)', () => {
    const ui = readSource('layout/Inspector/AudioEffectsSection.tsx');
    expect(ui).toMatch(/AUDIO_EFFECTS_PROP/);
    // B3: the whole chain as the `audio/effects` json field, which the engine
    // stores on fx[AUDIO_EFFECTS_PROP] (layerFieldSpecs.ts) — the key readAudioEffects reads.
    expect(ui).toMatch(/type: 'setProperty', prop: \{ layer: nodeId, path: 'audio\/effects' \}/);
    expect(readSource('core/engine/layerFieldSpecs.ts')).toMatch(/path: 'audio\/effects', key: 'audioEffects'/);
  });

  it('and that section is actually MOUNTED — otherwise this is unreachable code', () => {
    const ui = readSource('layout/Inspector/AudioControls.tsx');
    expect(ui).toMatch(/import \{ AudioEffectsSection \}/);
    expect(ui).toMatch(/<AudioEffectsSection nodeId=\{nodeId\} \/>/);
  });

});
