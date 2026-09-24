/**
 * Template fields through the engine (B3): a field write and a Batch Fill row
 * are ONE undo entry each, undo restores the document exactly, and what the
 * API cannot address (a media slot, a vanished layer, a bad cell) is reported
 * rather than written around the engine.
 */

import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import type { TemplateField } from '@core/template/templateTypes';
import { useTemplateStore } from '@stores/templateStore';
import { fillDataRowEdit, templateFieldCommands } from './templateFieldEdits';

let h: Harness & { engine: LocalEngine };
let s: Scene;

beforeEach(async () => {
  h = await setupAppEngine();
  s = await buildScene(h);
});
afterEach(async () => {
  useTemplateStore.getState().exit();
  await h.dispose();
});

const prop = (nodeId: string, type: string, key: string): unknown =>
  (defaultSceneGraph.getNode(nodeId)?.components.find((c) => c.type === type)?.props as Record<string, unknown> | undefined)?.[key];

const textField = (): TemplateField => ({
  id: 'headline', label: 'Headline', kind: 'text', default: '',
  target: { nodeId: s.T, componentType: 'Text', prop: 'content' },
});
const colorField = (): TemplateField => ({
  id: 'accent', label: 'Accent', kind: 'color', default: '#000000',
  target: { nodeId: s.T, componentType: 'Text', prop: 'fill' },
});
const mediaField = (): TemplateField => ({
  id: 'clip', label: 'Clip', kind: 'media', default: '',
  target: { nodeId: s.V, componentType: 'Transform', prop: 'src' },
});

describe('templateFieldCommands', () => {
  it('addresses Source Text and the layer fill; not a media slot or a vanished layer', () => {
    expect(templateFieldCommands(textField(), 'Hello', 0)?.[0]).toMatchObject({
      type: 'setProperty', prop: { layer: s.T, path: 'text/sourceText' }, value: { kind: 'string', value: 'Hello' },
    });
    expect(templateFieldCommands(colorField(), '#ff0000', 0)?.[0]).toMatchObject({
      type: 'setProperty', prop: { layer: s.T, path: 'layer/fill' }, value: { kind: 'color', value: { r: 1, g: 0, b: 0, a: 1 } },
    });
    expect(templateFieldCommands(mediaField(), 'blob:x', 0)).toBeNull();
    expect(templateFieldCommands({ ...textField(), target: { ...textField().target, nodeId: 'gone' } }, 'x', 0)).toBeNull();
    expect(templateFieldCommands(colorField(), 'not a colour', 0)).toBeNull();
  });
});

describe('fillDataRowEdit', () => {
  it('fills a row as ONE undo entry; undo restores exactly', async () => {
    const before = h.doc();
    const n = historyLabels().length;
    const res = await fillDataRowEdit(
      [textField(), colorField(), mediaField()],
      { headline: 'Ada Lovelace', accent: '00ff00', clip: 'C:/x.mp4', notes: 'ignored' },
      'Fill row 1',
      0,
    );
    await engineIdle();
    expect(res).toEqual({ filled: ['headline', 'accent'], skippedKind: ['clip'], failed: [] });
    expect(prop(s.T, 'Text', 'content')).toBe('Ada Lovelace');
    expect(String(prop(s.T, 'Text', 'fill')).toLowerCase()).toMatch(/^#00ff00/);
    expect(historyLabels().length).toBe(n + 1);
    expect(historyLabels().at(-1)).toBe('Fill row 1');
    const after = h.doc();
    await h.run({ type: 'undo' });
    expect(h.doc()).toBe(before);
    await h.run({ type: 'redo' });
    expect(h.doc()).toBe(after);
  });

  it('reports a bad cell as failed and writes nothing when no field matched', async () => {
    const n = historyLabels().length;
    const res = await fillDataRowEdit([colorField()], { accent: 'zzz' }, 'Fill row 2', 0);
    await engineIdle();
    expect(res).toEqual({ filled: [], skippedKind: [], failed: ['accent'] });
    expect(historyLabels().length).toBe(n);
  });
});

describe('templateStore.setField', () => {
  it('writes a text field through the engine as one entry and keeps the value map live', async () => {
    const field = textField();
    useTemplateStore.setState({
      active: { id: '__authored', name: 'T', width: 1920, height: 1080, layout: () => {}, build: () => {}, fields: [field] },
      values: { headline: '' },
    });
    const before = h.doc();
    const n = historyLabels().length;
    useTemplateStore.getState().setField('headline', 'Grace');
    await engineIdle();
    expect(useTemplateStore.getState().values.headline).toBe('Grace');
    expect(prop(s.T, 'Text', 'content')).toBe('Grace');
    expect(historyLabels().length).toBe(n + 1);
    expect(historyLabels().at(-1)).toBe('Edit Headline');
    await h.run({ type: 'undo' });
    expect(h.doc()).toBe(before);
  });

  it('routes the commands through the caller’s send (a typing gesture)', () => {
    const field = colorField();
    useTemplateStore.setState({
      active: { id: '__authored', name: 'T', width: 1920, height: 1080, layout: () => {}, build: () => {}, fields: [field] },
      values: {},
    });
    const sent: Array<[string, unknown[]]> = [];
    useTemplateStore.getState().setField('accent', '#0000ff', (label, cmds) => { sent.push([label, cmds]); });
    expect(sent).toHaveLength(1);
    expect(sent[0]![0]).toBe('Edit Accent');
    expect(sent[0]![1][0]).toMatchObject({ type: 'setProperty', prop: { layer: s.T, path: 'layer/fill' } });
  });
});
