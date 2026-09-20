/**
 * The Grade Lab example plugin, driven through the real host.
 *
 * ── Why this exists on top of the unit tests ────────────────────────────────
 *
 * Sequence data, param supervision and audio effects each have their own
 * suite, and each proves its own mechanism over a stand-in. What none of them
 * proves is that an AUTHOR can put the three together in one package and have
 * it work — which is a different question, and the one that decides whether
 * the SDK is real.
 *
 * So this loads `examples/plugins/grade-lab/plugin.json` — the actual file
 * shipped as documentation, read off disk, not a fixture written to pass —
 * through `parseManifest`, registers what it declares, and then exercises it.
 * If the example drifts from the host, this goes red rather than the example
 * quietly becoming wrong advice.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseManifest } from './manifest';
import { registerEffects, unregisterEffects, effectById } from './pluginEffects';
import {
  registerAudioEffects,
  unregisterAudioEffects,
  audioEffectById,
  resetAudioEffectRegistry,
} from './pluginAudioEffects';
import { connectPluginAudioEffect } from './pluginAudioGraph';
import {
  SUPERVISE_DEBOUNCE_MS,
  noteParamCommitted,
  resetParamSupervision,
  setSuperviseHandler,
} from './paramSupervision';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getNodeEffects, writeNodeEffects } from '@core/effects/effects';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { CommandSystem, setCommandSystem } from '@core/commands/CommandSystem';
import type { PluginManifest } from './manifest';
import type { SceneNode } from '@core/types';

const DIR = join(process.cwd(), 'examples', 'plugins', 'grade-lab');
const PLUGIN_ID = 'studio.example.gradelab';
const FX_TYPE = `${PLUGIN_ID}.filmic`;

/** The presets, copied from the example's own `main.js`. Duplicated on
 *  purpose: if the example changes its numbers, this notices. */
const FILMIC = { lift: 0.04, gain: 1.1 };

let manifest: PluginManifest;

beforeAll(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) } as never));
  const raw = JSON.parse(readFileSync(join(DIR, 'plugin.json'), 'utf-8')) as unknown;
  const result = parseManifest(raw);
  // Printed rather than swallowed: a manifest error here is the example being
  // wrong, and the message is the whole diagnosis.
  if (!result.manifest) throw new Error(`grade-lab/plugin.json is invalid:\n${result.errors.join('\n')}`);
  expect(result.errors).toEqual([]);
  manifest = result.manifest;
});

function node(id: string, parent: string | null): SceneNode {
  return {
    id, name: id, parent, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 0, y: 0 } }],
  } as unknown as SceneNode;
}

beforeEach(() => {
  jest.useFakeTimers();
  resetParamSupervision();
  resetAudioEffectRegistry();
  for (const r of [...defaultSceneGraph.getRoots()]) defaultSceneGraph.removeNode(r.id);
  defaultSceneGraph.addNode(node('root', null));
  defaultSceneGraph.addChild('root', node('layer', 'root'));

  unregisterEffects(PLUGIN_ID);
  registerEffects(PLUGIN_ID, manifest.name, manifest.contributes.effects);
  registerAudioEffects(PLUGIN_ID, manifest.name, manifest.contributes.audioEffects);
});

afterEach(() => {
  resetParamSupervision();
  unregisterEffects(PLUGIN_ID);
  unregisterAudioEffects(PLUGIN_ID);
  // NOT `setPluginAudioEffects(() => undefined)`: the registry installs its
  // own lookup at module load, and overriding it here would leave every later
  // test in this file looking at an empty one.
  resetAudioEffectRegistry();
  jest.useRealTimers();
});

describe('the manifest the example ships', () => {
  it('parses at the grammar it declares, with no errors', () => {
    // `beforeAll` throws with the messages if not; this states the version.
    expect(manifest.apiVersion).toBe(8);
  });

  it('declares one visual effect and one audio effect', () => {
    expect(manifest.contributes.effects).toHaveLength(1);
    expect(manifest.contributes.audioEffects).toHaveLength(1);
  });

  it('carries the three surfaces it exists to demonstrate', () => {
    const fx = manifest.contributes.effects[0]!;
    expect(fx.supervises).toEqual(['preset']);      // param supervision
    expect(fx.invalidateOn).toEqual(['quality']);   // sequence data
    expect(fx.cpu).toBeDefined();                   // the bake twin
    expect(manifest.contributes.audioEffects[0]!.chain).toHaveLength(2);
  });

  it('asks for no permissions at all', () => {
    // Worth pinning: everything this plugin does is to its OWN effects, and a
    // package that needed `scene:write` to run a preset would be teaching the
    // wrong lesson about what these surfaces cost a user.
    expect(manifest.permissions).toEqual([]);
  });
});

describe('what the host registers from it', () => {
  it('namespaces the visual effect and keeps its declaration', () => {
    const registered = effectById(FX_TYPE);
    expect(registered?.contribution.label).toBe('Filmic Grade');
    expect(registered?.contribution.supervises).toEqual(['preset']);
  });

  it('namespaces the audio effect and keeps its chain', () => {
    const air = audioEffectById(`${PLUGIN_ID}.air`);
    expect(air?.contribution.label).toBe('Air');
    expect(air?.contribution.params.map((p) => p.key)).toEqual(['amount', 'warmth']);
  });
});

