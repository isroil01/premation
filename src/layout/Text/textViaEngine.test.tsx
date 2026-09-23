/**
 * B3 text migration — the Character / Paragraph panel, the text animator
 * section and the Path Options write through the engine API
 * (docs/B3_PATTERNS.md). Pinned on the app engine (`setupAppEngine`, the real
 * history) through the real components:
 *
 *   • one entry per user action (a typed value, a typing session, a button),
 *     undo restores the document exactly, redo reapplies;
 *   • animators and selectors are added / removed / enabled BY ID;
 *   • an animated property keys at the playhead (setValueAtTime);
 *   • Source Text typing is one gesture per focus; styled text (runs) and the
 *     engine gaps keep their legacy writers.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { defaultAnimation } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getEventBus } from '@core/events/EventBus';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { readAnimatorData } from '@core/text/textAnimators';
import { useProjectStore } from '@stores/projectStore';
import { TooltipProvider } from '@components/Tooltip';
import { TextSettingsBody } from '@layout/Inspector/CharacterPanel';
import { TextAnimatorControls } from '@layout/Inspector/TextAnimatorControls';
import { TextPathOptions } from '@layout/Inspector/TextOptionControls';
import { textPresetEdit, typewriterEdit } from './textEdits';

jest.useFakeTimers();

let h: Harness & { engine: LocalEngine };
let s: Scene;
beforeEach(async () => {
  h = await setupAppEngine();
  defaultAnimation.setChangeListener((nodeId) => getEventBus().emit('AnimationChanged', { nodeId }));
  s = await buildScene(h);
  act(() => { useProjectStore.getState().actions.setTime(0, 0); });
  getCommandSystem().getHistory().clear();
});
afterEach(async () => {
  cleanup();
  await h.dispose();
});

const idle = async (): Promise<void> => { await act(async () => { await engineIdle(); }); };
const textProps = (id: string): Record<string, unknown> =>
  defaultSceneGraph.getNode(id)!.components.find((c) => c.type === 'Text')!.props as Record<string, unknown>;
const animators = (id: string) => readAnimatorData(defaultSceneGraph.getNode(id)!);

function renderPanel(): void {
  render(<TooltipProvider><TextSettingsBody nodeId={s.T} nodeIds={[s.T]} variant="panel" /></TooltipProvider>);
}

const step = async (type: 'undo' | 'redo'): Promise<void> => { await act(async () => { await h.run({ type }); }); };

async function undoRedoExact(before: string): Promise<void> {
  const after = h.doc();
  await step('undo');
  expect(h.doc()).toBe(before);
  await step('redo');
  expect(h.doc()).toBe(after);
}

describe('Character panel', () => {
  test('a Font Size typing session (two keystrokes + the spinner) is ONE engine entry; undo/redo exact', async () => {
    renderPanel();
    const before = h.doc();
    const size = screen.getByLabelText('Font Size');
    fireEvent.change(size, { target: { value: '7' } });
    await idle();
    fireEvent.change(size, { target: { value: '72' } });
    await idle();
    fireEvent.blur(size);
    await idle();
    expect(textProps(s.T).fontSize).toBe(72);
    expect(historyLabels()).toEqual(['Set Font Size']);
    await undoRedoExact(before);
  });

  test('a Tracking session that starts unstored (legacy route) stays ONE entry — it never switches route mid-typing', async () => {
    renderPanel();
    expect(textProps(s.T).letterSpacing).toBeUndefined();
    const field = screen.getByLabelText('Tracking (Letter Spacing)');
    fireEvent.change(field, { target: { value: '4' } });
    await idle();
    fireEvent.change(field, { target: { value: '40' } });
    await idle();
    fireEvent.blur(field);
    act(() => { jest.advanceTimersByTime(2000); });
    await idle();
    expect(textProps(s.T).letterSpacing).toBe(40);
    expect(historyLabels()).toHaveLength(1);
    // The next session starts on a stored number: the engine route.
    fireEvent.change(field, { target: { value: '25' } });
    fireEvent.blur(field);
    await idle();
    expect(historyLabels()).toHaveLength(2);
    expect(historyLabels().at(-1)).toBe('Set Letter Spacing');
  });

  test('Font Size keys at the playhead when animated (setValueAtTime)', async () => {
    await h.run({ type: 'setAnimated', prop: { layer: s.T, path: 'text/fontSize' }, animated: true, time: 0 });
    act(() => { useProjectStore.getState().actions.setTime(1, 30); });
    getCommandSystem().getHistory().clear();
    renderPanel();
    const size = screen.getByLabelText('Font Size');
    fireEvent.change(size, { target: { value: '40' } });
    fireEvent.blur(size);
    await idle();
    expect(defaultAnimation.getTrackKeyframes(s.T, 'fontSize')).toHaveLength(2);
    expect(historyLabels()).toEqual(['Set Font Size']);
  });

  test('a text preset of numbers only goes through the engine as ONE entry', async () => {
    const before = h.doc();
    textPresetEdit([s.T], { fontSize: 33 });
    await idle();
    expect(textProps(s.T).fontSize).toBe(33);
    expect(historyLabels()).toEqual(['Apply Text preset']);
    await undoRedoExact(before);
  });

  test('a preset chip (size + weight + style) is ONE engine entry (G1: the weight is text/axes/wght, the style a text field)', async () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Headline' }));
    await idle();
    jest.advanceTimersByTime(2000);
    await idle();
    expect(textProps(s.T).fontSize).toBe(56);
    expect(textProps(s.T).fontWeight).toBe(700);
    expect(historyLabels()).toHaveLength(1);
  });

  test('the Content box: a typing session is ONE "Edit Text" entry, the text follows each keystroke', async () => {
    renderPanel();
    const before = h.doc();
    const box = screen.getByPlaceholderText('Type text content here...');
    fireEvent.change(box, { target: { value: 'He' } });
    await idle();
    expect(textProps(s.T).content).toBe('He');
    fireEvent.change(box, { target: { value: 'Hello' } });
    await idle();
    fireEvent.blur(box);
    await idle();
    expect(textProps(s.T).content).toBe('Hello');
    expect(historyLabels()).toEqual(['Edit Text']);
    await undoRedoExact(before);
  });

  test('the Source Text stopwatch is setAnimated; editing then keys at the playhead', async () => {
    renderPanel();
    fireEvent.click(screen.getByTitle('Keyframe Source Text across timeline'));
    await idle();
    expect(defaultAnimation.isDataAnimated(s.T, 'text.source')).toBe(true);
    act(() => { useProjectStore.getState().actions.setTime(1, 30); });
    const box = screen.getByPlaceholderText('Type text content here...');
    fireEvent.change(box, { target: { value: 'Later' } });
    fireEvent.blur(box);
    await idle();
    expect(defaultAnimation.getDataTrack(s.T, 'text.source')!.keyframes).toHaveLength(2);
    expect(historyLabels()).toEqual(['Animate Source Text', 'Edit Source Text keyframe']);
  });
});

describe('Text animators', () => {
  function renderAnimators(): void {
    render(<TooltipProvider><TextAnimatorControls nodeId={s.T} /></TooltipProvider>);
  }

  async function typeInto(name: string, value: string, nth = 0): Promise<void> {
    const field = screen.getAllByRole('spinbutton', { name })[nth]!;
    fireEvent.keyDown(field, { key: 'Enter' });
    const input = field.querySelector('input')!;
    fireEvent.change(input, { target: { value } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await idle();
  }

  test('Add animator / remove animator are one entry each, by id; undo exact', async () => {
    renderAnimators();
    const before = h.doc();
    fireEvent.click(screen.getByRole('button', { name: 'Add text animator' }));
    await idle();
    expect(animators(s.T)).toHaveLength(2);
    expect(historyLabels()).toEqual(['Add Text Animator']);
    await undoRedoExact(before);
    const mid = h.doc();
    fireEvent.click(screen.getByRole('button', { name: 'Remove animator 1' }));
    await idle();
    expect(animators(s.T).map((a) => a.id)).not.toContain(s.animator);
    expect(historyLabels().at(-1)).toBe('Remove Text Animator');
    await step('undo');
    expect(h.doc()).toBe(mid);
  });

  test('an animator property typed = one entry; its stopwatch + a later value key at the playhead', async () => {
    renderAnimators();
    const before = h.doc();
    await typeInto('Opacity', '0');
    expect(animators(s.T)[0]!.opacity).toBe(0);
    expect(historyLabels()).toEqual(['Set Opacity']);
    await undoRedoExact(before);
  });

  test('the range selector: Start stopwatch, then a value at 1 s keys there (Offset sweep idiom)', async () => {
    renderAnimators();
    const start = animators(s.T)[0]!.selectors![0]!;
    fireEvent.click(screen.getByRole('button', { name: 'Enable Start animation' }));
    await idle();
    expect(defaultAnimation.isAnimated(s.T, 'ta.0.start')).toBe(true);
    act(() => { useProjectStore.getState().actions.setTime(1, 30); });
    await typeInto('Start', '100');
    expect(defaultAnimation.getTrackKeyframes(s.T, 'ta.0.start')).toHaveLength(2);
    expect(historyLabels()).toEqual(['Animate Start', 'Set Start']);
    expect(start.id).toBeTruthy();
  });

  test('selector add / enable / remove go through the engine by id', async () => {
    renderAnimators();
    const before = h.doc();
    await act(async () => {
      const { addSelectorEdit } = await import('./textEdits');
      await addSelectorEdit(s.T, s.animator, 'wiggly');
    });
    await idle();
    expect(animators(s.T)[0]!.selectors).toHaveLength(2);
    const second = animators(s.T)[0]!.selectors![1]!;
    expect(second.kind).toBe('wiggly');
    fireEvent.click(screen.getAllByTitle('Enable selector')[1]!);
    await idle();
    expect(animators(s.T)[0]!.selectors![1]!.enabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Remove selector 2' }));
    await idle();
    expect(animators(s.T)[0]!.selectors).toHaveLength(1);
    expect(historyLabels()).toEqual(['Add Selector', 'Disable Selector', 'Remove Selector']);
    for (let i = 0; i < 3; i++) await step('undo');
    expect(h.doc()).toBe(before);
  });

  test('the animator enable switch is setGroupEnabled', async () => {
    renderAnimators();
    fireEvent.click(screen.getByTitle('Enable animator'));
    await idle();
    expect(animators(s.T)[0]!.enabled).toBe(false);
    expect(historyLabels()).toEqual(['Disable Animator']);
  });

  test('Auto-Animate Typing is ONE "Typewriter" entry: animator (Opacity 0), hard-edged selector, Start keyed 0 → 100', async () => {
    const before = h.doc();
    let ok = false;
    await act(async () => { ok = await typewriterEdit(s.T, 0); });
    expect(ok).toBe(true);
    const rig = animators(s.T)[1]!;
    expect(rig.opacity).toBe(0);
    expect((rig.selectors![0] as { smoothness: number }).smoothness).toBe(0);
    const keys = defaultAnimation.getTrackKeyframes(s.T, 'ta.1.start')!;
    expect(keys.map((k) => k.value)).toEqual([0, 100]);
    expect(historyLabels()).toEqual(['Typewriter']);
    await undoRedoExact(before);
  });
});

describe('Path Options', () => {
  test('a Path Options switch and margin are engine writes on the text-path properties', async () => {
    // Put the text on a mask path (the legacy attach — an engine gap), then edit its options.
    const { groups: [maskPath] } = await h.run({
      type: 'addMask', layer: s.T, mode: 'add', inverted: false,
      path: { vertices: [0, 0, 200, 0, 200, 100], inTangents: [], outTangents: [], closed: false, featherPoints: [] },
    });
    const { setTextPath, defaultTextPath } = await import('@core/text/textPath');
    act(() => { setTextPath(s.T, { ...defaultTextPath(), pathId: maskPath!.split('/')[1]! }); });
    jest.advanceTimersByTime(2000);
    await idle();
    getCommandSystem().getHistory().clear();
    render(<TooltipProvider><TextPathOptions nodeId={s.T} /></TooltipProvider>);
    const { readTextPathConfig } = await import('@core/text/textPath');
    const was = readTextPathConfig(defaultSceneGraph.getNode(s.T)!)!.perpendicular === true;
    const before = h.doc();
    fireEvent.click(screen.getByRole('button', { name: 'Perpendicular' }));
    await idle();
    expect(readTextPathConfig(defaultSceneGraph.getNode(s.T)!)!.perpendicular === true).toBe(!was);
    expect(historyLabels()).toEqual(['Set Perpendicular']);
    await undoRedoExact(before);
  });
});

describe('G1: text fields, selector fields, optional properties, Path Options ▸ Path', () => {
  test('Faux Bold (a text field) is ONE engine entry; undo/redo exact', async () => {
    renderPanel();
    const before = h.doc();
    fireEvent.click(screen.getByRole('button', { name: 'Faux Bold' }));
    await idle();
    expect(textProps(s.T).fauxBold).toBe(true);
    expect(historyLabels()).toHaveLength(1);
    await undoRedoExact(before);
  });

  test('the Mask Path menu attaches and detaches through text/pathOptions/path', async () => {
    const { groups: [maskPath] } = await h.run({
      type: 'addMask', layer: s.T, mode: 'none', inverted: false,
      path: { vertices: [0, 0, 200, 0, 200, 100], inTangents: [], outTangents: [], closed: false, featherPoints: [] },
    });
    getCommandSystem().getHistory().clear();
    renderPanel();
    const { readTextPathConfig } = await import('@core/text/textPath');
    const before = h.doc();
    fireEvent.change(screen.getByLabelText('Mask Path'), { target: { value: maskPath!.split('/')[1]! } });
    await idle();
    expect(readTextPathConfig(defaultSceneGraph.getNode(s.T)!)?.pathId).toBe(maskPath!.split('/')[1]);
    expect(historyLabels()).toEqual(['Text on Path']);
    await undoRedoExact(before);
  });

  test('a selector kind switch keeps its id and is ONE entry; Based On is a field write', async () => {
    const { selectorFieldsEdit } = await import('./textEdits');
    const sel = animators(s.T)[0]!.selectors![0]!;
    const before = h.doc();
    await act(async () => { await selectorFieldsEdit(s.T, s.animator, sel.id, { kind: 'wiggly' }); });
    await act(async () => { await selectorFieldsEdit(s.T, s.animator, sel.id, { basedOn: 'words', randomSeed: 3.4 }); });
    const now = animators(s.T)[0]!.selectors![0]!;
    expect(now.id).toBe(sel.id);
    expect(now.kind).toBe('wiggly');
    expect(now.basedOn).toBe('words');
    expect((now as { randomSeed: number }).randomSeed).toBe(3);
    expect(historyLabels()).toEqual(['Change Selector', 'Set Selector Option']);
    await step('undo');
    await step('undo');
    expect(h.doc()).toBe(before);
  });

  test('Add ▸ Property, the optional Fill Color, and removing them are engine commands', async () => {
    const { addAnimatorPropertiesEdit, animatorColorEdit, removeAnimatorPropertyEdit } = await import('./textEdits');
    const before = h.doc();
    await act(async () => { await addAnimatorPropertiesEdit(s.T, s.animator, ['skewAxis', 'axisGRAD']); });
    expect(animators(s.T)[0]!.skewAxis).toBe(0);
    expect(animators(s.T)[0]!.axes).toEqual({ GRAD: 0 });
    await act(async () => { await animatorColorEdit(s.T, s.animator, 'color', '#00ff00', false); });
    expect(animators(s.T)[0]!.color).toBe('#00ff00');
    await act(async () => { await removeAnimatorPropertyEdit(s.T, s.animator, 'skewAxis'); });
    expect(animators(s.T)[0]!.skewAxis).toBeUndefined();
    expect(historyLabels()).toEqual(['Add Properties', 'Add Property', 'Remove Property']);
    for (let i = 0; i < 3; i++) await step('undo');
    expect(h.doc()).toBe(before);
  });
});
