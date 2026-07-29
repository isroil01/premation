import { audioEngine, type AudioLayerState } from './AudioEngine';

describe('AudioEngine', () => {
  let mockContext: any;
  let mockSource: any;
  let mockGain: any;
  let mockDestination: any;

  beforeEach(() => {
    // Reset audioEngine singleton state by accessing private properties (hacky but works for singleton test)
    (audioEngine as any).ctx = null;
    (audioEngine as any).assets.clear();
    (audioEngine as any).loading.clear();
    (audioEngine as any).undecodable.clear();
    (audioEngine as any).voices.clear();
    (audioEngine as any).timeSec = 0;

    mockSource = {
      buffer: null,
      connect: jest.fn((dest) => dest),
      disconnect: jest.fn(),
      start: jest.fn(),
      stop: jest.fn(),
    };

    // Gain is SCHEDULED now, not assigned — the mock param records what was
    // scheduled so tests can assert the curve rather than a mutated `.value`.
    mockGain = {
      gain: {
        value: 1,
        scheduled: [] as Array<[number, number]>,
        setValueAtTime: jest.fn(function (this: any, v: number, t: number) {
          mockGain.gain.scheduled.push([t, v]);
          mockGain.gain.value = v;
        }),
        linearRampToValueAtTime: jest.fn((v: number, t: number) => {
          mockGain.gain.scheduled.push([t, v]);
        }),
        cancelScheduledValues: jest.fn(),
      },
      connect: jest.fn().mockReturnThis(),
      disconnect: jest.fn(),
    };

    mockDestination = {};

    mockContext = {
      state: 'running',
      currentTime: 0,
      resume: jest.fn(),
      createBufferSource: jest.fn(() => mockSource),
      createGain: jest.fn(() => mockGain),
      destination: mockDestination,
      decodeAudioData: jest.fn(async () => ({
        numberOfChannels: 1,
        length: 44100,
        duration: 1.0,
        getChannelData: () => new Float32Array(44100),
      })),
    };

    (window as any).AudioContext = jest.fn(() => mockContext);

    global.fetch = jest.fn().mockResolvedValue({
      arrayBuffer: async () => new ArrayBuffer(0),
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('Voice Reconciliation: starts voices for audible layers', async () => {
    const layer: AudioLayerState = {
      nodeId: 'n1',
      assetId: 'a1',
      src: 'http://test.com/audio.mp3',
      levelDb: 0,
      startSec: 0,
      inSec: 0,
      outSec: 10,
      muted: false,
    };

    // Load asset first
    await audioEngine.load('a1', 'http://test.com/audio.mp3');

    audioEngine.sync(true, 1.0, [layer]);

    expect(mockContext.createBufferSource).toHaveBeenCalled();
    expect(mockContext.createGain).toHaveBeenCalled();
    expect(mockSource.start).toHaveBeenCalledWith(0, 1.0, 9.0);
    expect(mockSource.connect).toHaveBeenCalledWith(mockGain);
    expect(mockGain.connect).toHaveBeenCalledWith(mockDestination);
  });

  test('Voice Reconciliation: stops voices when paused or muted', async () => {
    const layer: AudioLayerState = {
      nodeId: 'n1',
      assetId: 'a1',
      src: 'test.mp3',
      levelDb: 0,
      startSec: 0,
      inSec: 0,
      outSec: 10,
      muted: false,
    };

    await audioEngine.load('a1', 'test.mp3');
    audioEngine.sync(true, 1.0, [layer]);
    
    // Pause
    audioEngine.sync(false, 1.0, [layer]);
    expect(mockSource.stop).toHaveBeenCalled();
    expect(mockSource.disconnect).toHaveBeenCalled();

    // Mute
    mockSource.stop.mockClear();
    audioEngine.sync(true, 1.0, [layer]); // Start again
    const mutedLayer = { ...layer, muted: true };
    audioEngine.sync(true, 1.0, [mutedLayer]); // Muted
    expect(mockSource.stop).toHaveBeenCalled();
  });

  test('Seek Drift: restarts voice if drift exceeds tolerance', async () => {
    const layer: AudioLayerState = {
      nodeId: 'n1',
      assetId: 'a1',
      src: 'test.mp3',
      levelDb: 0,
      startSec: 0,
      inSec: 0,
      outSec: 10,
      muted: false,
    };

    await audioEngine.load('a1', 'test.mp3');
    
    // Start at t=1.0
    audioEngine.sync(true, 1.0, [layer]);
    expect(mockSource.start).toHaveBeenCalledTimes(1);

    // Context advances by 0.1s, playhead advances by 0.1s. NO drift.
    mockContext.currentTime = 0.1;
    audioEngine.sync(true, 1.1, [layer]);
    expect(mockSource.stop).not.toHaveBeenCalled(); // didn't restart

    // Context advances by 0.1s, playhead jumps to 5.0 (drift = 3.8s > 0.25s tolerance)
    mockContext.currentTime = 0.2;
    audioEngine.sync(true, 5.0, [layer]);
    
    expect(mockSource.stop).toHaveBeenCalled();
    expect(mockSource.start).toHaveBeenCalledTimes(2); // Restarted at new offset
  });

  test('Bar out-point: stops a running voice once the playhead passes it', async () => {
    // A bar trimmed to end at 2s. `source.start(…, duration)` bounds the voice
    // it was scheduled with, but a bar trimmed SHORTER mid-playback (or a jump
    // past the tail) leaves the voice's layer otherwise unchanged — without an
    // explicit out-point check the clip kept sounding past the end of its bar,
    // which is exactly the "audio ignores the timeline" complaint.
    const layer: AudioLayerState = {
      id: 'c1',
      nodeId: 'n1',
      assetId: 'a1',
      src: 'test.mp3',
      levelDb: 0,
      startSec: 0,
      inSec: 0,
      outSec: 2,
      muted: false,
    };

    await audioEngine.load('a1', 'test.mp3');
    audioEngine.sync(true, 1.0, [layer]);
    expect(mockSource.start).toHaveBeenCalledTimes(1);

    // Playhead and context both advance 1.5s — no drift, but now past the out.
    mockContext.currentTime = 1.5;
    audioEngine.sync(true, 2.5, [layer]);
    expect(mockSource.stop).toHaveBeenCalled();
    expect((audioEngine as any).voices.size).toBe(0);
  });

  test('Split bar: each clip of one node gets its own voice', async () => {
    // Two clips of the same asset, keyed by clip id. Keying by nodeId — as the
    // engine used to — let the second clip overwrite the first, so a split
    // audio layer only ever played one of its halves.
    const base = { nodeId: 'n1', assetId: 'a1', src: 'test.mp3', levelDb: 0, muted: false };
    const clips: AudioLayerState[] = [
      { ...base, id: 'c1', startSec: 0, inSec: 0, outSec: 1 },
      { ...base, id: 'c2', startSec: 0.5, inSec: 0.5, outSec: 1 },
    ];

    await audioEngine.load('a1', 'test.mp3');
    audioEngine.sync(true, 0.6, clips);

    expect((audioEngine as any).voices.size).toBe(2);
    expect(mockSource.start).toHaveBeenCalledTimes(2);
  });

  test('currentLevel only samples layers the playhead is actually over', async () => {
    // The old implementation read every DECODED asset at raw comp time, so
    // expressions reacted to clips the playhead had not reached, to muted
    // layers, and to assets whose layer had been deleted (the decode cache
    // outlives the scene).
    await audioEngine.load('a1', 'test.mp3');
    const layer: AudioLayerState = {
      id: 'c1',
      nodeId: 'n1',
      assetId: 'a1',
      src: 'test.mp3',
      levelDb: 0,
      startSec: 10,
      inSec: 0,
      outSec: 1,
      muted: false,
    };

    audioEngine.sync(false, 0, [layer]); // playhead well before the bar
    expect(audioEngine.currentLevel()).toBe(0);

    audioEngine.sync(false, 0, []); // decoded, but no layer references it
    expect(audioEngine.currentLevel()).toBe(0);
  });

  test('Per-layer gain: schedules the dB level as linear gain', async () => {
    const layer: AudioLayerState = {
      nodeId: 'n1',
      assetId: 'a1',
      src: 'test.mp3',
      levelDb: -6.020599913279624, // half amplitude
      startSec: 0,
      inSec: 0,
      outSec: 10,
      muted: false,
    };

    await audioEngine.load('a1', 'test.mp3');
    audioEngine.sync(true, 1.0, [layer]);

    // An unanimated level is one anchored point, not a ramp — the common case
    // must not pay for scheduling it does not need.
    expect(mockGain.gain.setValueAtTime).toHaveBeenCalledTimes(1);
    expect(mockGain.gain.linearRampToValueAtTime).not.toHaveBeenCalled();
    expect(mockGain.gain.scheduled[0][1]).toBeCloseTo(0.5, 6);
  });
});
