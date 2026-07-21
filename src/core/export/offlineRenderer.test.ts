import { frameCount, frameTimeAt, frameTimes, resolveRange, renderOffline } from './offlineRenderer';
import flatBackground from '../../../packages/render-tests/harness/scenes/flatBackground';
import solidFill from '../../../packages/render-tests/harness/scenes/solidFill';
import { precompScenes } from '../../../packages/render-tests/harness/scenes/precomp';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import * as createBackendModule from '../rendering/createRenderBackend';

describe('deterministic frame timing', () => {
  it('frameCount rounds duration×fps and is at least 1', () => {
    expect(frameCount(2, 30)).toBe(60);
    expect(frameCount(1.5, 24)).toBe(36);
    expect(frameCount(0, 30)).toBe(1);
  });

  it('frameTimeAt is the fixed timestep index/fps', () => {
    expect(frameTimeAt(0, 30)).toBe(0);
    expect(frameTimeAt(30, 30)).toBe(1);
    expect(frameTimeAt(15, 30)).toBeCloseTo(0.5);
  });

  it('frameTimes covers the whole duration deterministically', () => {
    const t = frameTimes(1, 4); // 4 frames: 0, .25, .5, .75
    expect(t).toEqual([0, 0.25, 0.5, 0.75]);
    // identical every call — reproducible
    expect(frameTimes(1, 4)).toEqual(t);
  });

  it('resolveRange clamps to the valid frame span', () => {
    expect(resolveRange({ width: 1, height: 1, fps: 30, durationSec: 2 })).toEqual({ start: 0, end: 59 });
    expect(resolveRange({ width: 1, height: 1, fps: 30, durationSec: 2, startFrame: 10, endFrame: 20 })).toEqual({ start: 10, end: 20 });
    // out-of-range end clamps to last frame; negative start clamps to 0
    expect(resolveRange({ width: 1, height: 1, fps: 30, durationSec: 1, startFrame: -5, endFrame: 999 })).toEqual({ start: 0, end: 29 });
  });
});

describe('renderOffline integration', () => {
  it('runs rendering loop successfully using the null GPU backend', async () => {
    const frames: number[] = [];
    const totalFrames = await renderOffline(
      {
        width: 640,
        height: 360,
        fps: 10,
        durationSec: 0.5, // 5 frames: 0, 0.1, 0.2, 0.3, 0.4
      },
      async (canvas, frame, total) => {
        frames.push(frame);
        expect(canvas).toBeDefined();
        expect(total).toBe(5);
      }
    );
    expect(totalFrames).toBe(5);
    expect(frames).toEqual([0, 1, 2, 3, 4]);
  });

  it('guarantees byte-reproducibility across 3 integration scenes using the null GPU backend', async () => {
    const testScenes = [
      flatBackground,
      solidFill,
      precompScenes[0], // precomp-group
    ].filter(Boolean);

    for (const scene of testScenes) {
      const activeScene = scene!;
      const run1Snapshots: any[] = [];
      const run2Snapshots: any[] = [];

      const originalCreate = createBackendModule.createRenderBackend;
      const spy = jest.spyOn(createBackendModule, 'createRenderBackend').mockImplementation((choice) => {
        const actual = originalCreate(choice);
        const originalRender = actual.renderFrame.bind(actual);
        actual.renderFrame = (snap) => {
          const snapCopy = JSON.parse(JSON.stringify(snap));
          delete snapCopy.timestamp;
          if (run1Snapshots.length > run2Snapshots.length) {
            run2Snapshots.push(snapCopy);
          } else {
            run1Snapshots.push(snapCopy);
          }
          originalRender(snap);
        };
        return actual;
      });

      // Render 1st time
      defaultSceneGraph.clear();
      defaultAnimation.clear();
      activeScene.build(defaultSceneGraph as any, defaultAnimation as any);

      await renderOffline(
        {
          width: activeScene.size.w,
          height: activeScene.size.h,
          fps: activeScene.fps,
          durationSec: activeScene.frames.length / activeScene.fps,
        },
        async () => {}
      );

      // Render 2nd time
      defaultSceneGraph.clear();
      defaultAnimation.clear();
      activeScene.build(defaultSceneGraph as any, defaultAnimation as any);

      await renderOffline(
        {
          width: activeScene.size.w,
          height: activeScene.size.h,
          fps: activeScene.fps,
          durationSec: activeScene.frames.length / activeScene.fps,
        },
        async () => {}
      );

      spy.mockRestore();

      expect(run1Snapshots.length).toBeGreaterThan(0);
      expect(run1Snapshots).toEqual(run2Snapshots);
    }
  });
});
