/**
 * The dynamics bakes as engine jobs on the REAL `premation-engine`
 * (kind_dynamics_bake.cpp), against the TypeScript reference samplers
 * (bakeDynamics.ts samplePhysicsTracks / sampleParticleLayers) on seeded cases:
 *
 *   physicsBake   a box falling onto the comp floor: the engine's position keys
 *                 are the reference's x / y samples, the physics is off after,
 *                 ONE history entry, undo restores both.
 *   particleBake  the default emitter: one keyed layer per particle under a
 *                 "<emitter> Baked" null, the emitter hidden; the particles, the
 *                 cap and the first particle's track match the reference.
 *
 * Skipped, saying so, when the full engine is not built (the headless build
 * runs no jobs).
 */

import { ProcessEngineClient, flicksToSeconds, secondsToFlicks, unwrap, type EngineClient, type EventBatch, type JobInfo, type Value } from '@motion/engine-api';
import { nativeEngineExe, startNativeEngine, type NativeEngine } from '../__testHelpers__/nativeEngine';
import { samplePhysicsTracks, sampleParticleLayers } from '@core/simulation/bakeDynamics';
import { DEFAULT_PHYSICS_BODY } from '@core/simulation/rigidBody';
import { DEFAULT_PARTICLE_CONFIG, resolveParticleConfig, type ParticleConfig } from '@core/particles/particleSim';

jest.setTimeout(120_000);

const exe = nativeEngineExe();
const full = !!exe && !/headless/i.test(exe);
if (!full) console.log('[dynamics bake native] the full premation-engine is not built — skipped');
const maybe = full ? describe : describe.skip;

async function waitJob(client: EngineClient, id: string): Promise<{ job: JobInfo; error?: { code: string; message: string } }> {
  return new Promise((resolve) => {
    const off = client.subscribe((b: EventBatch) => {
      for (const e of b.events) {
        if (e.type === 'jobFinished' && e.job.id === id) {
          off();
          resolve({ job: e.job, ...(e.error ? { error: e.error } : {}) });
        }
      }
    });
  });
}

const vec2 = (v: Value): { x: number; y: number } => {
  if (v.kind !== 'vec2') throw new Error(`expected vec2, got ${v.kind}`);
  return v.value;
};
const scalar = (v: Value): number => {
  if (v.kind !== 'scalar') throw new Error(`expected scalar, got ${v.kind}`);
  return v.value;
};

