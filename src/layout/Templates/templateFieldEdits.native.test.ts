/**
 * Template fields through the engine (B3): a field write and a Batch Fill row
 * are ONE undo entry each, undo restores the document exactly, and what the
 * API cannot address (a media slot, a vanished layer, a bad cell) is reported
 * rather than written around the engine.
 */

import { setupAppEngine, historyLabels, settleEdits } from '@core/engine/__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import type { TemplateField } from '@core/template/templateTypes';
import { useTemplateStore } from '@stores/templateStore';
import { engineBatchFieldOps, fillDataRowEdit,  slotBoxOf, templateFieldCommands, templateFieldValues } from './templateFieldEdits';
import { documentMirror } from '@stores/documentMirror';

let h: Harness;
let s: Scene;

beforeEach(async () => {
  h = await setupAppEngine();
  s = await buildScene(h);
  // templateFieldCommands composes from the layers' trees (the fill-in panel keeps them loaded).
  await documentMirror().loadTrees(documentMirror().layerIds());
});
afterEach(async () => {
  useTemplateStore.getState().exit();
  await h.dispose();
});

const prop = async (nodeId: string, type: string, key: string): Promise<unknown> =>
  ((await docView()).getNode(nodeId)?.components.find((c) => c.type === type)?.props as Record<string, unknown> | undefined)?.[key];

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
  it('addresses Source Text and the layer fill; not a media slot or a vanished layer', async () => {
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
    const before = (await h.doc());
    const n = (await historyLabels()).length;
    const res = await fillDataRowEdit(
      [textField(), colorField(), mediaField()],
      { headline: 'Ada Lovelace', accent: '00ff00', clip: 'C:/x.mp4', notes: 'ignored' },
      'Fill row 1',
      0,
    );
    await settleEdits();
    expect(res).toEqual({ filled: ['headline', 'accent'], skippedKind: ['clip'], failed: [] });
    expect((await prop(s.T, 'Text', 'content'))).toBe('Ada Lovelace');
    expect(String((await prop(s.T, 'Text', 'fill'))).toLowerCase()).toMatch(/^#00ff00/);
    expect((await historyLabels()).length).toBe(n + 1);
    expect((await historyLabels()).at(-1)).toBe('Fill row 1');
    const after = (await h.doc());
    await h.run({ type: 'undo' });
    expect((await h.doc())).toBe(before);
    await h.run({ type: 'redo' });
    expect((await h.doc())).toBe(after);
  });

  it('reports a bad cell as failed and writes nothing when no field matched', async () => {
    const n = (await historyLabels()).length;
    const res = await fillDataRowEdit([colorField()], { accent: 'zzz' }, 'Fill row 2', 0);
    await settleEdits();
    expect(res).toEqual({ filled: [], skippedKind: [], failed: ['accent'] });
    expect((await historyLabels()).length).toBe(n);
  });
});

describe('templateStore.setField', () => {
  it('writes a text field through the engine as one entry and keeps the value map live', async () => {
    const field = textField();
    useTemplateStore.setState({
      active: { id: '__authored', name: 'T', width: 1920, height: 1080, layout: () => {}, fields: [field] },
      values: { headline: '' },
    });
    const before = (await h.doc());
    const n = (await historyLabels()).length;
    useTemplateStore.getState().setField('headline', 'Grace');
    await settleEdits();
    expect(useTemplateStore.getState().values.headline).toBe('Grace');
    expect((await prop(s.T, 'Text', 'content'))).toBe('Grace');
    expect((await historyLabels()).length).toBe(n + 1);
    expect((await historyLabels()).at(-1)).toBe('Edit Headline');
    await h.run({ type: 'undo' });
    expect((await h.doc())).toBe(before);
  });

  it('routes the commands through the caller’s send (a typing gesture)', async () => {
    const field = colorField();
    useTemplateStore.setState({
      active: { id: '__authored', name: 'T', width: 1920, height: 1080, layout: () => {}, fields: [field] },
      values: {},
    });
    const sent: Array<[string, unknown[]]> = [];
    useTemplateStore.getState().setField('accent', '#0000ff', (label, cmds) => { sent.push([label, cmds]); });
    expect(sent).toHaveLength(1);
    expect(sent[0]![0]).toBe('Edit Accent');
    expect(sent[0]![1][0]).toMatchObject({ type: 'setProperty', prop: { layer: s.T, path: 'layer/fill' } });
  });
});

describe('reads through the engine (B4 round 5)', () => {
  it('templateFieldValues: Source Text, the Fill Color as hex, a slot media URL', async () => {
    const v = await templateFieldValues([textField(), colorField(), mediaField()], 0);
    expect(v.headline).toBe((await prop(s.T, 'Text', 'content')));
    expect(v.accent).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/);
    expect(v.clip).toBe(documentMirror().item(s.footage)?.mediaUrl);
    expect(v.clip).toBeTruthy();
  });

  it('slotBoxOf: the slot fields written through the engine decide the box', async () => {
    const V = s.V;
    await h.batch('slot', [
      { type: 'setProperty', prop: { layer: V, path: 'layer/slotFit' }, value: { kind: 'choice', value: 'cover' } },
      { type: 'setProperty', prop: { layer: V, path: 'layer/slotWidth' }, value: { kind: 'scalar', value: 300 } },
      { type: 'setProperty', prop: { layer: V, path: 'layer/slotHeight' }, value: { kind: 'scalar', value: 200 } },
    ]);
    // Cover keeps the slot rect (the crop is in UV space).
    expect(await slotBoxOf(V, { width: 640, height: 360 }, 0)).toEqual({ width: 300, height: 200 });
    await h.run({ type: 'setProperty', prop: { layer: V, path: 'layer/slotFit' }, value: { kind: 'choice', value: 'contain' } });
    expect(await slotBoxOf(V, { width: 640, height: 360 }, 0)).toEqual({ width: 300, height: 169 });
    expect(await slotBoxOf(V, null, 0)).toBeNull();
  });
});

describe('engineBatchFieldOps', () => {
  it('reads the fields, fills a row and puts the template back as one entry', async () => {
    const ops = engineBatchFieldOps(0);
    const saved = await ops.read([textField(), colorField(), mediaField()]);
    expect(saved.map((x) => x.field.id)).toEqual(['headline', 'accent']);
    await ops.fill([textField()], { headline: 'Grace' }, 'Fill row 1');
    await settleEdits();
    expect((await prop(s.T, 'Text', 'content'))).toBe('Grace');
    await ops.restore(saved, 'Restore template after batch');
    await settleEdits();
    expect((await historyLabels()).at(-1)).toBe('Restore template after batch');
    expect((await prop(s.T, 'Text', 'content'))).toBe(saved[0]!.value);
  });
});
