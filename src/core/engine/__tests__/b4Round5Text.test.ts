/**
 * B4 round 5, slice C (ENGINE_API.md §15.14) — text and stored values on the
 * TypeScript engine: `PropertyInfo.stored`, grapheme-indexed `text/styleRuns`
 * reads (legacy code-point runs migrated), CSS `rgb()` / `rgba()` colours read
 * as colour values, a legacy `strokeOverFill` read as its Fill and Stroke
 * order, `model/targetNames`, and `getTextLayout.glyphs`. The C++ twin is
 * native/engine/tests/test_b4_round5_text.cpp (+ the glyph cases in
 * test_b4_round5_text_glyphs.cpp) — the same document, the same answers.
 */

import type { PropertyInfo, Value } from '@motion/engine-api';
import { hasCanvas } from '@core/effects/__testHelpers__/canvasFidelity';
import { splitGraphemes } from '@core/text/graphemes';
import { cssRgbChannels } from '../fields';
import { setupEngine, type Harness } from '../__testHelpers__/harness';

jest.useFakeTimers();

let h: Harness;
beforeEach(async () => { h = await setupEngine(); });
afterEach(async () => { await h.dispose(); });

const node = (id: string, kind: string, components: unknown[]): unknown => ({
  id, name: id, parent: 'comp_root', children: [], visible: true, locked: false,
  transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
  components: [{ id: `${id}_t`, type: 'Transform', props: { __kind: kind, x: 100, y: 100, rotation: 0, scaleX: 100, scaleY: 100 } }, ...components],
});

/** The document both engines' tests restore (keep in step with test_b4_round5_text.cpp kDoc). */
export const B4R5_TEXT_DOC = {
  version: '1.9.0',
  scene: {
    version: '1.0.0',
    nodes: [
      {
        id: 'comp_root', name: 'Composition 1', parent: null, children: ['t1', 's1', 'm1'], visible: true, locked: false,
        transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
        components: [{ id: 'comp_root_meta', type: 'group', props: { __kind: 'group' } }],
      },
      node('t1', 'text', [
        { id: 't1_s', type: 'Style', props: { opacity: 100, fill: 'rgba(255, 0, 0, 0.5)' } },
        // Code-point runs (no `__runsIndex`): the emoji + skin tone is ONE grapheme, two code points.
        { id: 't1_x', type: 'Text', props: { content: 'a\u{1F44D}\u{1F3FD}b', fontSize: 48, fontFamily: 'Arial', strokeOverFill: true, __runs: [{ start: 1, end: 3, style: { fill: '#ff0000' } }, { start: 'x', end: 2, style: {} }] } },
      ]),
      node('s1', 'shape', [
        { id: 's1_s', type: 'Style', props: { opacity: 100, fill: 'rgb(0 128 255 / 50%)', cornerRadius: 12, cornerRadiusTL: 4 } },
      ]),
      node('m1', 'shape', [
        { id: 'm1_m', type: 'Model', props: { morphNames: ['jawOpen', '', 'smile'] } },
      ]),
    ],
  },
  animation: { tracks: {}, data: {}, expressions: {} },
  comps: { comp_root: { id: 'comp_root', name: 'comp_root', width: 1920, height: 1080, fps: 30, durationSeconds: 10, background: '#101014' } },
  motionBlur: { enabled: false, shutterAngle: 180, shutterPhase: -90, samples: 8, adaptiveSampleLimit: 128 },
  openTabs: { tabOrder: ['tab1'], activeTabId: 'tab1', tabs: { tab1: { id: 'tab1', compositionId: 'comp_root', breadcrumbPath: ['comp_root'], title: 'comp_root', time: 0, frame: 0 } } },
};

async function restore(): Promise<void> {
  await h.run({ type: 'restoreDocument', document: new TextEncoder().encode(JSON.stringify(B4R5_TEXT_DOC)) });
}

async function tree(layer: string): Promise<PropertyInfo[]> {
  return (await h.query({ type: 'getPropertyTree', layer, path: '', depth: 0 })).nodes;
}

const byMatch = (nodes: PropertyInfo[], matchName: string): PropertyInfo | undefined => nodes.find((n) => n.matchName === matchName && n.kind === 'property');
const byPath = (nodes: PropertyInfo[], path: string): PropertyInfo | undefined => nodes.find((n) => n.path === path);
const color = (v: Value | undefined): number[] => (v?.kind === 'color' ? [v.value.r, v.value.g, v.value.b, v.value.a] : []);

test('stored: explicit static values say so; unset means the default applies', async () => {
  await restore();
  const t = await tree('t1');
  expect(byPath(t, 'text/fontFamily')?.stored).toBe(true);
  expect(byMatch(t, 'fontSize')?.stored).toBe(true);
  expect(byMatch(t, 'lineHeight')?.stored).toBeUndefined();
  expect(byPath(t, 'text/align')?.stored).toBeUndefined();
  expect(byPath(t, 'layer/fill')?.stored).toBe(true);
  expect(byPath(t, 'text/sourceText')?.stored).toBe(true);
  expect(byPath(t, 'text/styleRuns')?.stored).toBe(true);
  const s = await tree('s1');
  expect(byMatch(s, 'cornerRadius')?.stored).toBe(true);
  expect(byMatch(s, 'cornerRadiusTL')?.stored).toBe(true);
  expect(byMatch(s, 'cornerRadiusTR')?.stored).toBeUndefined();
  expect(byPath(s, 'layer/cornersLinked')?.stored).toBeUndefined();
  // A write stores it; a group never reports it.
  const tr = byMatch(s, 'cornerRadiusTR')!;
  await h.run({ type: 'setProperty', prop: { layer: 's1', path: tr.path }, value: { kind: 'scalar', value: 6 } });
  expect(byPath(await tree('s1'), tr.path)?.stored).toBe(true);
  expect(t.filter((n) => n.kind !== 'property').every((n) => n.stored === undefined)).toBe(true);
});