maybe('dynamics bakes on the real engine', () => {
  let native: NativeEngine;
  let client: EngineClient;

  beforeAll(async () => {
    native = await startNativeEngine();
    const c = new ProcessEngineClient(native.bridge);
    await c.whenReady();
    client = c;
  });
  afterAll(async () => {
    await native?.stop();
  });

  const keysOf = async (layer: string, path: string) =>
    unwrap(await client.query({ type: 'getKeyframes', props: [{ layer, path }] })).sets[0]!.keyframes;
  const jsonProp = async (layer: string, path: string): Promise<Record<string, unknown>> => {
    const v = unwrap(await client.query({ type: 'getPropertyValues', props: [{ layer, path }], time: 0, evaluated: false })).values[0]!.value;
    if (v.kind !== 'json') throw new Error(`expected json, got ${v.kind}`);
    return JSON.parse(v.value) as Record<string, unknown>;
  };

  it('bakes a falling box to the reference solver\'s keys and switches its physics off, as one entry', async () => {
    const comp = unwrap(await client.execute({ type: 'createComposition', settings: { name: 'Fall', width: 1920, height: 1080, frameRate: { num: 30, den: 1 } }, fromItems: [] })).item;
    const box = unwrap(await client.execute({
      type: 'createLayer', comp, kind: 'rectangle', name: 'Box',
      init: [{ path: 'transform/position', value: { kind: 'vec2', value: { x: 960, y: 200 } } }],
    })).layer;
    const body = { ...DEFAULT_PHYSICS_BODY, enabled: true, restitution: 0.5 };
    unwrap(await client.execute({ type: 'setProperties', writes: [{ prop: { layer: box, path: 'layer/physics' }, value: { kind: 'json', value: JSON.stringify(body) } }] }));
    const before = unwrap(await client.query({ type: 'getHistory' })).entries.length;

    const started = unwrap(await client.execute({
      type: 'startJob',
      job: { kind: 'physicsBake', value: { layers: [box], range: { start: 0, duration: secondsToFlicks(2) } } },
      apply: true,
    }));
    const done = await waitJob(client, started.job);
    expect(done.error).toBeUndefined();
    const summary = JSON.parse(done.job.result) as { layers: string[]; frames: number; tracks: number; keyframes: number };
    expect(summary).toMatchObject({ layers: [box], frames: 61, tracks: 2, keyframes: 122 });

    // The reference: the same seeds, the engine's world (gravity 0 / 1800, the comp as walls, 4 passes).
    const ref = samplePhysicsTracks(
      [{ id: box, x: 960, y: 200, rotation: 0, width: 280, height: 280, cfg: body }],
      { gravityX: 0, gravityY: 1800, bounds: { left: 0, top: 0, right: 1920, bottom: 1080 }, iterations: 4 },
      [box], { from: 0, to: 2, fps: 30 }, 'native-parity',
    );
    const refY = ref.find((t) => t.prop === 'y')!.keyframes;
    const refX = ref.find((t) => t.prop === 'x')!.keyframes;
    const keys = await keysOf(box, 'transform/position');
    expect(keys).toHaveLength(61);
    keys.forEach((k, i) => {
      expect(flicksToSeconds(k.time)).toBeCloseTo(refY[i]!.t, 6);
      expect(vec2(k.value).y).toBeCloseTo(refY[i]!.value, 6);
      expect(vec2(k.value).x).toBeCloseTo(refX[i]!.value, 6);
    });
    // It fell and bounced on the floor (the comp's bottom edge, minus half the box), never through it.
    const ys = keys.map((k) => vec2(k.value).y);
    expect(Math.max(...ys)).toBeCloseTo(1080 - 140, 0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(1080 - 140 + 1e-6);
    expect(keys.slice(0, -1).every((k) => k.easing === 'linear')).toBe(true);
    expect(keys.at(-1)!.easing).toBe('hold');
    expect(await jsonProp(box, 'layer/physics')).toMatchObject({ enabled: false, restitution: 0.5 });

    const history = unwrap(await client.query({ type: 'getHistory' })).entries;
    expect(history.length).toBe(before + 1);
    expect(history.at(-1)!.label).toBe('Bake physics to keyframes');
    unwrap(await client.execute({ type: 'undo' }));
    expect(await keysOf(box, 'transform/position')).toHaveLength(0);
    expect(await jsonProp(box, 'layer/physics')).toMatchObject({ enabled: true });
  });

  it('thins the baked track by value tolerance and refuses a layer with no dynamic body', async () => {
    const comp = unwrap(await client.execute({ type: 'createComposition', settings: { name: 'Thin', width: 1920, height: 1080, frameRate: { num: 30, den: 1 } }, fromItems: [] })).item;
    const box = unwrap(await client.execute({
      type: 'createLayer', comp, kind: 'rectangle', name: 'Box',
      init: [{ path: 'transform/position', value: { kind: 'vec2', value: { x: 960, y: 200 } } }],
    })).layer;
    const still = unwrap(await client.execute({ type: 'createLayer', comp, kind: 'rectangle', name: 'Still', init: [] })).layer;
    unwrap(await client.execute({ type: 'setProperties', writes: [{ prop: { layer: box, path: 'layer/physics' }, value: { kind: 'json', value: JSON.stringify({ ...DEFAULT_PHYSICS_BODY, enabled: true }) } }] }));
    const refused = await client.execute({
      type: 'startJob',
      job: { kind: 'physicsBake', value: { layers: [still], range: { start: 0, duration: secondsToFlicks(1) } } },
      apply: true,
    });
    expect(refused.ok).toBe(false);
    const started = unwrap(await client.execute({
      type: 'startJob',
      job: { kind: 'physicsBake', value: { layers: [box], range: { start: 0, duration: secondsToFlicks(2) }, simplifyTolerance: 4 } },
      apply: true,
    }));
    const done = await waitJob(client, started.job);
    expect(done.error).toBeUndefined();
    const keys = await keysOf(box, 'transform/position');
    expect(keys.length).toBeGreaterThan(2);
    expect(keys.length).toBeLessThan(61);
  });

  it('bakes the default emitter to one keyed layer per particle under a new null, the emitter hidden', async () => {
    const comp = unwrap(await client.execute({ type: 'createComposition', settings: { name: 'Sparks', width: 1280, height: 720, frameRate: { num: 30, den: 1 } }, fromItems: [] })).item;
    const emitter = unwrap(await client.execute({ type: 'createLayer', comp, kind: 'particle', name: 'Sparks', init: [] })).layer;
    const stored = await jsonProp(emitter, 'layer/particle');
    const before = unwrap(await client.query({ type: 'getHistory' })).entries.length;
    const layersBefore = unwrap(await client.query({ type: 'getComposition', comp })).comp.layers;

    const started = unwrap(await client.execute({
      type: 'startJob',
      job: { kind: 'particleBake', value: { layer: emitter, range: { start: 0, duration: secondsToFlicks(1) }, maxParticles: 12 } },
      apply: true,
    }));
    const done = await waitJob(client, started.job);
    expect(done.error).toBeUndefined();
    const summary = JSON.parse(done.job.result) as { containerId: string; layerIds: string[]; seen: number; capped: boolean; keyframes: number };

    // The reference over the same config (the layer box is the particle kind's 400×400).
    const cfg: ParticleConfig = resolveParticleConfig({ ...DEFAULT_PARTICLE_CONFIG, ...(stored as Partial<ParticleConfig>), emitterWidth: 400, emitterHeight: 400 }, () => undefined);
    const ref = sampleParticleLayers(() => cfg, { from: 0, to: 1, fps: 30, maxParticles: 12 }, 'native-parity-sparks');
    expect(summary.seen).toBe(ref.seen);
    expect(summary.capped).toBe(ref.capped);
    expect(summary.layerIds).toHaveLength(ref.particles.length);

    const container = unwrap(await client.query({ type: 'getLayers', layers: [summary.containerId] })).layers[0]!;
    expect(container.kind).toBe('null');
    expect(container.name).toBe('Sparks Baked');
    expect(container.parent).toBe(emitter);
    const first = unwrap(await client.query({ type: 'getLayers', layers: [summary.layerIds[0]!] })).layers[0]!;
    expect(first.parent).toBe(summary.containerId);
    expect(first.name).toBe(`Particle ${ref.particles[0]!.index}`);
    const pos = await keysOf(summary.layerIds[0]!, 'transform/position');
    expect(pos).toHaveLength(ref.particles[0]!.x.length);
    pos.forEach((k, i) => {
      expect(vec2(k.value).x).toBeCloseTo(ref.particles[0]!.x[i]!.value, 6);
      expect(vec2(k.value).y).toBeCloseTo(ref.particles[0]!.y[i]!.value, 6);
    });
    // Invisible outside its life: a zero hold one frame past the last sample.
    const opacity = await keysOf(summary.layerIds[0]!, 'transform/opacity');
    expect(scalar(opacity.at(-1)!.value)).toBe(0);
    expect(opacity.at(-1)!.easing).toBe('hold');

    const emitterInfo = unwrap(await client.query({ type: 'getLayers', layers: [emitter] })).layers[0]!;
    expect(emitterInfo.switches.visible).toBe(false);
    const layers = unwrap(await client.query({ type: 'getComposition', comp })).comp.layers;
    expect(layers.length).toBe(layersBefore.length + 1 + summary.layerIds.length);
    const history = unwrap(await client.query({ type: 'getHistory' })).entries;
    expect(history.length).toBe(before + 1);
    expect(history.at(-1)!.label).toBe('Bake particles to layers');
    unwrap(await client.execute({ type: 'undo' }));
    expect(unwrap(await client.query({ type: 'getComposition', comp })).comp.layers).toEqual(layersBefore);
    expect(flicksToSeconds(pos[0]!.time)).toBeCloseTo(ref.particles[0]!.x[0]!.t, 6);
  });
});
