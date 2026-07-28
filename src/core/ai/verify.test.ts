/**
 * The false-positive table from docs/ai-audit.md, as tests.
 *
 * A first attempt at this verifier flagged five issues against known-good
 * compose-tool output and all five were wrong. Those three shapes ("does not
 * flag …" below) are the reason each check is written the way it is — they
 * matter more than the positive cases, because a verifier that reports correct
 * work sends the model off to damage it.
 */

import { verifyScene, formatFindings, type Finding } from './verify';
import type { ToolContext } from '@motion/ai-tools';

interface FakeLayer {
  id: string;
  name: string;
  kind?: string;
  x?: number;
  y?: number;
  opacity?: number;
  width?: number;
  height?: number;
  visible?: boolean;
  /** prop -> keyframes, in layer time (which here equals comp time). */
  tracks?: Record<string, Array<{ t: number; value: number }>>;
}

/**
 * Minimal ToolContext over plain objects. Only the facades verifyScene touches
 * are implemented; `evaluate` linearly interpolates, which is all the checks
 * need (they sample values, they don't care about easing).
 */
function ctxOf(layers: FakeLayer[], durationSeconds = 5): ToolContext {
  const byId = new Map(layers.map((l) => [l.id, l]));
  const view = (l: FakeLayer): any => ({
    id: l.id,
    name: l.name,
    kind: l.kind ?? 'shape',
    parent: null,
    visible: l.visible ?? true,
    locked: false,
    x: l.x ?? 960,
    y: l.y ?? 540,
    rotation: 0,
    opacity: l.opacity ?? 100,
    width: l.width,
    height: l.height,
    animated: Object.keys(l.tracks ?? {}),
  });

  return {
    scene: {
      all: () => layers.map(view),
      get: (id: string) => { const l = byId.get(id); return l ? view(l) : undefined; },
      has: (id: string) => byId.has(id),
    },
    anim: {
      tracks: (id: string) =>
        Object.entries(byId.get(id)?.tracks ?? {}).map(([prop, keyframes]) => ({
          prop,
          keyframes: keyframes.map((k) => ({ ...k, easing: 'linear' })),
        })),
      evaluate: (id: string, t: number) => {
        const out: Record<string, number> = {};
        for (const [prop, kfs] of Object.entries(byId.get(id)?.tracks ?? {})) {
          const first = kfs[0];
          const last = kfs[kfs.length - 1];
          if (!first || !last) continue;
          if (t <= first.t) { out[prop] = first.value; continue; }
          if (t >= last.t) { out[prop] = last.value; continue; }
          for (let i = 1; i < kfs.length; i++) {
            const a = kfs[i - 1]!;
            const b = kfs[i]!;
            if (t <= b.t) {
              const f = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
              out[prop] = a.value + (b.value - a.value) * f;
              break;
            }
          }
        }
        return out;
      },
    },
    comp: { get: () => ({ width: 1920, height: 1080, fps: 30, durationSeconds, background: '#000' }) },
    time: { toLayerTime: (_id: string, t: number) => t, toCompTime: (_id: string, t: number) => t },
  } as unknown as ToolContext;
}

const kinds = (f: Finding[]): string[] => f.map((x) => x.kind);

// ─────────────────────────────────────────────────────────────────────────────
// The three false positives. These are the load-bearing tests.
// ─────────────────────────────────────────────────────────────────────────────

