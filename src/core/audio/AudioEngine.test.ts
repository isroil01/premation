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
    (audioEngine as any).voices.clear();
    (audioEngine as any).timeSec = 0;

    mockSource = {
      buffer: null,
      connect: jest.fn((dest) => dest),
      disconnect: jest.fn(),
      start: jest.fn(),
      stop: jest.fn(),
    };

    mockGain = {
      gain: { value: 1 },
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
      level: 100,
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
      level: 100,
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
      level: 100,
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

  test('Per-layer gain: maps layer level to GainNode', async () => {
    const layer: AudioLayerState = {
      nodeId: 'n1',
      assetId: 'a1',
      src: 'test.mp3',
      level: 50, // 50%
      startSec: 0,
      inSec: 0,
      outSec: 10,
      muted: false,
    };

    await audioEngine.load('a1', 'test.mp3');
    audioEngine.sync(true, 1.0, [layer]);

    expect(mockGain.gain.value).toBe(0.5); // 50 / 100
  });
});
