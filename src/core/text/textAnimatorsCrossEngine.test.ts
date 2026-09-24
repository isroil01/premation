/**
 * Cross-engine text animator + text-path parity (plan D2w). For a spread of
 * animator stacks — every range shape, ease, smoothness, index / percentage
 * units, Randomize Order, wiggly selectors (locked and 2-D), combine modes,
 * keyframed selector and property values, legacy inline selectors, optional
 * properties, Character Offset — the fixture records the stored `__animators`,
 * the frame's sampled values, and the GlyphTransform[] `resolveAnimators` +
 * `evaluateTextAnimators` produce; and for a few masks the polyline
 * `flattenMaskPath` produces. The C++ scene builder
 * (native/engine/src/scene/text_port.cpp, tests/test_text_port_parity.cpp)
 * must reproduce every number exactly.
 *
 * `GEN_NATIVE_TEXT_ANIMATORS=1 npx jest textAnimatorsCrossEngine` rewrites the
 * fixture; without it this test fails when the fixture is stale.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SceneNode } from '@core/types';
import { resolveAnimators, evaluateTextAnimators } from './textAnimators';
import { flattenMaskPath } from './textPath';
import type { MaskPath } from '@core/effects/mask';

const OUT = path.resolve(__dirname, '../../../native/engine/tests/data/text_animator_parity.json');

type Stored = Record<string, unknown>;
interface Case { name: string; text: string; animators: Stored[]; values: Array<[string, number]>; time: number }

const base = (id: string, patch: Stored = {}): Stored => ({
  id, x: 0, y: 0, scale: 100, rotation: 0, opacity: 100, tracking: 0, skew: 0, ...patch,
});
const range = (id: string, patch: Stored = {}): Stored => ({
  kind: 'range', id, basedOn: 'characters', units: 'percentage', mode: 'add', start: 0, end: 100, offset: 0, amount: 100,
  shape: 'square', smoothness: 100, easeHigh: 0, easeLow: 0, randomizeOrder: false, randomSeed: 0, ...patch,
});
const wiggly = (id: string, patch: Stored = {}): Stored => ({
  kind: 'wiggly', id, basedOn: 'characters', mode: 'intersect', maxAmount: 100, minAmount: -100, wigglesPerSecond: 2,
  correlation: 50, temporalPhase: 0, spatialPhase: 0, lockDimensions: false, randomSeed: 0, ...patch,
});

const CASES: Case[] = [
  // The golden scene's legacy inline selector (text-glyph-animator).
  {
    name: 'legacy-triangle', text: 'BOUNCE', time: 0, values: [],
    animators: [{ id: 'a1', basedOn: 'characters', shape: 'triangle', start: 0, end: 100, offset: 0, x: 0, y: -34, scale: 120, rotation: 0, opacity: 100, tracking: 0, skew: 0, mode: 'range', wiggleFreq: 2 }],
  },
  ...(['square', 'rampUp', 'rampDown', 'triangle', 'round', 'smooth'] as const).map((shape, i): Case => ({
    name: `shape-${shape}`, text: 'Premation text', time: 0.4,
    values: [['ta.0.offset', 13.5 * i], ['ta.0.s1.amount', 60]],
    animators: [base('a', {
      y: -20, x: 7, rotation: 30, opacity: 40, scale: 150, scaleY: 80, tracking: 3, skew: 12, blur: 2, strokeWidth: 1.5,
      color: '#ff0000', strokeColor: '#00ff00', fillOpacity: 50, lineSpacing: 4,
      selectors: [range('s0', { shape, start: 10, end: 70, smoothness: 35, easeHigh: 40, easeLow: -25 }), range('s1', { mode: 'subtract', shape: 'rampDown', basedOn: 'words' })],
    })],
  })),
  {
    name: 'index-units-random-order', text: 'one two  three\nfour', time: 1.25, values: [['ta.0.start', 2]],
    animators: [base('a', {
      x: 40, characterOffset: 3,
      selectors: [range('s0', { units: 'index', start: 1, end: 9, randomizeOrder: true, randomSeed: 17, basedOn: 'charactersExcludingSpaces' })],
    })],
  },
  {
    name: 'lines-and-words', text: 'alpha beta\ngamma delta\nepsilon', time: 0, values: [],
    animators: [
      base('a', { y: 10, selectors: [range('s0', { basedOn: 'lines', start: 30, end: 80, smoothness: 0 })] }),
      base('b', { rotation: -15, selectors: [range('s0', { basedOn: 'words', shape: 'smooth', offset: -20 })] }),
    ],
  },
  ...[0, 0.37, 2.9].map((time, i): Case => ({
    name: `wiggly-${i}`, text: 'Wiggle me 42', time, values: [['ta.0.s0.wigglesPerSecond', 3.5], ['ta.0.s0.correlation', 25]],
    animators: [base('a', {
      x: 30, y: 30, scale: 130,
      selectors: [wiggly('s0', { randomSeed: 5, temporalPhase: 45, spatialPhase: 90 }), wiggly('s1', { mode: 'max', lockDimensions: true, randomSeed: 2 })],
    })],
  })),
  ...(['add', 'subtract', 'intersect', 'min', 'max', 'difference'] as const).map((mode): Case => ({
    name: `combine-${mode}`, text: 'Combine', time: 0, values: [],
    animators: [base('a', {
      opacity: 0,
      selectors: [range('s0', { start: 0, end: 60 }), range('s1', { mode, start: 30, end: 100, shape: 'rampUp' })],
    })],
  })),
  {
    name: 'optional-properties', text: 'Optional props', time: 0.5,
    values: [['ta.0.anchorX', 5], ['ta.0.fillHue', 90]],
    animators: [base('a', {
      anchorX: 2, anchorY: -3, skewAxis: 20, lineAnchor: 50, fillHue: 30, fillSaturation: -40, fillBrightness: 10,
      strokeOpacity: 60, strokeHue: 12, trackingType: 'beforeAfter', tracking: 6, blur: 3, blurY: 7, z: 20, rotationX: 15, rotationY: -10,
      selectors: [range('s0', { start: 20, end: 90, shape: 'round' })],
    })],
  },
  {
    name: 'disabled-and-empty', text: 'Nope', time: 0, values: [],
    animators: [base('a', { enabled: false, x: 99 }), base('b', { y: 5, selectors: [range('s0', { enabled: false })] })],
  },
];

const MASKS: MaskPath[] = [
  {
    id: 'm1', closed: true, mode: 'add', opacity: 100, feather: 0, inverted: false, expansion: 0,
    points: [
      { x: -180, y: 0, inX: -180, inY: 82.8, outX: -180, outY: -82.8 },
      { x: 0, y: -150, inX: -99.4, inY: -150, outX: 99.4, outY: -150 },
      { x: 180, y: 0, inX: 180, inY: -82.8, outX: 180, outY: 82.8 },
      { x: 0, y: 150, inX: 99.4, inY: 150, outX: -99.4, outY: 150 },
    ],
  } as unknown as MaskPath,
  {
    id: 'm2', closed: false, mode: 'add', opacity: 100, feather: 0, inverted: false, expansion: 12.5,
    points: [
      { x: -100, y: 40, inX: -100, inY: 40, outX: -100, outY: 40 },
      { x: 0, y: -60, inX: -40, inY: -60, outX: 40, outY: -60 },
      { x: 100, y: 40, inX: 100, inY: 40, outX: 100, outY: 40 },
    ],
  } as unknown as MaskPath,
];

function node(animators: Stored[]): SceneNode {
  return {
    id: 't', name: 't', parent: null, children: [], visible: true, locked: false,
    components: [{ id: 't_c', type: 'Text', props: { content: '', __animators: animators } }],
  } as unknown as SceneNode;
}

function generate() {
  return {
    cases: CASES.map((c) => ({
      ...c,
      glyphs: evaluateTextAnimators(c.text, resolveAnimators(node(c.animators), new Map(c.values)), c.time),
    })),
    masks: MASKS.map((mask) => ({ mask, flat: flattenMaskPath(mask) })),
  };
}

test('the C++ text animator / text path parity fixture matches the editor', () => {
  const data = generate();
  const text = `${JSON.stringify({ comment: 'Generated by src/core/text/textAnimatorsCrossEngine.test.ts (GEN_NATIVE_TEXT_ANIMATORS=1). Do not edit.', ...data })}\n`;
  if (process.env.GEN_NATIVE_TEXT_ANIMATORS === '1') {
    writeFileSync(OUT, text);
    return;
  }
  expect(existsSync(OUT)).toBe(true);
  expect(JSON.parse(readFileSync(OUT, 'utf8'))).toEqual(JSON.parse(text));
  // The fixture exercises what it claims to.
  expect(data.cases.some((c) => c.glyphs.some((g) => g.displayChar !== g.char))).toBe(true);
  expect(data.cases.some((c) => c.glyphs.some((g) => g.blurY !== undefined))).toBe(true);
});
