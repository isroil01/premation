/**
 * Replace Fonts — the dialog lists what is missing and where, and Replace
 * writes the substitution to the scene (layer fonts AND rich-text runs) as
 * ONE undo entry.
 */

import { render, screen, fireEvent, within, act, cleanup } from '@testing-library/react';
import { defaultAnimation } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { setCommandSystem, CommandSystem, getCommandSystem } from '@core/commands/CommandSystem';
import { readRuns } from '@core/text/richText';
import { collectFontUsage } from '@core/fonts/missingFonts';
import { RECENT_FONTS_KEY, resetFontPrefsCacheForTest } from '@core/fonts/fontPrefs';
import { checkMissingFonts } from './missingFontsWatcher';
import { useUIStore } from '@stores/uiStore';
import { useModalStore, closeAllModals } from '@stores/modalStore';
import type { SceneNode } from '@core/types';
import { ReplaceFontsBody, REPLACE_FONTS_MODAL_ID } from './ReplaceFontsDialog';
import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';

class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function textLayer(id: string, name: string, props: Record<string, unknown>): SceneNode {
  return {
    id, name, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'text', x: 0, y: 0 } },
      { id: `${id}_c`, type: 'Text', props },
    ],
  } as unknown as SceneNode;
}

function allNodes(): SceneNode[] {
  const out: SceneNode[] = [];
  defaultSceneGraph.traverse((n) => { out.push(n); });
  return out;
}

const textProps = (id: string): Record<string, unknown> =>
  defaultSceneGraph.getNode(id)!.components.find((c) => c.type === 'Text')!.props as Record<string, unknown>;

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver;
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
});

beforeEach(() => {
  localStorage.clear();
  resetFontPrefsCacheForTest();
  defaultAnimation.clear();
  defaultSceneGraph.clear();
  getCommandSystem().getHistory().clear();
  defaultSceneGraph.addNode({
    id: 'comp_root', name: 'Main', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'comp_root_meta', type: 'group', props: { __kind: 'group' } }],
  } as unknown as SceneNode);
  defaultSceneGraph.addChild('comp_root', textLayer('a', 'Title', { content: 'Hello', fontFamily: 'Brand Sans' }) as never);
  defaultSceneGraph.addChild('comp_root', textLayer('b', 'Lower third', {
    content: 'World',
    fontFamily: 'Inter',
    __runs: [{ start: 0, end: 2, style: { fontFamily: 'brand sans' } }],
    __runsIndex: 'grapheme',
  }) as never);
});

afterEach(() => {
  cleanup();
  closeAllModals();
});

describe('ReplaceFontsBody', () => {
  it('lists the family, a Missing badge and the layers using it; Replace starts disabled', () => {
    const usages = collectFontUsage(allNodes());
    render(<ReplaceFontsBody usages={usages} missingKeys={new Set(['brand sans'])} close={() => {}} />);
    const row = screen.getByRole('listitem', { name: 'Brand Sans' });
    expect(within(row).getByText('Missing')).toBeTruthy();
    expect(within(row).getByText(/2 layers: Title, Lower third/)).toBeTruthy();
    // Missing families first.
    expect(screen.getAllByRole('listitem')[0]).toBe(row);
    expect(screen.getByRole('button', { name: 'Replace' })).toBeDisabled();
  });

  it('Replace writes layer fonts and run fonts in ONE undo entry (engine: text/fontFamily + text/styleRuns)', async () => {
    // The document on the app engine: the same two layers, built through the API.
    const h = await setupAppEngine();
    const mk = async (name: string): Promise<string> => (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'text', name, init: [] })).layer;
    const a = await mk('Title');
    const b = await mk('Lower third');
    await h.batch('Setup', [
      { type: 'setProperty', prop: { layer: a, path: 'text/fontFamily' }, value: { kind: 'string', value: 'Brand Sans' } },
      { type: 'setProperty', prop: { layer: b, path: 'text/fontFamily' }, value: { kind: 'string', value: 'Inter' } },
      { type: 'setProperty', prop: { layer: b, path: 'text/styleRuns' }, value: { kind: 'json', value: JSON.stringify([{ start: 0, end: 2, style: { fontFamily: 'brand sans' } }]) } },
    ]);
    getCommandSystem().getHistory().clear();
    localStorage.setItem(RECENT_FONTS_KEY, JSON.stringify(['Georgia']));
    const close = jest.fn();
    render(<ReplaceFontsBody usages={collectFontUsage(allNodes())} missingKeys={new Set(['brand sans'])} close={close} />);

    const row = screen.getByRole('listitem', { name: 'Brand Sans' });
    await act(async () => { fireEvent.click(within(row).getByRole('button', { name: 'Brand Sans' })); });
    const recent = await screen.findByRole('listbox', { name: 'Recent fonts' });
    fireEvent.click(within(recent).getByTitle('Georgia'));

    const replace = screen.getByRole('button', { name: 'Replace' });
    expect(replace).not.toBeDisabled();
    await act(async () => { fireEvent.click(replace); await engineIdle(); });

    expect(close).toHaveBeenCalled();
    expect(textProps(a).fontFamily).toBe('Georgia');
    expect(textProps(b).fontFamily).toBe('Inter');
    expect(readRuns(defaultSceneGraph.getNode(b)!)[0]!.style.fontFamily).toBe('Georgia');
    expect(getCommandSystem().getHistory().getEntries()).toHaveLength(1);

    await act(async () => { await h.run({ type: 'undo' }); });
    expect(textProps(a).fontFamily).toBe('Brand Sans');
    expect(readRuns(defaultSceneGraph.getNode(b)!)[0]!.style.fontFamily).toBe('brand sans');
    await h.dispose();
  });
});

describe('the missing-font check', () => {
  it('shows ONE toast whose action opens Replace Fonts', async () => {
    const notify = jest.spyOn(useUIStore.getState(), 'notify');
    const missing = await checkMissingFonts((f) => f.toLowerCase() !== 'brand sans');
    expect(missing.map((m) => m.family)).toEqual(['Brand Sans']);
    expect(notify).toHaveBeenCalledTimes(1);
    const toast = notify.mock.calls[0]![0];
    expect(toast.message).toBe('1 font missing');
    toast.action!.onSelect();
    expect(useModalStore.getState().stack.some((m) => m.id === REPLACE_FONTS_MODAL_ID)).toBe(true);
    notify.mockRestore();
  });

  it('says nothing when every font is available', async () => {
    const notify = jest.spyOn(useUIStore.getState(), 'notify');
    expect(await checkMissingFonts(() => true)).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
    notify.mockRestore();
  });
});
