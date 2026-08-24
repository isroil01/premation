import { audioGridUsable, sequenceToAudioGrid } from './audioGrid';
import type { CreativeBrief } from './types';

const brief: CreativeBrief = {
  lookPackId: 'luxury_film',
  energy: 0.5,
  tone: 'test',
  totalDurationMs: 8000,
  beats: [
    { purpose: 'hero', weight: 1, content: { headline: 'One' } },
    { purpose: 'support', weight: 1, content: { subhead: 'Two' } },
    { purpose: 'cta', weight: 1, content: { cta: 'Go' } },
  ],
};

describe('audioGridUsable', () => {
  it('requires tempo confidence, beats, and duration', () => {
    expect(audioGridUsable(undefined)).toBe(false);
    expect(audioGridUsable({ beats: [0, 1, 2, 3], durationSec: 4, tempoConfidence: 0.1 })).toBe(false);
    expect(audioGridUsable({ beats: [0, 0.5], durationSec: 4, tempoConfidence: 0.9 })).toBe(false);
    expect(audioGridUsable({ beats: [0, 0.5, 1, 1.5], durationSec: 4, tempoConfidence: 0.9 })).toBe(true);
  });
});

describe('sequenceToAudioGrid', () => {
  it('aligns beat cuts to detected transients', () => {
    const seq = sequenceToAudioGrid(brief, {
      beats: [0, 1, 2, 3, 4, 5, 6, 7],
      durationSec: 8,
      tempoConfidence: 0.9,
    });
    expect(seq.beats).toHaveLength(3);
    expect(seq.beats[0]!.startMs).toBe(0);
    expect(seq.beats[1]!.startMs).toBeGreaterThan(0);
    expect(seq.beats[2]!.startMs).toBeGreaterThan(seq.beats[1]!.startMs);
    expect(seq.totalDurationMs).toBeLessThanOrEqual(8000);
  });
});
