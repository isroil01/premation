/**
 * Convert to Paragraph / Point Text must not move the text.
 *
 * "Did not move" is measured on what the painter actually draws: each line's
 * fillText, turned into its left pen x and baseline, mapped through the
 * layer's rotation and scale into composition space — before and after. The
 * canvas is jest's Skia backing, so widths are real font metrics.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSelectionStore } from '@stores/selectionStore';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import type { SceneNode } from '@core/types';
import { textPaintSpecFromNode } from '@core/scene/shapesFromText';
import { paintTextInBox } from '@core/rendering/raster/textPaint';
import { readParagraphBox } from '@core/text/textExtras';
import { hasCanvas } from '@core/effects/__testHelpers__/canvasFidelity';
import {
  buildParagraphTextCommands,
  convertToParagraphText,
  convertToPointText,
  setBoxAutoSize,
  TEXT_CONVERT_TO_PARAGRAPH_COMMAND,
  TEXT_CONVERT_TO_POINT_COMMAND,
} from './paragraphTextCommands';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
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

const ID = 'conv1';

// The conversions are engine batches (B3z): the text is a LAYER of the app's
// composition, added the way a legacy document loads (the engine resyncs).
let h: Awaited<ReturnType<typeof setupAppEngine>>;
function addLayer(node: SceneNode): void {
  defaultSceneGraph.addChild('comp_root', { ...node, parent: 'comp_root' } as SceneNode);
  getTimelineController().syncFromScene();
}

function textNode(textProps: Record<string, unknown>): SceneNode {
  return {
    id: ID, name: ID, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${ID}_tr`, type: 'Transform', props: { __kind: 'text', x: 320, y: 180, rotation: 30, scaleX: 1.5, scaleY: 1.5, anchorX: 0, anchorY: 0 } },
      { id: `${ID}_t`, type: 'Text', props: { fontSize: 32, fontFamily: 'Arial', fontWeight: '400', ...textProps } },
    ],
  } as unknown as SceneNode;
}

const textProps = (): Record<string, unknown> =>
  defaultSceneGraph.getNode(ID)!.components.find((c) => c.type === 'Text')!.props as Record<string, unknown>;

/** Composition-space pen start + baseline of every drawn line. */
function drawnLines(): Array<{ text: string; x: number; y: number }> {
  const node = defaultSceneGraph.getNode(ID)!;
  const spec = textPaintSpecFromNode(node)!;
  const real = document.createElement('canvas').getContext('2d')!;
  const fills: Array<{ text: string; x: number; y: number; align: string; font: string }> = [];
  const state: Record<string, unknown> = {
    font: '', letterSpacing: '0px', textAlign: 'left', textBaseline: 'middle', fillStyle: '', strokeStyle: '', globalAlpha: 1,
  };
  const ctx = Object.assign(state, {
    save: () => {}, restore: () => {}, translate: () => {}, rotate: () => {}, scale: () => {}, transform: () => {},
    strokeText: () => {},
    fillText: (text: string, x: number, y: number) =>
      fills.push({ text, x, y, align: String(state.textAlign), font: String(state.font) }),
    measureText: (t: string) => {
      real.font = String(state.font);
      return real.measureText(t);
    },
  });
  paintTextInBox(ctx as unknown as CanvasRenderingContext2D, spec);
  const tr = node.components.find((c) => c.type === 'Transform')!.props as Record<string, number>;
  const rad = (tr.rotation! * Math.PI) / 180;
  return fills.map((f) => {
    real.font = f.font;
    const w = real.measureText(f.text).width;
    const left = f.align === 'center' ? f.x - w / 2 : f.align === 'right' ? f.x - w : f.x;
    const lx = (left - spec.width / 2) * tr.scaleX!;
    const ly = (f.y - spec.height / 2) * tr.scaleY!;
    return {
      text: f.text,
      x: tr.x! + Math.cos(rad) * lx - Math.sin(rad) * ly,
      y: tr.y! + Math.sin(rad) * lx + Math.cos(rad) * ly,
    };
  });
}

function expectSamePlaces(a: ReturnType<typeof drawnLines>, b: ReturnType<typeof drawnLines>): void {
  expect(b.map((l) => l.text)).toEqual(a.map((l) => l.text));
  a.forEach((line, i) => {
    expect([line.text, b[i]!.x]).toEqual([line.text, expect.closeTo(line.x, 3)]);
    expect([line.text, b[i]!.y]).toEqual([line.text, expect.closeTo(line.y, 3)]);
  });
}

