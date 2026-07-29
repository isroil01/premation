/**
 * Filmstrip sampling — the part of Phase 4.2 that is testable without a GPU.
 *
 * The compositing needs a real canvas and the renderer needs a real backend, so
 * neither runs here. What DOES run is the thing the old critique pass got wrong:
 * **where** to sample. Three stills at fixed percentages step straight over short
 * events, and that blindness — not the model — is why critique never caught bad
 * timing.
 */

import type { ToolContext } from '@motion/ai-tools';
import { filmstripTimes, sampleVelocities, STRIP_MAX } from './filmstrip';

interface FakeTrack {
  prop: string;
  keyframes: { t: number; value: number; easing: string }[];
}

/** A ToolContext with just enough surface for the sampler. */
function fakeCtx(nodes: { id: string; name: string; tracks: FakeTrack[] }[]): ToolContext {
  return {
    scene: {
      all: () => nodes.map((n) => ({
        id: n.id, name: n.name, kind: 'text', parent: null,
        visible: true, locked: false, x: 0, y: 0, rotation: 0, opacity: 100, animated: [],
      })),
    },
    anim: {
      tracks: (id: string) => nodes.find((n) => n.id === id)?.tracks ?? [],
      evaluate: (id: string, t: number) => {
        const node = nodes.find((n) => n.id === id);
        const out: Record<string, number> = {};
        for (const tr of node?.tracks ?? []) {
          // Linear between keyframes — enough for the velocity sampler to have
          // something with a real derivative.
          const kfs = tr.keyframes;
          if (!kfs.length) continue;
          if (t <= kfs[0]!.t) { out[tr.prop] = kfs[0]!.value; continue; }
          if (t >= kfs[kfs.length - 1]!.t) { out[tr.prop] = kfs[kfs.length - 1]!.value; continue; }
          for (let i = 1; i < kfs.length; i++) {
            const a = kfs[i - 1]!, b = kfs[i]!;
            if (t >= a.t && t <= b.t) {
              const k = (t - a.t) / Math.max(1e-9, b.t - a.t);
              out[tr.prop] = a.value + (b.value - a.value) * k;
              break;
            }
          }
        }
        return out;
      },
    },
    time: { toCompTime: (_id: string, t: number) => t, toLayerTime: (_id: string, t: number) => t },
  } as unknown as ToolContext;
}

const kf = (t: number, value: number) => ({ t, value, easing: 'linear' });