test('text/styleRuns reads grapheme-indexed: legacy code-point runs migrated, malformed runs dropped', async () => {
  await restore();
  const runs = byPath(await tree('t1'), 'text/styleRuns')?.value;
  expect(runs).toEqual({ kind: 'json', value: JSON.stringify([{ start: 1, end: 2, style: { fill: '#ff0000' } }]) });
  expect(splitGraphemes('a\u{1F44D}\u{1F3FD}b')).toHaveLength(3);
});

test('CSS rgb() / rgba() colours read as colour values', async () => {
  await restore();
  expect(color(byPath(await tree('t1'), 'layer/fill')?.value)).toEqual([1, 0, 0, 0.5]);
  expect(color(byPath(await tree('s1'), 'layer/fill')?.value)).toEqual([0, 128 / 255, 1, 0.5]);
  expect(cssRgbChannels('RGBA(10%, 300, -4, 2)')).toEqual([Math.round(25.5) / 255, 1, 0, 1]);
  expect(cssRgbChannels(' rgb(1.5e2 .5 +7) ')).toEqual([150 / 255, 1 / 255, 7 / 255, 1]);
  for (const bad of ['rgb(1, 2)', 'rgb(1,2,3,4,5)', 'rgb(1px, 2, 3)', 'rgb(1, 2, 3', 'hsl(1, 2%, 3%)', '#ff0000', 'rgb(., 2, 3)']) {
    expect([bad, cssRgbChannels(bad)]).toEqual([bad, null]);
  }
});

test('a legacy strokeOverFill switch reads as its Fill and Stroke order', async () => {
  await restore();
  const order = byPath(await tree('t1'), 'text/strokeOrder');
  expect(order?.value).toEqual({ kind: 'choice', value: 'stroke-over-fill' });
  expect(order?.stored).toBe(true);
});

test('model/targetNames: the stored blend-shape names', async () => {
  await restore();
  const names = byPath(await tree('m1'), 'model/targetNames');
  expect(names?.value).toEqual({ kind: 'json', value: JSON.stringify(['jawOpen', '', 'smile']) });
  expect(names?.stored).toBe(true);
  expect(byPath(await tree('t1'), 'model/targetNames')).toBeUndefined();
});

(hasCanvas ? describe : describe.skip)('getTextLayout.glyphs', () => {
  async function textLayer(content: string, align?: string): Promise<string> {
    const { item: comp } = await h.run({ type: 'createComposition', settings: { name: 'G', width: 640, height: 360 }, fromItems: [] });
    const { layer } = await h.run({ type: 'createLayer', comp, kind: 'text', name: 'T', init: [] });
    await h.run({ type: 'setProperty', prop: { layer, path: 'text/sourceText' }, value: { kind: 'string', value: content } });
    await h.run({ type: 'setProperty', prop: { layer, path: 'text/fontFamily' }, value: { kind: 'string', value: 'Arial' } });
    if (align) await h.run({ type: 'setProperty', prop: { layer, path: 'text/align' }, value: { kind: 'choice', value: align } });
    return layer;
  }

  test('one box per grapheme, line breaks counted but not boxed; lines stack; boxes tile each line', async () => {
    const layer = await textLayer('AB\nC\u{1F44D}\u{1F3FD}D', 'center');
    const l = await h.query({ type: 'getTextLayout', layer, time: 0 });
    expect(l.glyphs.map((g) => [g.index, g.line])).toEqual([[0, 0], [1, 0], [3, 1], [4, 1], [5, 1]]);
    for (const g of l.glyphs) {
      expect(g.advance).toBeCloseTo(g.box.width, 9);
      expect(g.box.width).toBeGreaterThan(0);
      expect(g.box.height).toBeGreaterThan(0);
      expect(g.baseline).toBeGreaterThan(g.box.y);
      expect(g.baseline).toBeLessThan(g.box.y + g.box.height);
    }
    const line0 = l.glyphs.filter((g) => g.line === 0);
    const line1 = l.glyphs.filter((g) => g.line === 1);
    expect(line1[0]!.baseline).toBeGreaterThan(line0[0]!.baseline);
    for (const line of [line0, line1]) {
      for (let i = 1; i < line.length; i++) expect(line[i]!.box.x).toBeCloseTo(line[i - 1]!.box.x + line[i - 1]!.box.width, 9);
      // Centred: the line straddles the origin.
      const left = line[0]!.box.x;
      const right = line[line.length - 1]!.box.x + line[line.length - 1]!.box.width;
      expect(left + right).toBeCloseTo(0, 6);
    }
    // Inside the selection box horizontally (the widest line spans it).
    const widest = Math.max(...[line0, line1].map((ln) => ln[ln.length - 1]!.box.x + ln[ln.length - 1]!.box.width - ln[0]!.box.x));
    expect(widest).toBeCloseTo(l.box.width, 6);
  });

  test('left / right alignment start the lines at the box edges', async () => {
    const left = await h.query({ type: 'getTextLayout', layer: await textLayer('Wide line\nx', 'left'), time: 0 });
    const lx = left.glyphs.filter((g) => g.line === 1)[0]!.box.x;
    expect(lx).toBeCloseTo(left.box.x, 6);
    const right = await h.query({ type: 'getTextLayout', layer: await textLayer('Wide line\nx', 'right'), time: 0 });
    const last = right.glyphs[right.glyphs.length - 1]!;
    expect(last.box.x + last.box.width).toBeCloseTo(right.box.x + right.box.width, 6);
  });
});
