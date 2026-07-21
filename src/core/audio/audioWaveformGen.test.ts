/**
 * Unit tests for the PURE audio-waveform-envelope path generator. No scene, no
 * AudioEngine — just peaks + config → deterministic bezier corner points.
 */

import { audioWaveformPoints, defaultAudioWaveform } from './audioWaveformGen';

const PEAKS = new Float32Array([0, 0.25, 0.5, 0.75, 1, 0.75, 0.5, 0.25]);

describe('audioWaveformPoints (envelope, not spectrum)', () => {
  it('produces 2·samples points (mirrored top + bottom outline)', () => {
    const cfg = { ...defaultAudioWaveform('a'), samples: 16, thickness: 0, heightScale: 1 };
    const pts = audioWaveformPoints(PEAKS, 1, 200, 100, 0, cfg);
    expect(pts).toHaveLength(32);
  });

  it('is mirrored across the horizontal midline (top = -bottom in x-order)', () => {
    const cfg = { ...defaultAudioWaveform('a'), samples: 8, thickness: 0, heightScale: 1 };
    const pts = audioWaveformPoints(PEAKS, 1, 100, 100, 0, cfg);
    const n = cfg.samples;
    const top = pts.slice(0, n);
    const bottom = pts.slice(n).reverse(); // undo the reverse the generator applies
    for (let i = 0; i < n; i++) {
      expect(bottom[i]!.x).toBeCloseTo(top[i]!.x, 6);
      expect(bottom[i]!.y).toBeCloseTo(-top[i]!.y, 6);
    }
  });

  it('spans ±width/2 in x and stays within ±height/2 in y', () => {
    const cfg = { ...defaultAudioWaveform('a'), samples: 12, thickness: 0, heightScale: 1 };
    const W = 240;
    const H = 80;
    const pts = audioWaveformPoints(PEAKS, 1, W, H, 0, cfg);
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    expect(Math.min(...xs)).toBeCloseTo(-W / 2, 6);
    expect(Math.max(...xs)).toBeCloseTo(W / 2, 6);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(-H / 2 - 1e-6);
    expect(Math.max(...ys)).toBeLessThanOrEqual(H / 2 + 1e-6);
  });

  it('is deterministic — identical inputs yield identical points', () => {
    const cfg = { ...defaultAudioWaveform('a'), samples: 20 };
    const a = audioWaveformPoints(PEAKS, 1, 300, 120, 0.4, cfg);
    const b = audioWaveformPoints(PEAKS, 1, 300, 120, 0.4, cfg);
    expect(a).toEqual(b);
  });

  it('a full-amplitude envelope fills the whole half-height (amp 1 → H/2)', () => {
    const full = new Float32Array([1, 1, 1, 1, 1, 1]);
    const cfg = { ...defaultAudioWaveform('a'), samples: 9, thickness: 0, heightScale: 1 };
    const H = 100;
    const pts = audioWaveformPoints(full, 1, 100, H, 0, cfg);
    for (const p of pts) expect(Math.abs(p.y)).toBeCloseTo(H / 2, 6);
  });

  it('heightScale scales the envelope amplitude', () => {
    const full = new Float32Array([1, 1, 1, 1]);
    const cfg = { ...defaultAudioWaveform('a'), samples: 6, thickness: 0, heightScale: 0.5 };
    const H = 100;
    const pts = audioWaveformPoints(full, 1, 100, H, 0, cfg);
    for (const p of pts) expect(Math.abs(p.y)).toBeCloseTo(25, 6); // 0.5 · H/2
  });

  it('thickness enforces a minimum half-height even at silence', () => {
    const silent = new Float32Array([0, 0, 0, 0]);
    const cfg = { ...defaultAudioWaveform('a'), samples: 4, thickness: 6, heightScale: 1 };
    const pts = audioWaveformPoints(silent, 1, 100, 100, 0, cfg);
    // Every point sits at half the thickness off the midline (3px), not 0.
    for (const p of pts) expect(Math.abs(p.y)).toBeCloseTo(3, 6);
  });

  it('returns [] when there are no peaks (nothing to draw)', () => {
    const cfg = defaultAudioWaveform('a');
    expect(audioWaveformPoints(new Float32Array([]), 1, 100, 100, 0, cfg)).toEqual([]);
  });

  it('returns [] for non-positive size', () => {
    const cfg = defaultAudioWaveform('a');
    expect(audioWaveformPoints(PEAKS, 1, 0, 100, 0, cfg)).toEqual([]);
    expect(audioWaveformPoints(PEAKS, 1, 100, 0, 0, cfg)).toEqual([]);
  });

  it('playhead-window mode reads silence outside the clip bounds', () => {
    // Window centred well past the clip end → all columns outside [0,1] → flat.
    const cfg = { ...defaultAudioWaveform('a'), samples: 8, mode: 'playhead-window' as const, windowSec: 0.5, thickness: 0 };
    const pts = audioWaveformPoints(PEAKS, 1, 100, 100, 10, cfg);
    for (const p of pts) expect(p.y).toBeCloseTo(0, 6);
  });
});