describe('filmstripTimes', () => {
  it('samples every keyframe, so a short event cannot be stepped over', () => {
    // The exact failure the old 35/70/last sampling had: a 0.9s sweep on a 15s
    // composition falls entirely between two samples 5 seconds apart.
    const ctx = fakeCtx([{
      id: 'sweep', name: 'Light Sweep',
      tracks: [{ prop: 'x', keyframes: [kf(6.2, -480), kf(7.1, 2400)] }],
    }]);
    const times = filmstripTimes(ctx, 15);
    expect(times).toContain(6.2);
    expect(times).toContain(7.1);
  });

  it('samples the MIDPOINT of every keyframe pair — that is where easing shows', () => {
    // The endpoints of an eased segment look identical whatever curve joins them.
    const ctx = fakeCtx([{ id: 'a', name: 'A', tracks: [{ prop: 'y', keyframes: [kf(1, 0), kf(3, 100)] }] }]);
    expect(filmstripTimes(ctx, 5)).toContain(2);
  });

  it('always includes the start and the final held frame', () => {
    const ctx = fakeCtx([{ id: 'a', name: 'A', tracks: [{ prop: 'y', keyframes: [kf(1, 0), kf(2, 1)] }] }]);
    const times = filmstripTimes(ctx, 8);
    expect(times[0]).toBe(0);
    expect(times[times.length - 1]).toBe(8);
  });

  it('caps the strip', () => {
    const tracks: FakeTrack[] = [];
    for (let i = 0; i < 30; i++) {
      tracks.push({ prop: `p${i}`, keyframes: [kf(i * 0.3, 0), kf(i * 0.3 + 0.15, 1)] });
    }
    expect(filmstripTimes(fakeCtx([{ id: 'a', name: 'A', tracks }]), 12).length).toBeLessThanOrEqual(STRIP_MAX);
  });

  it('thins from DENSE clusters, keeping isolated events', () => {
    // Uniform decimation would drop half of a tight cluster and half of the one
    // isolated event. The isolated event is the one that cannot be inferred from
    // its neighbours, so it is the one that must survive.
    const cluster: FakeTrack[] = [];
    for (let i = 0; i < 26; i++) cluster.push({ prop: `c${i}`, keyframes: [kf(1 + i * 0.01, 0), kf(1 + i * 0.01 + 0.005, 1)] });
    cluster.push({ prop: 'lonely', keyframes: [kf(9.5, 0), kf(9.6, 1)] });

    const times = filmstripTimes(fakeCtx([{ id: 'a', name: 'A', tracks: cluster }]), 12);
    expect(times.length).toBeLessThanOrEqual(STRIP_MAX);
    expect(times.some((t) => Math.abs(t - 9.5) < 0.01)).toBe(true);
  });

  it('never samples outside the composition', () => {
    const ctx = fakeCtx([{ id: 'a', name: 'A', tracks: [{ prop: 'y', keyframes: [kf(-2, 0), kf(99, 1)] }] }]);
    for (const t of filmstripTimes(ctx, 6)) {
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(6);
    }
  });

  it('returns something usable for a scene with no animation at all', () => {
    expect(filmstripTimes(fakeCtx([]), 5).length).toBeGreaterThan(1);
  });

  it('is sorted', () => {
    const ctx = fakeCtx([
      { id: 'b', name: 'B', tracks: [{ prop: 'y', keyframes: [kf(4, 0), kf(5, 1)] }] },
      { id: 'a', name: 'A', tracks: [{ prop: 'x', keyframes: [kf(1, 0), kf(2, 1)] }] },
    ]);
    const times = filmstripTimes(ctx, 8);
    expect([...times].sort((x, y) => x - y)).toEqual(times);
  });
});

describe('sampleVelocities', () => {
  it('measures SPEED, not value — the thing a still cannot show', () => {
    const ctx = fakeCtx([{ id: 'a', name: 'Mover', tracks: [{ prop: 'x', keyframes: [kf(0, 0), kf(1, 100)] }] }]);
    const [track] = sampleVelocities(ctx, 2, { samples: 40 });
    expect(track!.label).toBe('Mover.x');
    // ~100 units/sec while moving, ~0 after it stops.
    expect(Math.max(...track!.samples)).toBeGreaterThan(50);
    expect(track!.samples[track!.samples.length - 1]).toBeLessThan(5);
  });

  it('ranks by how far a property actually travels', () => {
    // A graph of a 2px drift tells nobody anything and crowds out the one that
    // matters.
    const ctx = fakeCtx([{
      id: 'a', name: 'A',
      tracks: [
        { prop: 'rotation', keyframes: [kf(0, 0), kf(1, 2)] },
        { prop: 'x', keyframes: [kf(0, 0), kf(1, 900)] },
      ],
    }]);
    expect(sampleVelocities(ctx, 2)[0]!.label).toBe('A.x');
  });

  it('ignores constant tracks and non-hero properties', () => {
    const ctx = fakeCtx([{
      id: 'a', name: 'A',
      tracks: [
        { prop: 'x', keyframes: [kf(0, 50), kf(1, 50)] },
        { prop: 'effect.blur_1.blur', keyframes: [kf(0, 0), kf(1, 20)] },
      ],
    }]);
    expect(sampleVelocities(ctx, 2)).toEqual([]);
  });

  it('caps the number of graphs', () => {
    const tracks: FakeTrack[] = ['x', 'y', 'scale', 'scaleX', 'scaleY', 'rotation', 'opacity', 'z']
      .map((prop, i) => ({ prop, keyframes: [kf(0, 0), kf(1, 100 + i)] }));
    expect(sampleVelocities(fakeCtx([{ id: 'a', name: 'A', tracks }]), 2).length).toBeLessThanOrEqual(6);
  });
});
