/**
 * TextEditOverlay — on-canvas text editing.
 *
 * The bug: text was edited via `window.prompt`, which Electron's Chromium
 * refuses — so double-clicking a text layer did NOTHING in the desktop build
 * the product ships as. These tests exercise the replacement in a real render.
 *
 * The commit goes through the engine API (B3, docs/B3_PATTERNS.md): the layer
 * is built by the app engine, every commit is ONE undo entry, undo restores.
 */

import { render, act, fireEvent, cleanup } from '@testing-library/react';
import type { Value } from '@motion/engine-api';
import { defaultAnimation } from '@motion/animation';
import { TextEditOverlay, insideKeepZone } from './TextEditOverlay';
import { ColorPicker } from '@components/ColorPicker';
import { useTextEditStore } from '@stores/textEditStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { engineIdle } from '@core/engine/engineInstance';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import { sec, type Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';


// The overlay only needs a placement to position itself; the scene graph is real.
jest.mock('@core/workspace/WorkspaceController', () => ({
  getWorkspaceController: () => ({
    getNodeScreenPlacement: () => ({ x: 400, y: 300, zoom: 1, rotationDeg: 0, scaleX: 1, scaleY: 1 }),
    requestRender: () => {},
  }),
}));

const COMP = 'comp_root';
let h: Harness & { engine: LocalEngine };
/** The text layer under edit (an engine-minted id). */
let T = '';

/** A text layer of the active composition, built through the engine. */
async function textLayer(content: string, fields: Array<[string, Value]> = []): Promise<string> {
  const { layer } = await h.run({ type: 'createLayer', comp: COMP, kind: 'text', name: 'Text', init: [] });
  await h.run({ type: 'setProperty', prop: { layer, path: 'text/sourceText' }, value: { kind: 'string', value: content } });
  const base: Array<[string, Value]> = [
    ['text/fontSize', { kind: 'scalar', value: 48 }],
    ['text/align', { kind: 'choice', value: 'center' }],
    ['layer/fill', { kind: 'color', value: { r: 0, g: 1, b: 0x88 / 255, a: 1 } }],
  ];
  for (const [path, value] of [...base, ...fields]) await h.run({ type: 'setProperty', prop: { layer, path }, value });
  return layer;
}

function contentOf(id: string): string {
  return defaultSceneGraph.getNode(id)!.components.find((c) => c.type === 'Text')!.props.content as string;
}

/** Fire a DOM event that commits, and wait for the engine edit to land. */
async function commitWith(fire: () => void): Promise<void> {
  await act(async () => {
    fire();
    await engineIdle();
  });
}

const ctrlEnter = (): KeyboardEvent => new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true });

beforeEach(async () => {
  h = await setupAppEngine();
  T = await textLayer('Hello');
  useTextEditStore.getState().end();
});

afterEach(async () => {
  cleanup();
  useTextEditStore.getState().end();
  await h.dispose();
});

