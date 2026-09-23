/**
 * This wave's text commands: Convert to Vertical/Horizontal Text, Convert to
 * Point Text with KEYFRAMED Source Text, and Box Auto-Size holding the text
 * still now that an auto-height box keeps its top edge.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { useSelectionStore } from '@stores/selectionStore';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import type { SceneNode } from '@core/types';
import { textPaintSpecFromNode } from '@core/scene/shapesFromText';
import { paintTextInBox } from '@core/rendering/raster/textPaint';
import { readMeasuredTextStyle, measureTextNodeParagraphBox } from '@core/text/measureText';
import { readParagraphBox } from '@core/text/textExtras';
import { hasCanvas } from '@core/effects/__testHelpers__/canvasFidelity';
import { buildTextCommands, TEXT_TOGGLE_ORIENTATION_COMMAND, toggleTextOrientation } from './textCommands';
import { convertToPointText, setBoxAutoSize } from './paragraphTextCommands';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { getTimelineController } from '@core/timeline/TimelineController';

beforeAll(() => {
  const services: any = {
    undo: { push: () => {}, undo: () => {}, redo: () => {}, canUndo: () => false, canRedo: () => false },
    selection: { get: () => [], set: () => {}, clear: () => {} },
    panels: { open: () => {}, close: () => {}, toggle: () => {}, isOpen: () => false },
    workspace: { setActive: () => {}, getActive: () => '' },
    get: () => undefined,
  };
  setCommandSystem(new CommandSystem({ services, getState: () => ({}) }));
});

const ID = 'dir1';

/** The conversions are engine batches (B3z): the text is a LAYER of the app's composition. */
function addLayer(node: SceneNode): void {
  defaultSceneGraph.addChild('comp_root', { ...node, parent: 'comp_root' } as SceneNode);
  getTimelineController().syncFromScene();
}