describe('the audit\'s false positives stay unflagged', () => {
  it('does not flag a light sweep that starts offscreen and animates across', () => {
    // Flagged twice by the naive verifier. The sweep is at x = -480 by design
    // and travels to x = 2400 — a static bounds check sees only the start.
    const findings = verifyScene(ctxOf([
      {
        id: 'sweep', name: 'Light Sweep', width: 400, height: 1080,
        tracks: { x: [{ t: 0.77, value: -480 }, { t: 1.67, value: 2400 }] },
      },
    ]));
    expect(kinds(findings)).not.toContain('offscreen');
  });

  it('does not flag ambient orbs sharing a single opacity keyframe', () => {
    // Flagged twice as "5 layers at 0.000s". One keyframe is a constant, not
    // an entrance — these orbs never animate at all.
    const orbs: FakeLayer[] = Array.from({ length: 5 }, (_, i) => ({
      id: `orb${i}`, name: `Orb ${i}`, width: 120, height: 120,
      tracks: { opacity: [{ t: 0, value: 40 }] },
    }));
    expect(kinds(verifyScene(ctxOf(orbs)))).not.toContain('simultaneous');
  });

  it('does not flag a blur_resolve title as opacity-only', () => {
    // Flagged once. blur_resolve pairs the fade with an EFFECT parameter
    // rather than a transform, which is still a proper entrance.
    const findings = verifyScene(ctxOf([
      {
        id: 'title', name: 'Title', width: 800, height: 120,
        tracks: {
          opacity: [{ t: 0.2, value: 0 }, { t: 0.9, value: 100 }],
          'effect.blur1.amount': [{ t: 0.2, value: 24 }, { t: 0.9, value: 0 }],
        },
      },
    ]));
    expect(kinds(findings)).not.toContain('opacity-only');
  });

  it('does not flag a layer that fades up from opacity 0', () => {
    // The same trap as the light sweep, one axis over: a layer whose opacity
    // STARTS at zero is the normal case, not an invisible layer.
    const findings = verifyScene(ctxOf([
      {
        id: 'a', name: 'Fader', width: 400, height: 200, opacity: 0,
        tracks: {
          opacity: [{ t: 0, value: 0 }, { t: 0.6, value: 100 }],
          y: [{ t: 0, value: 600 }, { t: 0.6, value: 540 }],
        },
      },
    ]));
    expect(kinds(findings)).not.toContain('invisible');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Real defects
// ─────────────────────────────────────────────────────────────────────────────

describe('real defects are caught', () => {
  it('flags a keyframe past the end of the composition', () => {
    const findings = verifyScene(ctxOf([
      { id: 'a', name: 'Late', width: 100, height: 100, tracks: { x: [{ t: 0, value: 960 }, { t: 9, value: 100 }] } },
    ], 5));
    expect(kinds(findings)).toContain('past-end');
    expect(findings.find((f) => f.kind === 'past-end')!.message).toContain('9.00s');
  });

  it('flags a layer parked outside the frame for the whole composition', () => {
    const findings = verifyScene(ctxOf([
      { id: 'a', name: 'Lost', width: 100, height: 100, x: -900, y: 540 },
    ]));
    expect(kinds(findings)).toContain('offscreen');
  });

  it('flags a layer that is transparent throughout', () => {
    const findings = verifyScene(ctxOf([
      { id: 'a', name: 'Ghost', width: 100, height: 100, opacity: 0 },
    ]));
    expect(kinds(findings)).toContain('invisible');
  });

  it('flags a bare fade with no accompanying motion', () => {
    const findings = verifyScene(ctxOf([
      {
        id: 'a', name: 'Flat', width: 400, height: 200,
        tracks: { opacity: [{ t: 0, value: 0 }, { t: 0.5, value: 100 }] },
      },
    ]));
    expect(kinds(findings)).toContain('opacity-only');
  });

  it('flags four or more layers entering together', () => {
    const layers: FakeLayer[] = Array.from({ length: 4 }, (_, i) => ({
      id: `c${i}`, name: `Card ${i}`, width: 300, height: 400,
      tracks: {
        opacity: [{ t: 0, value: 0 }, { t: 0.5, value: 100 }],
        y: [{ t: 0, value: 600 }, { t: 0.5, value: 540 }],
      },
    }));
    const findings = verifyScene(ctxOf(layers));
    const sim = findings.find((f) => f.kind === 'simultaneous');
    expect(sim).toBeDefined();
    expect(sim!.nodeIds).toHaveLength(4);
  });

  it('does not flag a properly staggered group', () => {
    // The compose tools stagger at ~0.10s offsets. That must read as correct,
    // or the verifier fights the technique library it is meant to protect.
    const layers: FakeLayer[] = [0.22, 0.33, 0.42, 0.52].map((t, i) => ({
      id: `c${i}`, name: `Card ${i}`, width: 300, height: 400,
      tracks: {
        opacity: [{ t, value: 0 }, { t: t + 0.5, value: 100 }],
        y: [{ t, value: 600 }, { t: t + 0.5, value: 540 }],
      },
    }));
    expect(kinds(verifyScene(ctxOf(layers)))).not.toContain('simultaneous');
  });
});

describe('formatFindings', () => {
  it('returns null for a clean scene', () => {
    expect(formatFindings([])).toBeNull();
  });

  it('lets the model overrule a finding', () => {
    // The verifier cannot see the frames; the model can. Where they disagree,
    // the one with eyes should win.
    const text = formatFindings([{ kind: 'offscreen', nodeIds: ['a'], message: 'x' }])!;
    expect(text).toMatch(/say so and move on/);
  });
});

describe('a clean scene produces nothing', () => {
  it('passes a well-formed staggered composition', () => {
    const findings = verifyScene(ctxOf([
      { id: 'bg', name: 'Background', width: 1920, height: 1080 },
      {
        id: 'title', name: 'Title', width: 900, height: 140,
        tracks: {
          opacity: [{ t: 0.2, value: 0 }, { t: 0.9, value: 100 }],
          y: [{ t: 0.2, value: 580 }, { t: 0.9, value: 540 }],
        },
      },
      {
        id: 'sub', name: 'Subtitle', width: 600, height: 60,
        tracks: {
          opacity: [{ t: 0.42, value: 0 }, { t: 1.1, value: 100 }],
          y: [{ t: 0.42, value: 700 }, { t: 1.1, value: 660 }],
        },
      },
    ]));
    expect(findings).toEqual([]);
  });
});
