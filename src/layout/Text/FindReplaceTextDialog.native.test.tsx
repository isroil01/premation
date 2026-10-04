/**
 * Find and Replace Text — live count, Replace All across content, runs and
 * Source Text keyframes, one undo.
 */

import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { SOURCE_TEXT_PROP } from '@motion/animation';
import { readRuns } from '@core/text/richText';
import { SCENE_KIND_PROP } from '@core/scene/sceneKind';
import { useSelectionStore } from '@stores/selectionStore';
import { documentMirror } from '@stores/documentMirror';
import { insertFragment } from '@/engine-client/insertFragment';
import { clearHistory, settleEdits, setupAppEngine, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';
import type { SceneNode } from '@core/types';
import { FindReplaceTextBody } from './FindReplaceTextDialog';
import { mirrorCountInScope } from './textMirror';

function textLayer(id: string, props: Record<string, unknown>): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'text', x: 0, y: 0 } },
      { id: `${id}_c`, type: 'Text', props },
    ],
  } as unknown as SceneNode;
}

let h: Harness;
let T1 = '';
let T2 = '';

const content = async (id: string): Promise<unknown> =>
  ((await docView()).getNode(id)!.components.find((c) => c.type === 'Text')!.props as Record<string, unknown>).content;
const sourceKeys = async (id: string): Promise<unknown[]> =>
  (await docView()).getDataTrack(id, SOURCE_TEXT_PROP)!.keyframes.map((k) => k.value);

beforeEach(async () => {
  h = await setupAppEngine();
  useSelectionStore.getState().set([]);
  const ids = await insertFragment('Fixture', (b) => {
    const a = b.addChild('comp_root', textLayer('t1', {
      content: 'red cat, blue cat',
      __runs: [{ start: 9, end: 13, style: { fill: '#0000ff' } }],
      __runsIndex: 'grapheme',
    }));
    const c = b.addChild('comp_root', textLayer('t2', { content: 'Concatenate' }));
    b.setDataKeyframe(c, SOURCE_TEXT_PROP, 'text', 0, 'one cat');
    b.setDataKeyframe(c, SOURCE_TEXT_PROP, 'text', 1, 'two cats');
    return [a, c];
  }, { comp: 'comp_root', noSelect: true });
  const byName = (n: string): string => ids!.find((id) => documentMirror().layer(id)?.name === n)!;
  T1 = byName('t1');
  T2 = byName('t2');
  await settleEdits();
  // The dialog counts over the layers' trees (the app's text panels keep them loaded).
  await documentMirror().loadTrees([T1!, T2!]);
  await clearHistory();
});

afterEach(async () => {
  cleanup();
  await h.dispose();
});

describe('scope counting', () => {
  it('counts content and Source Text keyframes; whole word and selection scope narrow it', () => {
    const m = documentMirror();
    expect(mirrorCountInScope(m, 'all', [], 'comp_root', 'cat', {})).toEqual({ matches: 5, layers: 2 });
    expect(mirrorCountInScope(m, 'all', [], 'comp_root', 'cat', { wholeWord: true })).toEqual({ matches: 3, layers: 2 });
    expect(mirrorCountInScope(m, 'selected', [T1], 'comp_root', 'cat', {})).toEqual({ matches: 2, layers: 1 });
  });
});

describe('FindReplaceTextBody', () => {
  it('shows a live count and Replace All rewrites content, runs and keyframes in one undo', async () => {
    render(<FindReplaceTextBody close={() => {}} initialScope="all" />);
    const replaceAll = screen.getByRole('button', { name: 'Replace All' });
    expect(replaceAll).toBeDisabled();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Find'), { target: { value: 'cat' } });
      fireEvent.change(screen.getByLabelText('Replace with'), { target: { value: 'tiger' } });
      fireEvent.click(screen.getByLabelText('Whole word'));
    });
    expect(screen.getByRole('status').textContent).toBe('3 matches in 2 layers');

    await act(async () => { fireEvent.click(replaceAll); await settleEdits(); });
    expect(screen.getByRole('status').textContent).toBe('Replaced 3 matches in 2 layers.');
    expect(await content(T1)).toBe('red tiger, blue tiger');
    expect(await content(T2)).toBe('Concatenate'); // not a whole word
    // "blue" stays styled: 9..13 → 11..15 after the first "cat" grew by 2.
    expect(readRuns((await docView()).getNode(T1)!)).toEqual([{ start: 11, end: 15, style: { fill: '#0000ff' } }]);
    expect(await sourceKeys(T2)).toEqual(['one tiger', 'two cats']);

    await h.run({ type: 'undo' });
    expect(await content(T1)).toBe('red cat, blue cat');
    expect(await sourceKeys(T2)).toEqual(['one cat', 'two cats']);
  });

  it('Match case narrows the count', async () => {
    render(<FindReplaceTextBody close={() => {}} initialScope="all" />);
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Find'), { target: { value: 'CAT' } });
    });
    expect(screen.getByRole('status').textContent).toBe('5 matches in 2 layers');
    await act(async () => { fireEvent.click(screen.getByLabelText('Match case')); });
    expect(screen.getByRole('status').textContent).toBe('No matches.');
    expect(screen.getByRole('button', { name: 'Replace All' })).toBeDisabled();
  });
});
