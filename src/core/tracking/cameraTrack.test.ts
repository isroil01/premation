import { flicksToSeconds, secondsToFlicks, type CameraSolveData } from '@motion/engine-api';
import { trackPointLayersJob, groundPlaneJob, projectTrackPoints, solveJob } from './cameraTrack';
import { useCameraTrackStore } from '@stores/cameraTrackStore';

const solve: CameraSolveData = {
  camera: 'cam', focal: 1000, sourceWidth: 1920, sourceHeight: 1080,
  frames: [{ time: secondsToFlicks(0), rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], center: { x: 0, y: 0, z: 0 } }],
  points: [{ x: 0, y: 0, z: 10 }, { x: 1, y: 0.5, z: 5 }, { x: 0, y: 0, z: -3 }, { x: 100, y: 0, z: 1 }],
  pointErrors: [0.3, 0.8, 0.1, 0.2],
  worldOrigin: { x: 960, y: 540, z: -1000 }, worldScale: 100, worldRotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], worldCentroid: { x: 0, y: 0, z: 0 },
};

describe('camera tracker, editor side', () => {
  it('projects the solve points through the camera at the playhead', () => {
    const pts = projectTrackPoints(solve, 0);
    // Point 2 is behind the camera, point 3 off the frame.
    expect(pts.map((p) => p.index)).toEqual([0, 1]);
    expect(pts[0]).toMatchObject({ x: 960, y: 540, error: 0.3 });
    expect(pts[1]!.x).toBeCloseTo(960 + 1000 * (1 / 5));
    expect(pts[1]!.y).toBeCloseTo(540 + 1000 * (0.5 / 5));
    expect(projectTrackPoints(solve, 1)).toEqual([]);  // no solved frame there
  });

  it('builds the three job requests', () => {
    const s = solveJob('L', 1, 4, 1200);
    if (s.kind !== 'cameraTrack') throw new Error('kind');
    expect(s.value.action).toBe('solve');
    expect(flicksToSeconds(s.value.range.duration)).toBeCloseTo(3);
    expect(s.value.focalLength).toBe(1200);
    const g = groundPlaneJob('L', [1, 2, 3]);
    if (g.kind !== 'cameraTrack') throw new Error('kind');
    expect(g.value).toMatchObject({ action: 'groundPlane', points: [1, 2, 3] });
    const c = trackPointLayersJob('L', [4], 'shadowCatcher');
    if (c.kind !== 'cameraTrack') throw new Error('kind');
    expect(c.value).toMatchObject({ action: 'createLayers', create: 'shadowCatcher' });
  });

  it('selects, toggles and keeps the selection per layer', () => {
    const st = useCameraTrackStore.getState();
    st.setSolve('L', solve);
    st.pick(1, false);
    st.pick(0, true);
    expect(useCameraTrackStore.getState().selected).toEqual([1, 0]);
    st.pick(1, true);
    expect(useCameraTrackStore.getState().selected).toEqual([0]);
    st.selectMany([2, 3], true);
    expect(useCameraTrackStore.getState().selected).toEqual([0, 2, 3]);
    st.setSolve('M', solve);
    expect(useCameraTrackStore.getState().selected).toEqual([]);
  });
});
