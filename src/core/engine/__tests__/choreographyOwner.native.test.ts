/**
 * Animate In, Stagger and Animate on Beats with the C++ ENGINE AS THE OWNER
 * (the app's configuration: `bootEngine({ ownsDocument: true })` over the real
 * `premation-engine`; the page keeps no replica).
 *
 * The bug this pins: the choreography commands wrote the page's scene graph
 * and animation stores directly, so only the replica changed — the engine's
 * document (what is saved, rendered and exported) never saw the keys. Now each
 * gesture is ONE engine edit (choreographyEdits.ts): the keys, and the Blur /
 * text animator / 3D installs, are in the ENGINE's document, and one undo there
 * removes them.
 *
 * Skipped, saying so, when the engine is not built.
 */

import { unwrap, type EngineClient } from '@motion/engine-api';
import { CommandSystem, setCommandSystem } from '@core/commands/CommandSystem';
import type { CommandServices } from '@core/commands/Command';
import { resetSnapshotSharing } from '@core/commands/snapshotSharing';
import { documentMirror } from '@stores/documentMirror';
import { useSelectionStore } from '@stores/selectionStore';
import { useChoreographyStore } from '@stores/choreographyStore';
import { planChoreography, writeChoreography, DEFAULT_STAGGER_PARAMS } from '@core/animation/choreography';
import { choreographyEngineEdit } from '@core/animation/choreographyEdits';
import { revertChoreography, runChoreography } from '@core/animation/choreographyCommands';
import { bootEngine, engine, engineIdle, ownedEngine, shutdownEngine } from '../engineInstance';
import { resetEngineOwnership, setEngineOwnsDocument } from '../engineOwnership';
import { resetProcessEngine } from '../process/processEngine';
import { nativeEngineExe, startNativeEngine, type NativeEngine } from '../__testHelpers__/nativeEngine';

jest.setTimeout(180_000);

const U = URL as unknown as { revokeObjectURL?: (u: string) => void; createObjectURL?: (b: unknown) => string };
U.revokeObjectURL ??= () => {};
U.createObjectURL ??= () => 'blob:test';

const run = !!nativeEngineExe();
if (!run) console.log('[choreography owner] premation-engine is not built — skipped');
const maybe = run ? describe : describe.skip;

/** The API paths the ENGINE (the owner) holds keyframes on, per layer. */
async function ownerKeyed(layers: readonly string[]): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const layer of layers) {
    const tree = unwrap(await ownedEngine()!.query({ type: 'getPropertyTree', layer, path: '', depth: 16 } as never)) as unknown as {
      nodes: Array<{ path: string; animated?: boolean; keyframeCount?: number }>;
    };
    out[layer] = tree.nodes.filter((n) => (n.keyframeCount ?? 0) > 0).map((n) => n.path).sort();
  }
  return out;
}

/** The first key time (seconds) of a property in the owner's document. */
async function firstKey(layer: string, path: string): Promise<number> {
  const r = unwrap(await ownedEngine()!.query({ type: 'getKeyframes', props: [{ layer, path }] } as never)) as unknown as {
    sets: Array<{ keyframes: Array<{ time: number }> }>;
  };
  return (r.sets[0]?.keyframes[0]?.time ?? NaN) / 705_600_000;
}