describe('TextEditOverlay', () => {
  it('renders nothing until a text layer is being edited', () => {
    const { container, queryByRole } = render(<TextEditOverlay />);
    expect(queryByRole('textbox')).toBeNull();
    expect(container.querySelector('[contenteditable]')).toBeNull();
  });

  it('opens an editable box seeded with the layer text — not a window.prompt', () => {
    const promptSpy = jest.spyOn(window, 'prompt');
    const { getByRole } = render(<TextEditOverlay />);
    act(() => useTextEditStore.getState().begin(T));

    const box = getByRole('textbox');
    expect(box.getAttribute('contenteditable')).toBe('true');
    expect(box.textContent).toBe('Hello');
    // The whole point: no prompt — that's what Electron refuses.
    expect(promptSpy).not.toHaveBeenCalled();
    promptSpy.mockRestore();
  });

  it('matches the layer style (colour, alignment)', () => {
    const { getByRole } = render(<TextEditOverlay />);
    act(() => useTextEditStore.getState().begin(T));
    const box = getByRole('textbox') as HTMLElement;
    expect(box.style.textAlign).toBe('center');
    expect(box.style.color).toContain('0, 255, 136'); // #00ff88 (browsers normalise to rgb)
    expect(box.style.fontSize).toBe('48px');
  });

  it('commits on Ctrl+Enter and closes', async () => {
    const { getByRole, queryByRole } = render(<TextEditOverlay />);
    act(() => useTextEditStore.getState().begin(T));

    const box = getByRole('textbox');
    box.innerText = 'Goodbye';
    await commitWith(() => box.dispatchEvent(ctrlEnter()));

    expect(contentOf(T)).toBe('Goodbye');
    expect(useTextEditStore.getState().nodeId).toBeNull();
    expect(queryByRole('textbox')).toBeNull();
  });

  it('records the edit as ONE undo entry, with the auto-name that follows the text; undo restores', async () => {
    const before = h.doc();
    const entries = historyLabels().length;
    const { getByRole } = render(<TextEditOverlay />);
    act(() => useTextEditStore.getState().begin(T));
    const box = getByRole('textbox');
    box.innerText = 'Recorded';
    await commitWith(() => box.dispatchEvent(ctrlEnter()));

    expect(contentOf(T)).toBe('Recorded');
    // AE: a layer still named by the tool is named after what it says.
    expect(defaultSceneGraph.getNode(T)!.name).toBe('Recorded');
    expect(historyLabels().length).toBe(entries + 1);
    expect(historyLabels().at(-1)).toBe('Edit Text');
    const after = h.doc();

    await act(async () => { await h.run({ type: 'undo' }); });
    expect(h.doc()).toBe(before);
    expect(contentOf(T)).toBe('Hello');
    await act(async () => { await h.run({ type: 'redo' }); });
    expect(h.doc()).toBe(after);
  });

  it('keeps a name the user typed', async () => {
    await h.run({ type: 'renameLayer', layer: T, name: 'Title card' });
    const { getByRole } = render(<TextEditOverlay />);
    act(() => useTextEditStore.getState().begin(T));
    const box = getByRole('textbox');
    box.innerText = 'Renamed?';
    await commitWith(() => box.dispatchEvent(ctrlEnter()));

    expect(contentOf(T)).toBe('Renamed?');
    expect(defaultSceneGraph.getNode(T)!.name).toBe('Title card');
  });

  it('shifts the style runs with the characters they style (text/styleRuns, same entry)', async () => {
    // "world" styled; typing before it moves the run, it does not restyle other text.
    await h.run({ type: 'setProperty', prop: { layer: T, path: 'text/sourceText' }, value: { kind: 'string', value: 'Hello world' } });
    const runs = [{ start: 6, end: 11, style: { fill: '#ff0000' } }];
    await h.run({ type: 'setProperty', prop: { layer: T, path: 'text/styleRuns' }, value: { kind: 'json', value: JSON.stringify(runs) } });
    const entries = historyLabels().length;
    const { getByRole } = render(<TextEditOverlay />);
    act(() => useTextEditStore.getState().begin(T));
    const box = getByRole('textbox');
    box.innerText = 'Hey Hello world';
    await commitWith(() => box.dispatchEvent(ctrlEnter()));

    const text = defaultSceneGraph.getNode(T)!.components.find((c) => c.type === 'Text')!.props;
    expect(text.content).toBe('Hey Hello world');
    expect(text.__runs).toEqual([{ start: 10, end: 15, style: { fill: '#ff0000' } }]);
    expect(text.__runsIndex).toBe('grapheme');
    expect(historyLabels().length).toBe(entries + 1);
  });

  it('an unchanged commit writes nothing', async () => {
    const before = h.doc();
    const entries = historyLabels().length;
    const { getByRole } = render(<TextEditOverlay />);
    act(() => useTextEditStore.getState().begin(T));
    const box = getByRole('textbox');
    box.innerText = 'Hello'; // jsdom has no innerText: state what the box shows
    await commitWith(() => box.dispatchEvent(ctrlEnter()));

    expect(useTextEditStore.getState().nodeId).toBeNull();
    expect(historyLabels().length).toBe(entries);
    expect(h.doc()).toBe(before);
  });

  it('animated Source Text: the edit keys the playhead (one entry); undo restores the key', async () => {
    await h.run({
      type: 'addKeyframes',
      keys: [
        { prop: { layer: T, path: 'text/sourceText' }, time: 0, value: { kind: 'string', value: 'Hello' }, spatialIn: [], spatialOut: [] },
        { prop: { layer: T, path: 'text/sourceText' }, time: sec(1), value: { kind: 'string', value: 'Later' }, spatialIn: [], spatialOut: [] },
      ],
    });
    const before = h.doc();
    const entries = historyLabels().length;
    const { getByRole } = render(<TextEditOverlay />);
    act(() => useTextEditStore.getState().begin(T));
    const box = getByRole('textbox');
    box.innerText = 'Keyed';
    await commitWith(() => box.dispatchEvent(ctrlEnter()));

    const keys = defaultAnimation.getDataTrack(T, 'text.source')!.keyframes;
    expect(keys.map((k) => k.value)).toEqual(['Keyed', 'Later']);
    expect(useTextEditStore.getState().nodeId).toBeNull();
    expect(historyLabels().length).toBe(entries + 1);
    expect(historyLabels().at(-1)).toBe('Edit Source Text keyframe');
    await act(async () => { await h.run({ type: 'undo' }); });
    expect(h.doc()).toBe(before);
  });

  it('commits on Escape — After Effects keeps the edits', async () => {
    const { getByRole } = render(<TextEditOverlay />);
    act(() => useTextEditStore.getState().begin(T));
    const box = getByRole('textbox');
    box.innerText = 'Kept';
    await commitWith(() => box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));

    expect(contentOf(T)).toBe('Kept');
    expect(useTextEditStore.getState().nodeId).toBeNull();
  });

  it('discards edits only on the explicit Shift+Escape', async () => {
    const entries = historyLabels().length;
    const { getByRole } = render(<TextEditOverlay />);
    act(() => useTextEditStore.getState().begin(T));
    const box = getByRole('textbox');
    box.innerText = 'Should not stick';
    await commitWith(() => box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', shiftKey: true, bubbles: true })));

    expect(contentOf(T)).toBe('Hello');
    expect(useTextEditStore.getState().nodeId).toBeNull();
    expect(historyLabels().length).toBe(entries);
  });

  it('commits on the numeric keypad Enter', async () => {
    const { getByRole } = render(<TextEditOverlay />);
    act(() => useTextEditStore.getState().begin(T));
    const box = getByRole('textbox');
    box.innerText = 'Keypad';
    await commitWith(() => box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'NumpadEnter', bubbles: true, cancelable: true })));

    expect(contentOf(T)).toBe('Keypad');
    expect(useTextEditStore.getState().nodeId).toBeNull();
  });

  it('keeps editing when focus moves into the Character panel, and commits on an outside click', async () => {
    const { getByRole } = render(<TextEditOverlay />);
    act(() => useTextEditStore.getState().begin(T));
    const box = getByRole('textbox');

    // Created AFTER the lookup: the panel's input is a textbox too.
    const panel = document.createElement('div');
    panel.setAttribute('data-text-edit-keep', '');
    const field = document.createElement('input');
    panel.appendChild(field);
    document.body.appendChild(panel);
    try {
      box.innerText = 'Styled';
      act(() => box.dispatchEvent(new FocusEvent('blur', { relatedTarget: field })));
      act(() => box.dispatchEvent(new FocusEvent('focusout', { relatedTarget: field, bubbles: true })));
      expect(useTextEditStore.getState().nodeId).toBe(T);

      await commitWith(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
      expect(contentOf(T)).toBe('Styled');
      expect(useTextEditStore.getState().nodeId).toBeNull();
    } finally {
      panel.remove();
    }
  });

  it('Enter does not commit — it is a newline, like After Effects', () => {
    const { getByRole } = render(<TextEditOverlay />);
    act(() => useTextEditStore.getState().begin(T));
    const box = getByRole('textbox');
    act(() => box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));

    expect(useTextEditStore.getState().nodeId).toBe(T);
    expect(contentOf(T)).toBe('Hello');
  });

  it('keeps editing through clicks inside a PORTALLED popover opened from the panel (colour picker)', async () => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
    render(<TextEditOverlay />);
    // The Character panel is a keep zone; the picker lives inside it.
    const panel = render(
      <div data-text-edit-keep="">
        <ColorPicker value="#ff0000" onChange={() => {}} />
      </div>,
    );
    act(() => useTextEditStore.getState().begin(T));
    const trigger = panel.getByRole('button', { name: /pick a color/i });
    act(() => {
      fireEvent.pointerDown(trigger);
      fireEvent.click(trigger);
    });
    expect(useTextEditStore.getState().nodeId).toBe(T);

    const content = document.querySelector('[role="dialog"]');
    expect(content).not.toBeNull();
    // Really portalled out of the panel — the case the attribute exists for.
    expect(panel.container.contains(content)).toBe(false);
    const inner = content!.querySelector('input') ?? content!;
    act(() => {
      inner.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(useTextEditStore.getState().nodeId).toBe(T);

    // A genuine outside click still commits.
    await commitWith(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(useTextEditStore.getState().nodeId).toBeNull();
  });

  it('treats a text node inside a keep zone (font picker list row) as inside', () => {
    const pop = document.createElement('div');
    pop.setAttribute('data-text-edit-keep', '');
    const label = document.createTextNode('Inter');
    pop.appendChild(label);
    document.body.appendChild(pop);
    try {
      expect(insideKeepZone(label)).toBe(true);
      expect(insideKeepZone(document.body)).toBe(false);
    } finally {
      pop.remove();
    }
  });

  it('a fixed paragraph box clips, aligns like the painter, and flags overflow live', async () => {
    const put = async (boxHeight: number, align: string): Promise<void> => {
      T = await textLayer('Hi', [
        ['text/fontSize', { kind: 'scalar', value: 20 }],
        ['text/lineHeight', { kind: 'scalar', value: 1.2 }],
        ['text/fontFamily', { kind: 'string', value: 'Arial' }],
        ['text/boxWidth', { kind: 'scalar', value: 300 }],
        ['text/boxAutoSize', { kind: 'choice', value: 'off' }],
        ['text/boxHeight', { kind: 'scalar', value: boxHeight }],
        ['text/boxVerticalAlign', { kind: 'choice', value: align }],
      ]);
    };
    // Centred in a 300px box: the 24px line block starts 138px down, as drawn.
    await put(300, 'center');
    const { getByRole, unmount } = render(<TextEditOverlay />);
    act(() => useTextEditStore.getState().begin(T));
    let box = getByRole('textbox') as HTMLElement;
    expect(box.style.overflow).toBe('hidden');
    expect(parseFloat(box.style.paddingTop)).toBeCloseTo(138, 3);
    expect(box.getAttribute('data-overflow')).toBeNull();
    act(() => useTextEditStore.getState().end());
    unmount();

    // Bottom-aligned but overflowing: yields to top, and typing a line that
    // does not fit raises the overflow flag before anything is committed.
    await put(30, 'bottom');
    const again = render(<TextEditOverlay />);
    act(() => useTextEditStore.getState().begin(T));
    box = again.getByRole('textbox') as HTMLElement;
    expect(parseFloat(box.style.paddingTop || '0')).toBeCloseTo(6, 3);
    act(() => {
      box.innerText = 'Hi\nthere';
      fireEvent.input(box);
    });
    expect(box.getAttribute('data-overflow')).toBe('true');
    expect(parseFloat(box.style.paddingTop || '0')).toBe(0);
    expect(contentOf(T)).toBe('Hi');
  });

  it('Shift+Enter does not commit (newline in multi-line text)', () => {
    const { getByRole } = render(<TextEditOverlay />);
    act(() => useTextEditStore.getState().begin(T));
    const box = getByRole('textbox');
    act(() => box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })));

    // Still open — Shift+Enter is a newline, not a commit.
    expect(useTextEditStore.getState().nodeId).toBe(T);
  });
});