function textNode(textProps: Record<string, unknown>, transform: Record<string, number> = {}): SceneNode {
  return {
    id: ID, name: ID, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${ID}_tr`, type: 'Transform', props: { __kind: 'text', x: 300, y: 200, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0, anchorY: 0, ...transform } },
      { id: `${ID}_t`, type: 'Text', props: { fontSize: 24, fontFamily: 'Arial', fontWeight: '400', ...textProps } },
    ],
  } as unknown as SceneNode;
}

const textProps = (): Record<string, unknown> =>
  defaultSceneGraph.getNode(ID)!.components.find((c) => c.type === 'Text')!.props as Record<string, unknown>;
const pos = (): { x: number; y: number } => {
  const p = defaultSceneGraph.getNode(ID)!.components.find((c) => c.type === 'Transform')!.props as Record<string, number>;
  return { x: p.x!, y: p.y! };
};

/** Composition-space baseline of every drawn line (translate honoured; no rotation / scale here). */
function drawnLines(): Array<{ text: string; y: number }> {
  const node = defaultSceneGraph.getNode(ID)!;
  const spec = textPaintSpecFromNode(node)!;
  const out: Array<{ text: string; y: number }> = [];
  let ty = 0;
  const state: Record<string, unknown> = { font: '', letterSpacing: '0px', textAlign: 'left', textBaseline: 'middle', fillStyle: '', strokeStyle: '', globalAlpha: 1 };
  const real = document.createElement('canvas').getContext('2d')!;
  const ctx = Object.assign(state, {
    save: () => {}, restore: () => {}, rotate: () => {}, scale: () => {}, transform: () => {},
    translate: (_x: number, y: number) => { ty += y; },
    strokeText: () => {},
    fillText: (text: string, _x: number, y: number) => out.push({ text, y: y + ty }),
    measureText: (t: string) => { real.font = String(state.font); return real.measureText(t); },
  });
  paintTextInBox(ctx as unknown as CanvasRenderingContext2D, spec);
  const p = pos();
  return out.map((l) => ({ text: l.text, y: p.y + (l.y - spec.height / 2) }));
}

beforeEach(() => {
  try { defaultSceneGraph.removeNode(ID); } catch { /* ignore */ }
  defaultAnimation.setDataTrack(ID, 'text.source', null);
  useSelectionStore.setState({ ids: [] });
});

describe('Convert to Vertical/Horizontal Text', () => {
  // A text LAYER on the app engine: the toggle is a `text/orientation` batch (G1).
  let h: Awaited<ReturnType<typeof setupAppEngine>>;
  let T = '';
  const orientation = (): unknown => (defaultSceneGraph.getNode(T)!.components.find((c) => c.type === 'Text')!.props as Record<string, unknown>).orientation;
  beforeEach(async () => {
    h = await setupAppEngine();
    T = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'text', name: '縦書き', init: [] })).layer;
  });
  afterEach(async () => { await h.dispose(); });

  it('toggles orientation as one command', async () => {
    expect(toggleTextOrientation([T])).toBe('vertical');
    await engineIdle();
    expect(orientation()).toBe('vertical');
    expect(toggleTextOrientation([T])).toBe('horizontal');
    await engineIdle();
    expect(orientation()).toBe('horizontal');
    expect(historyLabels().slice(-2)).toEqual(['Convert to Vertical Text', 'Convert to Horizontal Text']);
    expect(toggleTextOrientation(['nope'])).toBeNull();
  });

  it('is registered and enabled only with a text layer selected', async () => {
    const cmd = buildTextCommands().find((c) => c.id === TEXT_TOGGLE_ORIENTATION_COMMAND)!;
    expect(cmd.label).toBe('Convert to Vertical/Horizontal Text');
    useSelectionStore.setState({ ids: [] });
    expect(cmd.enabled!()).toBe(false);
    useSelectionStore.setState({ ids: [T] });
    expect(cmd.enabled!()).toBe(true);
    void cmd.execute({} as never);
    await engineIdle();
    expect(orientation()).toBe('vertical');
  });
});

const maybe = hasCanvas ? describe : describe.skip;

maybe('Convert to Point Text — keyframed Source Text', () => {
  let h: Awaited<ReturnType<typeof setupAppEngine>>;
  beforeEach(async () => { h = await setupAppEngine(); });
  afterEach(async () => { await h.dispose(); });
  it('rewrites every Source Text keyframe: soft wraps become returns, per keyframe text', async () => {
    addLayer(textNode({ content: 'static words that wrap in the box', boxWidth: 120 }));
    const node = defaultSceneGraph.getNode(ID)!;
    const values = ['alpha beta gamma delta epsilon', 'one two three four five six seven', 'short'];
    values.forEach((v, i) => defaultAnimation.setDataKeyframe(ID, 'text.source', 'text', i, v));
    const expected = values.map((v) => readMeasuredTextStyle(node, { content: v })!.content);
    expect(expected[0]).toContain('\n');
    expect(expected[1]).toContain('\n');

    const entries = historyLabels().length;
    expect(await convertToPointText([ID])).toEqual([ID]);
    expect(historyLabels()).toHaveLength(entries + 1);

    const track = defaultAnimation.getDataTrack(ID, 'text.source')!;
    expect(track.keyframes.map((k) => k.value)).toEqual(expected);
    // Same length, one-for-one: character indices (runs, selectors) survive.
    track.keyframes.forEach((k, i) => expect(String(k.value).length).toBe(values[i]!.length));
    expect(readParagraphBox(defaultSceneGraph.getNode(ID)!)).toBeNull();
    // Keyed Source Text IS its keys (AE has no separate static text while the
    // stopwatch is on; turning it off takes the value at the playhead): the
    // engine batch rewrites the keys only.
    expect(String(textProps().content)).toBe('static words that wrap in the box');
  });
});

maybe('Box Auto-Size — the text does not move', () => {
  let h: Awaited<ReturnType<typeof setupAppEngine>>;
  beforeEach(async () => { h = await setupAppEngine(); });
  afterEach(async () => { await h.dispose(); });
  it('fixed (top) → Auto Height keeps the authored top edge and the lines', async () => {
    addLayer(textNode({ content: 'one\ntwo', boxWidth: 200, boxHeight: 160, boxAutoSize: 'off' }));
    const before = drawnLines();
    const p0 = pos();
    expect(await setBoxAutoSize(ID, 'height')).toBe(true);
    const box = measureTextNodeParagraphBox(defaultSceneGraph.getNode(ID)!)!;
    expect(box.fixedHeight).toBe(false);
    expect(textProps().boxHeight).toBe(160);
    expect(box.lineOffsetY).toBeLessThan(0);
    expect(pos()).toEqual(p0);
    const after = drawnLines();
    expect(after.map((l) => l.text)).toEqual(before.map((l) => l.text));
    after.forEach((l, i) => expect(l.y).toBeCloseTo(before[i]!.y, 3));
  });

  it('anchored Auto Height → Off takes the text height and holds the lines still via Position', async () => {
    addLayer(textNode({ content: 'one\ntwo\nthree\nfour', boxWidth: 200, boxHeight: 30, boxAutoSize: 'height' }));
    const before = drawnLines();
    const offset = measureTextNodeParagraphBox(defaultSceneGraph.getNode(ID)!)!.lineOffsetY;
    expect(offset).toBeGreaterThan(0);
    const p0 = pos();
    await setBoxAutoSize(ID, 'off');
    expect(readParagraphBox(defaultSceneGraph.getNode(ID)!)!.fixedHeight).toBe(true);
    expect(pos().y).toBeCloseTo(p0.y + offset, 6);
    const after = drawnLines();
    after.forEach((l, i) => expect(l.y).toBeCloseTo(before[i]!.y, 3));
  });

  it('Auto Height on a box that never had a height records one, without moving', async () => {
    addLayer(textNode({ content: 'one\ntwo', boxWidth: 200 }));
    const p0 = pos();
    await setBoxAutoSize(ID, 'height');
    expect(Number(textProps().boxHeight)).toBeGreaterThan(0);
    expect(measureTextNodeParagraphBox(defaultSceneGraph.getNode(ID)!)!.lineOffsetY).toBeCloseTo(0, 9);
    expect(pos()).toEqual(p0);
  });
});