async function ownerGroups(layer: string, path: string): Promise<string[]> {
  const t = unwrap(await ownedEngine()!.query({ type: 'getPropertyTree', layer, path: '', depth: 16 } as never)) as unknown as {
    nodes: Array<{ path: string }>;
  };
  return t.nodes.map((n) => n.path).filter((p) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/'));
}

maybe('choreography with the C++ engine as the owner', () => {
  let native: NativeEngine;
  let client: EngineClient;
  let layers: string[] = [];
  let text = '';

  const settle = async (): Promise<void> => {
    await engineIdle();
    await documentMirror().whenIdle();
  };

  beforeAll(async () => {
    native = await startNativeEngine();
    (window as unknown as { motionEditor?: unknown }).motionEditor = { engine: native.bridge };
    await shutdownEngine();
    setCommandSystem(new CommandSystem({ services: {} as CommandServices, getState: () => ({}) }));
    resetSnapshotSharing();
    setEngineOwnsDocument(true);
    bootEngine({ ownsDocument: true });
    client = engine();
    expect(client).toBe(ownedEngine());
  });
  afterAll(async () => {
    await shutdownEngine();
    await resetProcessEngine();
    resetEngineOwnership();
    delete (window as unknown as { motionEditor?: unknown }).motionEditor;
    await native.stop();
  });

  beforeEach(async () => {
    unwrap(await client.execute({ type: 'newProject' }));
    layers = [];
    for (const [i, name] of ['A', 'B', 'C'].entries()) {
      const { layer } = unwrap(await client.execute({ type: 'createLayer', comp: 'comp_root', kind: 'shape', name, init: [] }));
      unwrap(await client.execute({ type: 'setProperty', prop: { layer, path: 'transform/position' }, value: { kind: 'vec2', value: { x: 200 + i * 300, y: 300 } } }));
      layers.push(layer);
    }
    text = unwrap(await client.execute({ type: 'createLayer', comp: 'comp_root', kind: 'text', name: 'Title', init: [] })).layer;
    await settle();
    useChoreographyStore.setState({ byComp: {}, lastParams: null });
    useSelectionStore.setState({ ids: [...layers] } as never);
  });

  it('Animate In: the keys are in the engine document, one undo removes them', async () => {
    const before = await ownerKeyed(layers);
    expect(Object.values(before).flat()).toEqual([]);
    const record = await runChoreography({ kind: 'in', nodeIds: layers, params: { ...DEFAULT_STAGGER_PARAMS, seed: 3, baseOffsetFrames: 5, swingPct: 0 } });
    await settle();
    expect(record).not.toBeNull();
    const after = await ownerKeyed(layers);
    for (const l of layers) expect(after[l]).toContain('transform/opacity');
    // Staggered in the ENGINE: 5 frames apart at 30 fps.
    const t0 = await firstKey(layers[0]!, 'transform/opacity');
    const t1 = await firstKey(layers[1]!, 'transform/opacity');
    expect(t1 - t0).toBeCloseTo(5 / 30, 3);

    unwrap(await client.execute({ type: 'undo' }));
    await settle();
    expect(Object.values(await ownerKeyed(layers)).flat()).toEqual([]);
    expect(useChoreographyStore.getState().byComp).toBeDefined();
  });

  it('the installs reach the engine: a Blur for Blur In, a text animator for Character Cascade', async () => {
    const blurred = await runChoreography({ kind: 'in', nodeIds: [layers[0]!], params: DEFAULT_STAGGER_PARAMS, archetype: 'blur_resolve' });
    await settle();
    expect(blurred).not.toBeNull();
    const fx = await ownerGroups(layers[0]!, 'effects');
    expect(fx).toHaveLength(1);
    expect((await ownerKeyed([layers[0]!]))[layers[0]!]).toContain(`${fx[0]}/amount`);

    const cascade = await runChoreography({ kind: 'in', nodeIds: [text], params: DEFAULT_STAGGER_PARAMS, archetype: 'char_cascade' });
    await settle();
    expect(cascade).not.toBeNull();
    const animators = await ownerGroups(text, 'text/animators');
    expect(animators).toHaveLength(1);
    const keyed = (await ownerKeyed([text]))[text]!;
    expect(keyed.some((p) => p.startsWith(`${animators[0]}/selectors/`) && p.endsWith('/offset'))).toBe(true);
    const opacity = unwrap(await client.query({ type: 'getPropertyValues', props: [{ layer: text, path: `${animators[0]}/props/opacity` }], time: 0, evaluated: false } as never)) as unknown as {
      values: Array<{ value: { value: number } }>;
    };
    expect(opacity.values[0]?.value.value).toBe(0);

    // One entry each: undo takes the cascade (keys AND animator) away.
    unwrap(await client.execute({ type: 'undo' }));
    await settle();
    expect(await ownerGroups(text, 'text/animators')).toHaveLength(0);
    expect(await ownerGroups(layers[0]!, 'effects')).toHaveLength(1);
  });

  it('Stagger shifts the engine keys; Remove puts them back', async () => {
    for (const l of layers) {
      unwrap(await client.execute({
        type: 'addKeyframes',
        keys: [0, 0.5].map((s, i) => ({ prop: { layer: l, path: 'transform/opacity' }, time: Math.round(s * 705_600_000), value: { kind: 'scalar', value: i * 100 }, spatialIn: [], spatialOut: [] })),
      } as never));
    }
    await settle();
    const record = await runChoreography({ kind: 'stagger', nodeIds: layers, params: { ...DEFAULT_STAGGER_PARAMS, baseOffsetFrames: 6, swingPct: 0 } });
    await settle();
    expect(record).not.toBeNull();
    expect(await firstKey(layers[1]!, 'transform/opacity')).toBeCloseTo(6 / 30, 3);
    expect(await firstKey(layers[2]!, 'transform/opacity')).toBeCloseTo(12 / 30, 3);

    expect(await revertChoreography()).toBe(true);
    await settle();
    for (const l of layers) expect(await firstKey(l, 'transform/opacity')).toBeCloseTo(0, 5);
  });

  it('Animate on Beats: the beat-timed keys are the engine document, one undo entry', async () => {
    // The beat grid is the audioAnalysis job's; the timing it hands the
    // planner is start times — given here directly.
    const beats = [0.5, 1, 1.5];
    const result = await choreographyEngineEdit('Animate in', layers, (env) => {
      const plan = planChoreography({ nodeIds: layers, atCompTime: beats[0]!, phase: 'in', startTimes: beats, fps: 30, seed: 9 }, env);
      return { installs: plan.installs, needs: plan.needs, layers: plan.perLayer.length, keyframes: writeChoreography(plan, env) };
    });
    await settle();
    expect(result?.layers).toBe(3);
    for (const [i, l] of layers.entries()) expect(await firstKey(l, 'transform/opacity')).toBeCloseTo(beats[i]!, 3);
    unwrap(await client.execute({ type: 'undo' }));
    await settle();
    expect(Object.values(await ownerKeyed(layers)).flat()).toEqual([]);
  });
});
