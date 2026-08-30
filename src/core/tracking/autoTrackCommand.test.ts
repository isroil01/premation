/**
 * The one-click command's job is to leave the tracker store in a state the
 * panel can render honestly — including when the analysis finds nothing, dies,
 * or is cancelled. Those three are the paths worth pinning: each one can leave
 * `tracking: true` or a stale result behind, and both look to the user like
 * the app has hung mid-track.
 *
 * The decoder half is stubbed; `autoTrack.test.ts` owns the measuring.
 */

import { useTrackerStore } from '@stores/trackerStore';
import { useCompositionStore } from '@stores/compositionStore';
import type { AutoTrackVideoResult } from './trackVideoLayer';

const autoTrackVideoLayer = jest.fn();
jest.mock('./trackVideoLayer', () => ({
  autoTrackVideoLayer: (...args: unknown[]) => autoTrackVideoLayer(...args),
}));

// Imported after the mock so the command binds to the stub.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { runAutoTrack } = require('./autoTrackCommand') as typeof import('./autoTrackCommand');

const sample = (frame: number, coasted = false) => ({
  compTime: frame / 30,
  x: 100 + frame,
  y: 50,
  confidence: 0.9,
  coasted,
});

function result(overrides: Partial<AutoTrackVideoResult> = {}): AutoTrackVideoResult {
  return {
    tracks: [[sample(0), sample(1), sample(2)]],
    sourceWidth: 1920,
    sourceHeight: 1080,
    plan: {
      x: 640,
      y: 360,
      featureHalf: 8,
      searchHalf: 20,
      motionPerFrame: 3.25,
      strength: 0.02,
      distinctness: 0.8,
    },
    status: 'completed',
    ...overrides,
  };
}

beforeEach(() => {
  autoTrackVideoLayer.mockReset();
  useTrackerStore.getState().clear();
  useTrackerStore.getState().activate('video_1');
  useTrackerStore.getState().seedPoints(1920, 1080);
  useCompositionStore.setState({ fps: 30 } as never);
});

describe('runAutoTrack', () => {
  it('stores the samples, the plan and the measured window sizes', async () => {
    autoTrackVideoLayer.mockResolvedValue(result());
    await runAutoTrack({ nodeId: 'video_1', hint: { x: 600, y: 300 } });

    const s = useTrackerStore.getState();
    expect(s.tracking).toBe(false);
    expect(s.autoPhase).toBe('idle');
    expect(s.result?.tracks[0]).toHaveLength(3);
    expect(s.autoPlan?.distinctness).toBe(0.8);
    // The plan's windows become the panel's windows, so "Track again" and the
    // manual controls continue from what the analysis actually used.
    expect(s.featureHalf).toBe(8);
    expect(s.searchHalf).toBe(20);
    expect(s.points[0]).toEqual({ x: 640, y: 360 });
  });

  it('passes the click through as the hint', async () => {
    autoTrackVideoLayer.mockResolvedValue(result());
    await runAutoTrack({ nodeId: 'video_1', hint: { x: 600, y: 300 } });
    expect(autoTrackVideoLayer).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: 'video_1', hint: { x: 600, y: 300 }, fps: 30 }),
    );
  });

  it('omits the hint entirely when there is none, rather than sending undefined', async () => {
    autoTrackVideoLayer.mockResolvedValue(result());
    await runAutoTrack({ nodeId: 'video_1' });
    expect(autoTrackVideoLayer.mock.calls[0]![0]).not.toHaveProperty('hint');
  });

  it('reports "nothing trackable" without leaving a stale result', async () => {
    useTrackerStore.setState({ result: { tracks: [[sample(0)]], sourceWidth: 1, sourceHeight: 1, status: 'completed' } });
    autoTrackVideoLayer.mockResolvedValue(null);
    await runAutoTrack({ nodeId: 'video_1' });

    const s = useTrackerStore.getState();
    expect(s.result).toBeNull();
    expect(s.tracking).toBe(false);
    expect(s.note).toMatch(/nothing trackable/i);
  });

  it('keeps what a cancelled walk measured, and says so', async () => {
    autoTrackVideoLayer.mockResolvedValue(result({ status: 'cancelled', tracks: [[sample(0), sample(1)]] }));
    await runAutoTrack({ nodeId: 'video_1' });

    const s = useTrackerStore.getState();
    expect(s.result?.tracks[0]).toHaveLength(2);
    expect(s.result?.status).toBe('cancelled');
    expect(s.note).toMatch(/cancelled/i);
  });

  it('maps a partial walk onto the store’s "lost" vocabulary', async () => {
    autoTrackVideoLayer.mockResolvedValue(result({ status: 'partial' }));
    await runAutoTrack({ nodeId: 'video_1' });
    expect(useTrackerStore.getState().result?.status).toBe('lost');
    expect(useTrackerStore.getState().note).toMatch(/lost part-way/i);
  });

  it('names the coasted frames, which look identical in the curve', async () => {
    autoTrackVideoLayer.mockResolvedValue(
      result({ tracks: [[sample(0), sample(1, true), sample(2, true), sample(3)]] }),
    );
    await runAutoTrack({ nodeId: 'video_1' });
    expect(useTrackerStore.getState().note).toMatch(/2 predicted through occlusion/);
  });

  it('warns when the chosen feature has look-alikes nearby', async () => {
    autoTrackVideoLayer.mockResolvedValue(
      result({ plan: { ...result().plan, distinctness: 0.2 } }),
    );
    await runAutoTrack({ nodeId: 'video_1' });
    expect(useTrackerStore.getState().note).toMatch(/look-alikes/);
  });

  it('rejects a one-sample track instead of offering keyframes that animate nothing', async () => {
    autoTrackVideoLayer.mockResolvedValue(result({ tracks: [[sample(0)]] }));
    await runAutoTrack({ nodeId: 'video_1' });
    expect(useTrackerStore.getState().result).toBeNull();
    expect(useTrackerStore.getState().note).toMatch(/lost immediately/i);
  });

  it('turns a thrown decoder error into a readable line, not an unhandled rejection', async () => {
    autoTrackVideoLayer.mockRejectedValue(new Error('Source unreadable (404).'));
    await expect(runAutoTrack({ nodeId: 'video_1' })).resolves.toBeUndefined();

    const s = useTrackerStore.getState();
    expect(s.tracking).toBe(false);
    expect(s.autoPhase).toBe('idle');
    expect(s.note).toBe('Source unreadable (404).');
  });

  it('refuses to start a second run on top of a running one', async () => {
    useTrackerStore.getState().beginTracking();
    await runAutoTrack({ nodeId: 'video_1' });
    expect(autoTrackVideoLayer).not.toHaveBeenCalled();
  });

  it('switches a multi-point mode to follow, so the result can be applied', async () => {
    // A single tracked feature cannot drive a four-corner planar pin; leaving
    // the panel in `corner` would show an Apply button that does nothing.
    useTrackerStore.getState().setMode('corner', 1920, 1080);
    autoTrackVideoLayer.mockResolvedValue(result());
    await runAutoTrack({ nodeId: 'video_1' });

    expect(useTrackerStore.getState().mode).toBe('follow');
    expect(useTrackerStore.getState().points).toHaveLength(1);
    expect(useTrackerStore.getState().result?.tracks[0]).toHaveLength(3);
  });
});
