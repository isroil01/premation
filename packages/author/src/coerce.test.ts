/**
 * Coercion repairs input and never adds design.
 *
 * Each case is a shape a real model returns: a misspelt effect, a param by
 * its label, a prop by a CSS-ish name, tuples instead of key objects, an id
 * collision, a beat past the end. Each must come back valid AND say what was
 * repaired — and where something required is missing, the thing is dropped,
 * never filled in.
 */

import { IdPool, coerceBeat, coerceDesign, coerceScript, nearestEffect, nearestParam } from './coerce';
import { authorEffect } from './vocabulary';
import type { BeatOutline } from './types';

const CTX = { durationSec: 8, width: 1920, height: 1080 };
const HEAD = { palette: { ink: '#ffffff', hot: '#ff3355' }, type: { h1: { size: 100 } } };
const OUTLINE: BeatOutline = { name: 'A', purpose: 'p', startSec: 2, endSec: 6 };

const beat = (layers: unknown[], pool = new IdPool()) => coerceBeat({ layers }, OUTLINE, HEAD, pool, CTX, 0);

describe('nearestEffect / nearestParam', () => {
  it('finds an effect by type, normalised name, label and close spelling — and gives up on a different word', () => {
    expect(nearestEffect('glow')?.type).toBe('glow');
    expect(nearestEffect('Gaussian Blur')?.type).toBe('gaussian-blur');
    expect(nearestEffect('drop_shadow')?.type).toBe('drop-shadow');
    expect(nearestEffect('Drop Shadow')?.type).toBe('drop-shadow');
    expect(nearestEffect('vignete')?.type).toBe('vignette');
    expect(nearestEffect('make it pop')).toBeUndefined();
  });

  it('finds a param by key, label or close spelling', () => {
    const shadow = authorEffect('drop-shadow')!;
    expect(nearestParam(shadow, 'softness')?.key).toBe('softness');
    expect(nearestParam(shadow, 'Distance')?.key).toBe('distance');
    expect(nearestParam(shadow, 'opactiy')?.key).toBe('opacity');
    expect(nearestParam(shadow, 'blendiness')).toBeUndefined();
  });
});