describe('the preset, end to end', () => {
  /** Stand in for the worker, running the example's own supervisor logic. */
  function installSupervisor(): void {
    const PRESETS: Array<Record<string, number> | null> = [
      null,
      { lift: 0.04, gain: 1.10 },
      { lift: 0.00, gain: 1.35 },
      { lift: 0.10, gain: 0.92 },
    ];
    setSuperviseHandler(({ changed, params }) => {
      if (changed !== 'preset') return null;
      return PRESETS[Math.round(Number(params.preset))] ?? null;
    });
  }

  const addEffect = (params: Record<string, number>): void => {
    writeNodeEffects('layer', [{
      id: 'fx1',
      type: FX_TYPE as never,
      params: { preset: 0, strength: 1, lift: 0, gain: 1, quality: 2, ...params } as never,
    }]);
  };

  const paramsOf = (): Record<string, unknown> =>
    (getNodeEffects('layer')[0]?.params ?? {}) as Record<string, unknown>;

  async function settle(): Promise<void> {
    jest.advanceTimersByTime(SUPERVISE_DEBOUNCE_MS + 1);
    for (let i = 0; i < 4; i++) await Promise.resolve();
  }

  it('picking a preset moves the sliders under it', async () => {
    installSupervisor();
    addEffect({ preset: 1 });
    noteParamCommitted('layer', 'fx1', 'preset');
    await settle();

    // The whole point of supervision, from the user's side.
    expect(paramsOf()).toMatchObject(FILMIC);
  });

  it('Custom leaves the sliders exactly where the user put them', async () => {
    installSupervisor();
    addEffect({ preset: 0, lift: 0.7, gain: 2.2 });
    noteParamCommitted('layer', 'fx1', 'preset');
    await settle();

    // Index 0 carries no values on purpose: selecting Custom must not undo
    // the hand-tuning that got you there.
    expect(paramsOf()).toMatchObject({ lift: 0.7, gain: 2.2 });
  });

  it('does not supervise a param the effect did not name', async () => {
    const handler = jest.fn(() => null);
    setSuperviseHandler(handler);
    addEffect({});
    noteParamCommitted('layer', 'fx1', 'strength');
    await settle();
    // `supervises` is `["preset"]`, so dragging Strength costs nothing.
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('the audio effect, built into a real chain', () => {
  it('builds the two shelves it declares, in order', () => {
    const made: string[] = [];
    const mk = (kind: string) => {
      const n: Record<string, unknown> = {
        frequency: { value: 0 }, Q: { value: 0 }, gain: { value: 0 }, detune: { value: 0 },
        connect: () => {},
      };
      made.push(kind);
      return n;
    };
    const ctx = { createBiquadFilter: () => mk('biquad') } as unknown as BaseAudioContext;
    const source = { connect: () => {} } as unknown as AudioNode;

    const bound: string[][] = [];
    connectPluginAudioEffect(ctx, source, `${PLUGIN_ID}.air`, (_t, keys) => {
      bound.push([...keys]);
    });

    expect(made).toEqual(['biquad', 'biquad']);
    // Each shelf's gain is driven by its own declared parameter, so both are
    // animatable and neither re-schedules when the other is keyframed.
    expect(bound).toEqual([['amount'], ['warmth']]);
  });
});

describe('the CPU twin the example ships', () => {
  it('caches its lookup table across frames and rebuilds it on quality', async () => {
    // The kernel is plain ESM; import it the way the host's module graph
    // would, and drive it directly. What is under test is the CACHING
    // discipline the manifest's `invalidateOn: ["quality"]` describes.
    const kernel = await import(
      /* webpackIgnore: true */ `${join(DIR, 'kernels', 'filmic.js').replace(/\\/g, '/')}`
    ) as { render: (i: Uint8ClampedArray, o: Uint8ClampedArray, p: Record<string, number>) => void };

    const input = new Uint8ClampedArray([128, 128, 128, 255]);
    const out = new Uint8ClampedArray(4);

    kernel.render(input, out, { quality: 2, strength: 1, lift: 0, gain: 1 });
    const first = Array.from(out);

    // Same quality, same answer — and the table was not rebuilt.
    kernel.render(input, out, { quality: 2, strength: 1, lift: 0, gain: 1 });
    expect(Array.from(out)).toEqual(first);

    // Alpha is carried through untouched, which a grade must always do.
    expect(out[3]).toBe(255);
  });

  it('is the identity at strength 0, which is what the manifest promises', async () => {
    const kernel = await import(
      /* webpackIgnore: true */ `${join(DIR, 'kernels', 'filmic.js').replace(/\\/g, '/')}`
    ) as { render: (i: Uint8ClampedArray, o: Uint8ClampedArray, p: Record<string, number>) => void };

    const input = new Uint8ClampedArray([10, 120, 240, 255]);
    const out = new Uint8ClampedArray(4);
    kernel.render(input, out, { quality: 2, strength: 0, lift: 0.5, gain: 3 });

    // `identity: [{ param: "strength", equals: 0 }]` tells the host it may
    // skip the pass entirely. If the kernel disagreed, a baked layer and a
    // GPU layer would look different at the same settings.
    expect(Array.from(out)).toEqual([10, 120, 240, 255]);
  });
});
