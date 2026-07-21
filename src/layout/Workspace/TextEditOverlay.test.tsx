/**
 * TextEditOverlay — on-canvas text editing.
 *
 * The bug: text was edited via `window.prompt`, which Electron's Chromium
 * refuses — so double-clicking a text layer did NOTHING in the desktop build
 * the product ships as. These tests exercise the replacement in a real render.
 */

import { render, act } from '@testing-library/react';
import { TextEditOverlay } from './TextEditOverlay';
import { useTextEditStore } from '@stores/textEditStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getEventBus } from '@core/events/EventBus';
import type { SceneNode } from '@core/types';


// The overlay only needs a placement to position itself; the scene graph is real.
jest.mock('@core/workspace/WorkspaceController', () => ({
  getWorkspaceController: () => ({
    getNodeScreenPlacement: () => ({ x: 400, y: 300, zoom: 1, rotationDeg: 0 }),
  }),
}));

function textNode(id: string, content: string): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { __kind: 'text', x: 400, y: 300, fontSize: 48, align: 'center', color: '#00ff88' } },
      { id: `${id}_txt`, type: 'Text', props: { content } },
    ],
  } as unknown as SceneNode;
}

function contentOf(id: string): string {
  return defaultSceneGraph.getNode(id)!.components.find((c) => c.type === 'Text')!.props.content as string;
}

beforeEach(() => {
  for (const id of ['t1']) { try { defaultSceneGraph.removeNode(id); } catch { /* ignore */ } }
  defaultSceneGraph.addNode(textNode('t1', 'Hello'));
  useTextEditStore.getState().end();
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
    act(() => useTextEditStore.getState().begin('t1'));

    const box = getByRole('textbox');
    expect(box.getAttribute('contenteditable')).toBe('true');
    expect(box.textContent).toBe('Hello');
    // The whole point: no prompt() — that's what Electron refuses.
    expect(promptSpy).not.toHaveBeenCalled();
    promptSpy.mockRestore();
  });

  it('matches the layer style (colour, alignment)', () => {
    const { getByRole } = render(<TextEditOverlay />);
    act(() => useTextEditStore.getState().begin('t1'));
    const box = getByRole('textbox') as HTMLElement;
    expect(box.style.textAlign).toBe('center');
    expect(box.style.color).toContain('0, 255, 136'); // #00ff88 (browsers normalise to rgb)
    expect(box.style.fontSize).toBe('48px');
  });

  it('commits on Enter and closes', () => {
    const { getByRole, queryByRole } = render(<TextEditOverlay />);
    act(() => useTextEditStore.getState().begin('t1'));

    const box = getByRole('textbox');
    box.innerText = 'Goodbye';
    act(() => {
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });

    expect(contentOf('t1')).toBe('Goodbye');
    expect(useTextEditStore.getState().nodeId).toBeNull();
    expect(queryByRole('textbox')).toBeNull();
  });

  it('emits NodeUpdated so the history snapshot records the edit', () => {
    // Text content is a plain node prop, so undo rides the same scene-snapshot
    // path as every canvas edit — driven by this event (wired in Providers).
    const events: unknown[] = [];
    const sub = getEventBus().on('NodeUpdated', (e) => events.push(e));

    const { getByRole } = render(<TextEditOverlay />);
    act(() => useTextEditStore.getState().begin('t1'));
    const box = getByRole('textbox');
    box.innerText = 'Recorded';
    act(() => box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));

    sub.dispose();
    expect(contentOf('t1')).toBe('Recorded');
    expect(events).toContainEqual(
      expect.objectContaining({ nodeId: 't1', propName: 'content', value: 'Recorded' }),
    );
  });

  it('discards edits on Escape', () => {
    const { getByRole } = render(<TextEditOverlay />);
    act(() => useTextEditStore.getState().begin('t1'));
    const box = getByRole('textbox');
    box.innerText = 'Should not stick';
    act(() => box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));

    expect(contentOf('t1')).toBe('Hello');
    expect(useTextEditStore.getState().nodeId).toBeNull();
  });

  it('Shift+Enter does not commit (newline in multi-line text)', () => {
    const { getByRole } = render(<TextEditOverlay />);
    act(() => useTextEditStore.getState().begin('t1'));
    const box = getByRole('textbox');
    act(() => box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })));

    // Still open — Shift+Enter is a newline, not a commit.
    expect(useTextEditStore.getState().nodeId).toBe('t1');
  });
});