describe('coerceBeat', () => {
  it('repairs names and spellings, and reports each repair', () => {
    const r = beat([{
      id: 'card', kind: 'rectangle', name: 'Card',
      props: { color: '$hot', positionX: 300, opacity: 140 },
      keys: { 'position.y': [[0, 500, 'easeOut'], [1, 540]] },
      effects: [{ type: 'Drop Shadow', params: { Distance: 12, opactiy: 40 } }],
    }]);
    const l = r.value.layers[0]!;
    expect(l.kind).toBe('shape');
    expect(l.shape).toBe('rect');
    expect(l.props).toEqual({ fill: '$hot', x: 300, opacity: 100 });
    expect(l.keys).toEqual({ y: [{ t: 0, v: 500, ease: 'easeOut' }, { t: 1, v: 540 }] });
    expect(l.effects).toEqual([{ id: 'drop-shadow', type: 'drop-shadow', params: { distance: 12, opacity: 40 } }]);
    const msgs = r.repairs.map((x) => x.message).join('\n');
    expect(msgs).toMatch(/read kind 'rectangle' as shape \(rect\)/);
    expect(msgs).toMatch(/clamped to 100/);
    expect(msgs).toMatch(/read 'Drop Shadow' as 'drop-shadow'/);
  });

  it('drops what it cannot repair, and never fills in a value', () => {
    const r = beat([
      { id: 't', kind: 'text', name: 'No text' },
      { id: 'i', kind: 'image', name: 'No prompt', image: { prompt: 'cat' } },
      { id: 's', kind: 'shape', name: 'S', props: { fill: '$nope', wobble: 3 }, effects: [{ type: 'make it pop' }] },
      { id: 'g', kind: 'gradient', name: 'G', gradient: { stops: ['#000000'] } },
    ]);
    expect(r.value.layers.map((l) => l.id)).toEqual(['s']);
    // No fill, no invented effect — just a shape that says what it said.
    expect(r.value.layers[0]).toEqual({ id: 's', kind: 'shape', name: 'S' });
    expect(r.repairs.length).toBeGreaterThanOrEqual(6);
  });

  it('keeps ids unique across beats through a shared pool, and rewires references to renamed ids', () => {
    const pool = new IdPool(['beat_0']);
    beat([{ id: 'title', kind: 'null', name: 'first' }], pool);
    const r = beat([
      { id: 'title', kind: 'null', name: 'Parent' },
      { id: 'kid', kind: 'null', name: 'Kid', parent: 'title' },
      { id: 'masked', kind: 'shape', name: 'M', matte: { mode: 'alpha', source: 'title' } },
    ], pool);
    expect(r.value.layers.map((l) => l.id)).toEqual(['title_2', 'kid', 'masked']);
    expect(r.value.layers[1]!.parent).toBe('title_2');
    expect(r.value.layers[2]!.matte).toEqual({ mode: 'alpha', source: 'title_2' });
  });

  it('breaks parent loops and drops parents that are not in the list', () => {
    const r = beat([
      { id: 'a', kind: 'null', name: 'A', parent: 'b' },
      { id: 'b', kind: 'null', name: 'B', parent: 'a' },
      { id: 'c', kind: 'null', name: 'C', parent: 'ghost' },
    ]);
    const a = r.value.layers.find((l) => l.id === 'a')!;
    const b = r.value.layers.find((l) => l.id === 'b')!;
    expect(!!a.parent && !!b.parent).toBe(false);
    expect(r.value.layers.find((l) => l.id === 'c')!.parent).toBeUndefined();
  });

  it('only lets operators onto layers with a shape path, and animators onto text', () => {
    const r = beat([
      { id: 't', kind: 'text', name: 'T', text: 'Hi', trim: { end: 50 }, textAnimators: [{ opacity: 0, sweep: { from: 0, to: 1 } }] },
      { id: 'n', kind: 'null', name: 'N', textAnimators: [{ opacity: 0 }], repeaters: [{ copies: 3 }] },
    ]);
    expect(r.value.layers[0]!.trim).toBeUndefined();
    expect(r.value.layers[0]!.textAnimators).toHaveLength(1);
    expect(r.value.layers[1]!.textAnimators).toBeUndefined();
    expect(r.value.layers[1]!.repeaters).toBeUndefined();
  });

  it('drops keys that fall outside the composition and clips a bar that runs past it', () => {
    // The beat starts at 2s in an 8s comp: beat-local 7s is composition 9s.
    const r = beat([{ id: 'n', kind: 'null', name: 'N', outSec: 7, keys: { x: [{ t: 0, v: 0 }, { t: 5, v: 1 }, { t: 7, v: 2 }] } }]);
    expect(r.value.layers[0]!.keys!.x!.map((k) => k.t)).toEqual([0, 5]);
    expect(r.value.layers[0]!.outSec).toBe(6);
  });

  it('refuses type props on non-text layers and camera props on non-cameras', () => {
    const r = beat([{ id: 's', kind: 'shape', name: 'S', props: { fontSize: 40, focalLength: 900, width: 100 }, keys: { focalLength: [{ t: 0, v: 1 }, { t: 1, v: 2 }] } }]);
    expect(r.value.layers[0]!.props).toEqual({ width: 100 });
    expect(r.value.layers[0]!.keys).toBeUndefined();
  });
});

describe('coerceDesign', () => {
  it('fits the user\'s duration, sorts and clips beats, validates the palette', () => {
    const r = coerceDesign({
      title: 'T', intent: 'I', durationSec: 12, background: 'ink',
      palette: { ink: '#000000', bad: 'blue' },
      grid: { columns: 12, gutter: 24, margin: 100, baseline: 8 },
      beats: [
        { name: 'B', purpose: '', startSec: 4, endSec: 10 },
        { name: 'A', purpose: '', startSec: 0, endSec: 4 },
        { name: 'Z', purpose: '', startSec: 9, endSec: 9 },
      ],
    }, CTX);
    expect(r.value.durationSec).toBe(8);
    expect(r.value.palette).toEqual({ ink: '#000000' });
    expect(r.value.background).toBe('$ink');
    expect(r.value.beats.map((b) => [b.name, b.startSec, b.endSec])).toEqual([['A', 0, 4], ['B', 4, 8]]);
    expect(r.repairs.map((x) => x.path)).toEqual(expect.arrayContaining(['durationSec', 'palette.bad', 'beats[0]', 'beats[2]']));
  });
});

describe('coerceScript', () => {
  it('turns garbage into an empty but valid script and says so', () => {
    const r = coerceScript('not json at all', CTX);
    expect(r.value.beats).toEqual([]);
    expect(r.value.durationSec).toBe(8);
    expect(r.repairs.length).toBeGreaterThan(0);
  });
});
