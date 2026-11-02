/**
 * Camera program D7 — Create Stereo 3D Rig on the app's engine: one history
 * entry builds the controls null, the Left / Right eye cameras (offset by the
 * interaxial along the master's right axis, converging on its Point of
 * Interest), the eye comps (the scene seen through each eye) and the 3D
 * Glasses output comp.
 */

import type { CameraSamples, Value } from '@motion/engine-api';
import { setupAppEngine, sec, settleEdits, type AppHarness } from '@core/engine/__testHelpers__/appEngine';
import { nativeEngineIsHeadless } from '@core/engine/__testHelpers__/nativeEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { documentMirror } from '@stores/documentMirror';
import { createStereoRigEdit, stereoRigSource } from './stereoRig';

const comp = 'comp_root';
let h: AppHarness;
/**
 * The output comp's render runs on the GPU renderer: the harness's default
 * engine is `--no-gpu` (simulated frames, no renderer: getThumbnail answers
 * `unsupported`), and `nativeEngineIsHeadless` only says which BINARY runs.
 * False when this machine's full engine would not start with a GPU.
 */
let gpu = !nativeEngineIsHeadless();

beforeEach(async () => {
  if (gpu) {
    try {
      h = await setupAppEngine({ gpu: true });
      return;
    } catch (e) {
      gpu = false;
      console.log(`[stereoRig] the engine did not start with a GPU: the render is skipped (${String(e)})`);
    }
  }
  h = await setupAppEngine();
}, 30_000);  // a GPU engine's start (device, shader cache) passes 5 s while the whole suite runs
afterEach(async () => { await h.dispose(); });

async function cameraAt(layer: string, t = 0): Promise<CameraSamples['samples'][number]> {
  const r = await h.client.query({ type: 'sampleCamera', layer, range: { start: sec(t), duration: 0 }, samples: 1 });
  if (!r.ok) throw new Error(r.error.message);
  return (r.value as CameraSamples).samples[0]!;
}

describe('Create Stereo 3D Rig', () => {
  it('builds the rig in one entry: eyes offset by the interaxial, converging on the POI, eye comps and an output comp', async () => {
    const cam = (await h.run({ type: 'createLayer', comp, kind: 'camera', name: 'Camera 1', init: [] })).layer;
    await h.run({ type: 'setProperty', prop: { layer: cam, path: 'transform/orientTowardsPointOfInterest' }, value: { kind: 'bool', value: true } });
    await h.run({ type: 'createLayer', comp, kind: 'solid', name: 'Subject', init: [] });
    await engineIdle();
    await documentMirror().loadTrees([cam]);
    const before = (await h.client.query({ type: 'getHistory' }));
    const entries0 = before.ok ? before.value.entries.length : 0;

    const src = stereoRigSource(cam);
    expect(src).not.toBeNull();
    const rig = await createStereoRigEdit(src!);
    expect(rig).not.toBeNull();
    await settleEdits();

    const after = await h.client.query({ type: 'getHistory' });
    expect(after.ok && after.value.entries.length).toBe(entries0 + 1);

    // The eyes straddle the master along its right axis, the interaxial apart
    // (Stereo Scene Depth 3 % of the comp width by default), aiming at its POI.
    const m = documentMirror();
    const width = m.comp(comp)!.settings.width;
    const master = await cameraAt(cam);
    const left = await cameraAt(rig!.left);
    const right = await cameraAt(rig!.right);
    const ia = 0.03 * width;
    expect(right.eye.x - left.eye.x).toBeCloseTo(ia, 3);
    expect((left.eye.x + right.eye.x) / 2).toBeCloseTo(master.eye.x, 3);
    expect(left.eye.z).toBeCloseTo(master.eye.z, 3);
    expect(left.zoom).toBeCloseTo(master.zoom, 6);
    // Converged: each eye turns in toward the master's Point of Interest.
    expect(left.yaw).toBeGreaterThan(0);
    expect(right.yaw).toBeLessThan(0);

    // Interaxial Separation overrides the scene depth.
    await h.run({ type: 'setProperty', prop: { layer: rig!.controls, path: `effects/ctrl_${rig!.names.interaxial}/slider` }, value: { kind: 'scalar', value: 100 } as Value });
    const l2 = await cameraAt(rig!.left);
    const r2 = await cameraAt(rig!.right);
    expect(r2.eye.x - l2.eye.x).toBeCloseTo(100, 3);
    // Convergence Of 0 (off): parallel eyes, looking where the master looks.
    await h.run({ type: 'setProperty', prop: { layer: rig!.controls, path: `effects/ctrl_${rig!.names.convergence}/menu` }, value: { kind: 'scalar', value: 0 } as Value });
    expect((await cameraAt(rig!.left)).yaw).toBeCloseTo(master.yaw, 6);

    // The eye comps look through their eye; the output comp holds both, 3D Glasses on the left one.
    const out = m.comp(rig!.outputComp)!;
    expect(out.layers.length).toBe(2);
    const leftLayer = out.layers[0]!;
    expect(m.layer(leftLayer)?.source).toBe(rig!.leftComp);
    expect(m.layer(out.layers[1]!)?.switches.visible).toBe(false);
    // The output renders on the GPU engine (3D Glasses over two nested eye comps,
    // each looking through its own camera).
    if (gpu) {
      const th = await h.client.query({ type: 'getThumbnail', item: rig!.outputComp, time: 0, maxSize: 64 });
      if (!th.ok) throw new Error(`getThumbnail of the output comp: ${th.error.code}: ${th.error.message}`);
      expect(th.ok).toBe(true);
      expect(th.value.width).toBeGreaterThan(0);
    }
  }, 60_000);
});
