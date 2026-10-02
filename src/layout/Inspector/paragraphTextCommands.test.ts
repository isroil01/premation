/**
 * Convert to Paragraph / Point Text and Box Auto-Size as document edits: which
 * layers convert, what the conversion writes (the box, the soft wraps turned
 * into returns) and that each is one undoable history entry.
 *
 * The canvas is jest's Skia backing, so the wrap is measured with real font
 * metrics. That the text does not MOVE on screen is the engine's to prove.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSelectionStore } from '@stores/selectionStore';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import type { SceneNode } from '@core/types';
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
import { engineIdle } from '@core/engine/engineInstance';
import { documentMirror } from '@stores/documentMirror';

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
    // (The menu's `enabled` reads the mirror, where a path option riding NO mask reads as no path —
    // `text/pathOptions/path` = '' — so it may offer the command; the conversion asks the engine,
    // `getTextLayout.onPath`, and refuses, as asserted above.)
  });
});

maybe('Convert to Paragraph / Point Text — the document edit', () => {
  it.each(['left', 'center', 'right'])('point → paragraph is one undoable entry with a fixed box (%s aligned, rotated + scaled layer)', async (align) => {
    addLayer(textNode({ content: 'Hello there\nsecond line', align }));
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
  });

  it.each(['left', 'center', 'right'])('paragraph → point turns soft wraps into returns (%s aligned)', async (align) => {
    const content = 'alpha beta gamma delta epsilon zeta';
    addLayer(textNode({ content, align, boxWidth: 180, boxHeight: 400, boxVerticalAlign: 'center' }));
    const entries = historyLabels().length;
    expect(await convertToPointText([ID])).toEqual([ID]);
    expect(historyLabels()).toHaveLength(entries + 1);
    const p = textProps();
    expect(p.boxWidth).toBe(0);
    expect(String(p.content).split('\n').length).toBeGreaterThan(1); // it really wrapped
    // One-for-one: each soft-wrap space became a return, nothing else changed.
    expect(String(p.content).replace(/\n/g, ' ')).toBe(content);
  });

  it('switching an auto-height box to a fixed mode is one entry that bakes the height', async () => {
    addLayer(textNode({ content: 'alpha beta gamma delta', boxWidth: 160 }));
    expect(await setBoxAutoSize(ID, 'off')).toBe(true);
    expect(historyLabels().at(-1)).toBe('Box Auto-Size');
    expect(textProps().boxHeight).toBeGreaterThan(0);
  });
});

describe('convert commands', () => {
  const commands = buildParagraphTextCommands();
  const toPara = commands.find((c) => c.id === TEXT_CONVERT_TO_PARAGRAPH_COMMAND)!;
  const toPoint = commands.find((c) => c.id === TEXT_CONVERT_TO_POINT_COMMAND)!;

  it('are enabled for the matching kind of selected text only', async () => {
    addLayer(textNode({ content: 'x' }));
    // `enabled` reads the mirror: let the legacy load reach it (a resync on the next microtask).
    await engineIdle();
    await documentMirror().whenIdle();
    documentMirror().tree(ID);
    await documentMirror().whenIdle();
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
