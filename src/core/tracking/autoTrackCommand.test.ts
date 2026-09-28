/**
 * The one-click command's job is to leave the tracker store in a state the
 * panel can render honestly — including when the engine's trackMotion job
 * finds nothing, fails, or is cancelled. Each of those can leave
 * `tracking: true` or a stale result behind, and both look to the user like
 * the app has hung mid-track.
 *
 * The engine job is stubbed; the C++ tracker's own tests own the measuring.
 */

import { useTrackerStore } from '@stores/trackerStore';

const startEngineJob = jest.fn();
jest.mock('@core/engine/engineJobs', () => ({
  startEngineJob: (...args: unknown[]) => startEngineJob(...args),
  requireEngineJob: <T,>(v: T | null, what: string): T => {
    if (!v) throw new Error(`${what} runs in the engine, and this engine does not run it.`);
    return v;
  },
}));
jest.mock('@core/engine/engineInstance', () => ({
  engine: () => ({
    query: async () => ({ ok: true, value: { sizes: [{ layer: 'video_1', width: 1920, height: 1080 }] } }),
  }),
}));

jest.mock('@stores/documentMirror', () => ({
  documentMirror: () => ({ layer: () => undefined, comp: () => undefined }),
}));

// Imported after the mocks so the command binds to the stubs.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { runAutoTrack } = require('./autoTrackCommand') as typeof import('./autoTrackCommand');

type Sample = [number, number, number, number, number];
const sample = (frame: number, coasted = false): Sample => [frame / 30, 100 + frame, 50, 0.9, coasted ? 1 : 0];

function job(out: { status: string; result?: unknown; error?: { message: string } }) {
  startEngineJob.mockResolvedValue({ cancel: jest.fn(), done: Promise.resolve(out) });
}

function done(tracks: Sample[][], status: 'completed' | 'lost' | 'partial' = 'completed') {
  job({ status: 'done', result: { status, sourceWidth: 1920, sourceHeight: 1080, tracks } });
}

beforeEach(() => {
  startEngineJob.mockReset();
  useTrackerStore.getState().clear();
  useTrackerStore.getState().activate('video_1');
  useTrackerStore.getState().seedPoints(1920, 1080);
});

describe('runAutoTrack', () => {
  it('stores the samples, the plan and the window sizes it sent', async () => {
    done([[sample(0), sample(1), sample(2)]]);
    await runAutoTrack({ nodeId: 'video_1', hint: { x: 600, y: 300 }, radius: 8 });

    const s = useTrackerStore.getState();
    expect(s.tracking).toBe(false);
    expect(s.result?.tracks[0]).toHaveLength(3);
    expect(s.result?.tracks[0]![0]).toEqual({ compTime: 0, x: 100, y: 50, confidence: 0.9, coasted: false });
    expect(s.featureHalf).toBe(8);
    expect(s.searchHalf).toBe(19);
    expect(s.points[0]).toEqual({ x: 600, y: 300 });
  });

  it('sends one position point at the click, tracked both ways', async () => {
    done([[sample(0), sample(1)]]);
    await runAutoTrack({ nodeId: 'video_1', hint: { x: 600, y: 300 }, radius: 8 });
    const req = startEngineJob.mock.calls[0]![0] as { kind: string; value: Record<string, unknown> };
    expect(req.kind).toBe('trackMotion');
    expect(req.value).toMatchObject({ layer: 'video_1', kind: 'position', direction: 'both' });
    expect((req.value.points as Array<{ feature: unknown }>)[0]!.feature).toEqual({ x: 600, y: 300, width: 17, height: 17 });
  });

  it('tracks the frame centre when there is no click', async () => {
    done([[sample(0), sample(1)]]);
    await runAutoTrack({ nodeId: 'video_1' });
    const req = startEngineJob.mock.calls[0]![0] as { value: { points: Array<{ feature: { x: number; y: number } }> } };
    expect(req.value.points[0]!.feature).toMatchObject({ x: 960, y: 540 });
  });

  it('ends a cancelled or failed job with a note and no result', async () => {
    job({ status: 'cancelled' });
    await runAutoTrack({ nodeId: 'video_1' });
    const s = useTrackerStore.getState();
    expect(s.result).toBeNull();
    expect(s.tracking).toBe(false);
    expect(s.note).toMatch(/cancelled/i);
  });

  it('maps a partial walk onto the store’s "lost" vocabulary', async () => {
    done([[sample(0), sample(1), sample(2)]], 'partial');
    await runAutoTrack({ nodeId: 'video_1' });
    expect(useTrackerStore.getState().result?.status).toBe('lost');
    expect(useTrackerStore.getState().note).toMatch(/lost part-way/i);
  });

  it('names the coasted frames, which look identical in the curve', async () => {
    done([[sample(0), sample(1, true), sample(2, true), sample(3)]]);
    await runAutoTrack({ nodeId: 'video_1' });
    expect(useTrackerStore.getState().note).toMatch(/2 predicted through occlusion/);
  });

  it('rejects a one-sample track instead of offering keyframes that animate nothing', async () => {
    done([[sample(0)]]);
    await runAutoTrack({ nodeId: 'video_1' });
    expect(useTrackerStore.getState().result).toBeNull();
    expect(useTrackerStore.getState().note).toMatch(/lost immediately/i);
  });

  it('turns an engine without the job into a readable line, not an unhandled rejection', async () => {
    startEngineJob.mockResolvedValue(null);
    await expect(runAutoTrack({ nodeId: 'video_1' })).resolves.toBeUndefined();
    expect(useTrackerStore.getState().tracking).toBe(false);
    expect(useTrackerStore.getState().note).toMatch(/runs in the engine/);
  });

  it('switches a multi-point mode to follow, so the result can be applied', async () => {
    useTrackerStore.getState().setMode('corner', 1920, 1080);
    done([[sample(0), sample(1)]]);
    await runAutoTrack({ nodeId: 'video_1' });
    expect(useTrackerStore.getState().mode).toBe('follow');
  });
});
