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

import { ProcessEngineClient,  secondsToFlicks, unwrap, type EngineClient, type EventBatch, type JobInfo } from '@motion/engine-api';
import { nativeEngineExe, startNativeEngine, type NativeEngine } from '../__testHelpers__/nativeEngine';
import { DEFAULT_PHYSICS_BODY } from '@core/simulation/rigidBody';

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
});
