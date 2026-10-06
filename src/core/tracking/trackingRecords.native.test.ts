/**
 * The tracking records stored on a layer, on premation-engine-headless (AE
 * parity 3.5 / 3.6): saved trackers round-trip (times on the layer's own axis,
 * answered in composition time), undo takes them back, and a camera solve is
 * stored and cleared.
 */

import { secondsToFlicks, flicksToSeconds, unwrap, type EngineClient } from '@motion/engine-api';
import { bootEngine, engine, engineIdle, shutdownEngine } from '@core/engine/engineInstance';
import { resetEngineOwnership } from '@core/engine/engineOwnership';
import { resetProcessEngine } from '@core/engine/process/processEngine';
import { nativeEngineExe, startNativeEngine, type NativeEngine } from '@core/engine/__testHelpers__/nativeEngine';
import { loadTracker, trackerDataOf } from './trackerPersistence';
import { loadCameraSolve } from './cameraTrack';

jest.setTimeout(60_000);

const exe = nativeEngineExe();
const maybe = exe ? describe : describe.skip;

maybe('tracking records on a layer', () => {
  let native: NativeEngine;
  let client: EngineClient;
  let layer = '';

  beforeAll(async () => {
    native = await startNativeEngine({ extraArgs: ['--no-gpu', '--test-ports'] });
    (window as unknown as { motionEditor?: unknown }).motionEditor = { engine: native.bridge };
    resetProcessEngine();
    resetEngineOwnership();
    bootEngine({ ownsDocument: true });
    client = engine();
    await engineIdle();
    const comp = unwrap(await client.execute({ type: 'createComposition', settings: { name: 'T', width: 320, height: 240, duration: 705_600_000 * 4 }, fromItems: [] })).item;
    layer = (unwrap(await client.execute({ type: 'createLayer', comp, kind: 'solid', init: [] } as never)) as unknown as { layer: string }).layer;
  });

  afterAll(async () => {
    shutdownEngine();
    await native?.stop();
    delete (window as unknown as { motionEditor?: unknown }).motionEditor;
  });

  it('saves, reads back and undoes a tracker', async () => {
    expect(await loadTracker(client, layer)).toBeNull();
    const data = trackerDataOf({
      mode: 'follow',
      points: [{ x: 10, y: 20 }],
      attach: [{ x: 2, y: 0 }],
      featureHalf: 8,
      searchHalf: 20,
      result: {
        tracks: [[{ compTime: 0, x: 10, y: 20, confidence: 1, coasted: false }, { compTime: 0.5, x: 14, y: 22, confidence: 0.7, coasted: true }]],
        sourceWidth: 320, sourceHeight: 240, status: 'completed',
      },
    });
    unwrap(await client.execute({ type: 'setLayerTrackers', layer, trackers: [data] }));
    const back = await loadTracker(client, layer);
    expect(back?.mode).toBe('follow');
    expect(back?.attach[0]).toEqual({ x: 2, y: 0 });
    expect(back?.result?.tracks[0]?.[1]).toMatchObject({ x: 14, y: 22, coasted: true });
    expect(back?.result?.tracks[0]?.[1]?.compTime).toBeCloseTo(0.5, 6);
    unwrap(await client.execute({ type: 'undo' } as never));
    expect(await loadTracker(client, layer)).toBeNull();
  });

  it('refuses a tracker with a non-finite point', async () => {
    const bad = trackerDataOf({ mode: 'follow', points: [{ x: Number.NaN, y: 0 }], attach: [], featureHalf: 8, searchHalf: 20, result: null });
    const res = await client.execute({ type: 'setLayerTrackers', layer, trackers: [bad] });
    expect(res.ok).toBe(false);
  });

  it('stores and clears a camera solve', async () => {
    unwrap(await client.execute({
      type: 'setCameraSolve',
      layer,
      solve: {
        camera: '', focal: 900, sourceWidth: 320, sourceHeight: 240,
        frames: [{ time: secondsToFlicks(0.5), rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], center: { x: 0, y: 0, z: 0 } }],
        points: [{ x: 0, y: 0, z: 5 }], pointErrors: [0.4],
        worldOrigin: { x: 160, y: 120, z: -900 }, worldScale: 180, worldRotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], worldCentroid: { x: 0, y: 0, z: 0 },
      },
    }));
    const s = await loadCameraSolve(client, layer);
    expect(s?.focal).toBe(900);
    expect(flicksToSeconds(s!.frames[0]!.time)).toBeCloseTo(0.5, 6);
    expect(s?.points).toEqual([{ x: 0, y: 0, z: 5 }]);
    unwrap(await client.execute({ type: 'setCameraSolve', layer }));
    expect(await loadCameraSolve(client, layer)).toBeNull();
  });
});