beforeEach(async () => {
  h = await setupAppEngine();
  useSelectionStore.setState({ ids: [] });
});
afterEach(async () => { await h.dispose(); });

const maybe = hasCanvas ? describe : describe.skip;

describe('text on a path', () => {
  it('is point text: Convert to Paragraph Text skips it and adds no box', async () => {
    const node = textNode({ content: 'Riding a path' });
    node.components.push({ id: `${ID}_fx`, type: 'fx', props: { textPath: { pathId: '', firstMargin: 0, reversed: false, perpendicular: false } } } as never);
    addLayer(node);
    useSelectionStore.setState({ ids: [ID] });
    expect(await convertToParagraphText([ID])).toEqual([]);
    expect(textProps().boxWidth).toBeUndefined();
    expect(readParagraphBox(defaultSceneGraph.getNode(ID)!)).toBeNull();
    const convert = buildParagraphTextCommands().find((c) => c.id === TEXT_CONVERT_TO_PARAGRAPH_COMMAND)!;
    expect(convert.enabled!()).toBe(false);
  });
});

maybe('Convert to Paragraph / Point Text — no visual jump', () => {
  it.each(['left', 'center', 'right'])('point → paragraph (%s aligned, rotated + scaled layer)', async (align) => {
    addLayer(textNode({ content: 'Hello there\nsecond line', align }));
    const before = drawnLines();
    const entries = historyLabels().length;
    const doc0 = h.doc();
    expect(await convertToParagraphText([ID])).toEqual([ID]);
    expect(historyLabels()).toHaveLength(entries + 1);
    expect(historyLabels().at(-1)).toBe('Convert to Paragraph Text');
    const doc1 = h.doc();
    await h.run({ type: 'undo' });
    expect(h.doc()).toEqual(doc0);
    await h.run({ type: 'redo' });
    expect(h.doc()).toEqual(doc1);
    const box = readParagraphBox(defaultSceneGraph.getNode(ID)!)!;
    expect(box).toMatchObject({ fixedHeight: true, autoSize: 'off' });
    expectSamePlaces(before, drawnLines());
  });

  it.each(['left', 'center', 'right'])('paragraph → point turns soft wraps into returns (%s aligned)', async (align) => {
    const content = 'alpha beta gamma delta epsilon zeta';
    addLayer(textNode({ content, align, boxWidth: 180, boxHeight: 400, boxVerticalAlign: 'center' }));
    const before = drawnLines();
    expect(before.length).toBeGreaterThan(1); // it really wrapped
    const entries = historyLabels().length;
    expect(await convertToPointText([ID])).toEqual([ID]);
    expect(historyLabels()).toHaveLength(entries + 1);
    const p = textProps();
    expect(p.boxWidth).toBe(0);
    expect(String(p.content).split('\n')).toHaveLength(before.length);
    // One-for-one: each soft-wrap space became a return, nothing else changed.
    expect(String(p.content).replace(/\n/g, ' ')).toBe(content);
    expectSamePlaces(before, drawnLines());
  });

  it('round-trips point → paragraph → point in place', async () => {
    addLayer(textNode({ content: 'Round\ntrip', align: 'right' }));
    const before = drawnLines();
    await convertToParagraphText([ID]);
    await convertToPointText([ID]);
    expectSamePlaces(before, drawnLines());
  });

  it('switching an auto-height box to a fixed mode keeps the text where it is', async () => {
    addLayer(textNode({ content: 'alpha beta gamma delta', boxWidth: 160 }));
    const before = drawnLines();
    expect(await setBoxAutoSize(ID, 'off')).toBe(true);
    expect(historyLabels().at(-1)).toBe('Box Auto-Size');
    expect(textProps().boxHeight).toBeGreaterThan(0);
    expectSamePlaces(before, drawnLines());
  });
});

describe('convert commands', () => {
  const commands = buildParagraphTextCommands();
  const toPara = commands.find((c) => c.id === TEXT_CONVERT_TO_PARAGRAPH_COMMAND)!;
  const toPoint = commands.find((c) => c.id === TEXT_CONVERT_TO_POINT_COMMAND)!;

  it('are enabled for the matching kind of selected text only', () => {
    addLayer(textNode({ content: 'x' }));
    expect(toPara.enabled?.()).toBe(false);
    useSelectionStore.setState({ ids: [ID] });
    expect(toPara.enabled?.()).toBe(true);
    expect(toPoint.enabled?.()).toBe(false);
  });

  it('leave point text alone when asked to make it point text', async () => {
    addLayer(textNode({ content: 'x' }));
    expect(await convertToPointText([ID])).toEqual([]);
  });
});
