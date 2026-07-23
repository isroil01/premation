/**
 * Asset-library pure cores: catalog integrity, cursor geometry, transition
 * recipes, and the SFX synthesizer (deterministic, audible, valid WAV).
 */

import { CURSOR_ITEMS, getCursorItem, cursorSvgPath, cursorOutline, cursorParts, cursorThumbParts } from './cursorLibrary';
import { MOGRAPH_ITEMS, getMographItem, mographDuration, type MographOps } from './mographLibrary';
import { TRANSITION_ITEMS, getTransitionItem, transitionRecipe, solidRecipe, detectPhase, type LayerPose, type CompBox, type TransitionPhase } from './transitionLibrary';
import { SFX_ITEMS, getSfxItem, renderSfxSamples, encodeWavPcm16, SFX_SAMPLE_RATE } from './sfxLibrary';

const POSE: LayerPose = { x: 600, y: 400, scaleX: 1, scaleY: 1, rotation: 0, width: 200, height: 120 };
const COMP: CompBox = { width: 1920, height: 1080 };

describe('library catalogs', () => {
  it('all ids are unique across every library', () => {
    const ids = [
      ...CURSOR_ITEMS.map((i) => i.id),
      ...MOGRAPH_ITEMS.map((i) => i.id),
      ...TRANSITION_ITEMS.map((i) => i.id),
      ...SFX_ITEMS.map((i) => i.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('lookups return items and null for unknown ids', () => {
    expect(getCursorItem(CURSOR_ITEMS[0]!.id)).toBe(CURSOR_ITEMS[0]);
    expect(getCursorItem('nope')).toBeNull();
    expect(getMographItem('nope')).toBeNull();
    expect(getTransitionItem('nope')).toBeNull();
    expect(getSfxItem('nope')).toBeNull();
  });
});

describe('cursorLibrary geometry', () => {
  it.each(CURSOR_ITEMS.map((i) => [i.id] as const))('%s has real drawable geometry inside the design box', (id) => {
    // Every item has a design with at least one part and a compound SVG path.
    const parts = cursorParts(id);
    expect(parts).not.toBeNull();
    expect(parts!.length).toBeGreaterThan(0);
    const d = cursorSvgPath(id);
    expect(d).toMatch(/^M/);
    expect(d).toMatch(/Z$/);
    for (const part of parts!) {
      if (part.kind === 'path') {
        expect(part.pts.length).toBeGreaterThanOrEqual(4); // real silhouettes, not bars
        for (const p of part.pts) {
          expect(p.x).toBeGreaterThanOrEqual(0);
          expect(p.x).toBeLessThanOrEqual(100);
          expect(p.y).toBeGreaterThanOrEqual(0);
          expect(p.y).toBeLessThanOrEqual(100);
        }
      } else {
        expect(part.cx - part.r).toBeGreaterThanOrEqual(0);
        expect(part.cx + part.r).toBeLessThanOrEqual(100);
        expect(part.cy - part.r).toBeGreaterThanOrEqual(0);
        expect(part.cy + part.r).toBeLessThanOrEqual(100);
      }
    }
    // Thumbnail render list mirrors the parts one-to-one.
    expect(cursorThumbParts(id, '#ffffff').length).toBe(parts!.length);
    // Unknown ids stay null-safe.
    expect(cursorOutline('nope')).toBeNull();
  });

  it('the library is genuinely diverse — every design is unique, with many distinct silhouettes', () => {
    // No two items may share the SAME full design (a recolour would).
    const designs = CURSOR_ITEMS.map((i) => JSON.stringify(cursorParts(i.id)));
    expect(new Set(designs).size).toBe(CURSOR_ITEMS.length);
    // And the catalog carries a wide range of distinct primary silhouettes
    // (effect overlays may reuse the pointer glyph under their choreography).
    const outlines = new Set(
      CURSOR_ITEMS.map((i) => JSON.stringify(cursorOutline(i.id))).filter((o) => o !== 'null')
    );
    expect(outlines.size).toBeGreaterThanOrEqual(15);
  });
});

describe('mographLibrary', () => {
  it.each(MOGRAPH_ITEMS.map((i) => [i.id, i] as const))('%s has a positive choreography duration', (_id, item) => {
    expect(mographDuration(item)).toBeGreaterThan(0);
    expect(mographDuration(item)).toBeLessThan(20);
  });

  it('loop items declare a preview window; decorations replay cleanly', () => {
    const calls: Array<[string, string]> = [];
    const ops: MographOps = {
      expr: (id, prop, src) => {
        calls.push(['expr', `${id}.${prop}`]);
        expect(src.trim().length).toBeGreaterThan(0);
      },
      textKf: (id, t, value) => {
        calls.push(['text', id]);
        expect(t).toBeGreaterThanOrEqual(0);
        expect(typeof value).toBe('string');
      },
    };
    for (const item of MOGRAPH_ITEMS) {
      if (item.loop) {
        // Loop cards need a finite preview window and an expression pass.
        expect(item.previewSeconds ?? 0).toBeGreaterThan(0);
        expect(item.decorate).toBeDefined();
      }
      calls.length = 0;
      item.decorate?.(ops, 'd', 640, 360, 0, 1);
      if (item.loop) expect(calls.some(([kind]) => kind === 'expr')).toBe(true);
    }
  });
});

describe('transitionLibrary recipes', () => {
  it.each(['enter', 'exit'] as TransitionPhase[])(
    '%s layer recipes exist for every non-solid item and end on the original pose',
    (phase) => {
      for (const item of TRANSITION_ITEMS) {
        const recipe = transitionRecipe(item.id, POSE, COMP, phase);
        if (item.solidOnly) {
          expect(recipe).toBeNull();
          continue;
        }
        expect(recipe).not.toBeNull();
        expect(recipe!.length).toBeGreaterThan(0);
        // Whatever a recipe animates, its LATEST keyframe per prop restores
        // the pose (exits end invisible, but pose-restored).
        const last = new Map<string, { t: number; value: number }>();
        for (const kf of recipe!) {
          expect(kf.t).toBeGreaterThanOrEqual(0);
          expect(kf.t).toBeLessThanOrEqual(item.duration + 1e-9);
          expect(Number.isFinite(kf.value)).toBe(true);
          const prev = last.get(kf.prop);
          if (!prev || kf.t >= prev.t) last.set(kf.prop, { t: kf.t, value: kf.value });
        }
        const poseValue: Record<string, number> = {
          x: POSE.x, y: POSE.y, scaleX: POSE.scaleX, scaleY: POSE.scaleY,
          rotation: POSE.rotation,
        };
        for (const [prop, { value: v }] of last) {
          if (prop === 'opacity') {
            // Entrances settle at 100; exits MUST end invisible.
            if (phase === 'exit') expect(v).toBe(0);
            else expect(v === 0 || v === 100).toBe(true);
          } else if (prop === '@blur') {
            // Effect sentinel: an entrance must land sharp (blur 0).
            if (phase === 'enter') expect(v).toBe(0);
            expect(v).toBeGreaterThanOrEqual(0);
          } else {
            expect(v).toBeCloseTo(poseValue[prop] ?? v, 5);
          }
        }
      }
    },
  );

  it('detectPhase picks exits for clips ending in the window, entrances otherwise', () => {
    // 30fps window covering frames 60..75.
    expect(detectPhase([{ start: 0, end: 70 }], 60, 75)).toBe('exit');
    expect(detectPhase([{ start: 62, end: 300 }], 60, 75)).toBe('enter');
    expect(detectPhase([{ start: 0, end: 300 }], 60, 75)).toBe('enter'); // no edge in window
    expect(detectPhase([], 60, 75)).toBe('enter');
    // An ending clip wins over a starting one (the outgoing shot leaves first).
    expect(detectPhase([{ start: 0, end: 70 }, { start: 70, end: 300 }], 60, 75)).toBe('exit');
  });

  it('solid recipes cover every item (every solid of multi-solid items) and stay inside the duration', () => {
    for (const item of TRANSITION_ITEMS) {
      const count = item.solidCount ?? 1;
      for (let i = 0; i < count; i++) {
        const recipe = solidRecipe(item.id, COMP, i, count);
        expect(recipe.length).toBeGreaterThan(0);
        for (const kf of recipe) {
          expect(kf.t).toBeGreaterThanOrEqual(0);
          expect(kf.t).toBeLessThanOrEqual(item.duration + 1e-9);
          expect(Number.isFinite(kf.value)).toBe(true);
        }
      }
    }
  });

  it('venetian bars tile the full frame height and stagger distinctly', () => {
    const item = getTransitionItem('tr-venetian')!;
    const n = item.solidCount!;
    const ys = new Set<number>();
    for (let i = 0; i < n; i++) {
      const r = solidRecipe('tr-venetian', COMP, i, n);
      const scaleY = r.find((k) => k.prop === 'scaleY')!;
      expect(scaleY.value).toBeCloseTo(1 / n, 5);
      ys.add(r.find((k) => k.prop === 'y')!.value);
    }
    expect(ys.size).toBe(n); // each bar occupies its own band
  });
});

describe('sfxLibrary synthesis', () => {
  it.each(SFX_ITEMS.map((i) => [i.id, i] as const))('%s renders deterministic, audible samples', (_id, item) => {
    const a = renderSfxSamples(item.id);
    const b = renderSfxSamples(item.id);
    expect(a).not.toBeNull();
    expect(a!.length).toBe(Math.round(item.duration * SFX_SAMPLE_RATE));
    // Deterministic: same item → identical bytes.
    expect(Buffer.from(a!.buffer).equals(Buffer.from(b!.buffer))).toBe(true);
    // Audible: non-trivial peak, and bounded to [-1, 1].
    let peak = 0;
    for (const s of a!) peak = Math.max(peak, Math.abs(s));
    expect(peak).toBeGreaterThan(0.05);
    expect(peak).toBeLessThanOrEqual(1);
  });

  it('encodes a valid 16-bit PCM WAV header', () => {
    const samples = renderSfxSamples(SFX_ITEMS[0]!.id)!;
    const wav = new DataView(encodeWavPcm16(samples));
    const tag = (off: number): string =>
      String.fromCharCode(wav.getUint8(off), wav.getUint8(off + 1), wav.getUint8(off + 2), wav.getUint8(off + 3));
    expect(tag(0)).toBe('RIFF');
    expect(tag(8)).toBe('WAVE');
    expect(tag(12)).toBe('fmt ');
    expect(wav.getUint16(20, true)).toBe(1); // PCM
    expect(wav.getUint16(22, true)).toBe(1); // mono
    expect(wav.getUint32(24, true)).toBe(SFX_SAMPLE_RATE);
    expect(wav.getUint16(34, true)).toBe(16); // bits per sample
    expect(tag(36)).toBe('data');
    expect(wav.getUint32(40, true)).toBe(samples.length * 2);
  });

  it('renderSfxSamples returns null for unknown ids', () => {
    expect(renderSfxSamples('nope')).toBeNull();
  });
});
