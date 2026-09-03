/**
 * The picker's three strips, and the one thing that is easy to get wrong.
 *
 * The document strip is DERIVED, and the whole reason it is affordable is that
 * it derives on open rather than on every scene bump. That is a timing
 * property, and timing properties are exactly what a rendered snapshot cannot
 * see — so it is asserted directly: nothing is collected while the popover is
 * shut, and the colours appear once it opens.
 */

import { render, screen, fireEvent, within } from '@testing-library/react';
import { ColorPicker } from './ColorPicker';
import { useSwatchStore } from '@stores/swatchStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';

function shapeNode(id: string, color: string): SceneNode {
  return {
    id,
    name: id,
    parent: null,
    children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true,
    locked: false,
    components: [
      { id: `${id}_meta`, type: 'group', props: { [SCENE_KIND_PROP]: 'shape' } },
      { id: `${id}_fx`, type: 'fx', props: { fill: { type: 'solid', color } } },
    ],
  };
}

/**
 * jsdom has no ResizeObserver, and Radix's Popover constructs one on open.
 * Without it every open() throws before an assertion runs — which reads as
 * "the picker is broken" rather than "the environment lacks a browser API".
 */
class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver;
});

function clearScene(): void {
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);
}

beforeEach(() => {
  clearScene();
  useSwatchStore.getState().restore([]);
  localStorage.clear();
});

function open(): void {
  fireEvent.click(screen.getByLabelText('Pick a color'));
}

describe('the Swatches strip', () => {
  it('applies a project swatch through onChange', () => {
    useSwatchStore.getState().addSwatch('#ff0000', 'Brand Red');
    const onChange = jest.fn();
    render(<ColorPicker value="#123456" onChange={onChange} />);

    open();
    fireEvent.click(screen.getByLabelText('Use Brand Red'));

    expect(onChange).toHaveBeenCalledWith('#ff0000');
  });

  it('"+" saves the current colour into the project palette', () => {
    render(<ColorPicker value="#abcdef" onChange={jest.fn()} />);

    open();
    fireEvent.click(screen.getByLabelText('Add current color to project swatches'));

    expect(useSwatchStore.getState().swatches.map((s) => s.hex)).toEqual(['#abcdef']);
  });

  it('right-click opens the rename row, and the name commits', () => {
    const sw = useSwatchStore.getState().addSwatch('#ff0000', 'Brand Red');
    render(<ColorPicker value="#123456" onChange={jest.fn()} />);

    open();
    fireEvent.contextMenu(screen.getByLabelText('Use Brand Red'));
    const input = screen.getByLabelText('Swatch name');
    fireEvent.change(input, { target: { value: 'Alert' } });
    fireEvent.blur(input);

    expect(useSwatchStore.getState().swatches.find((s) => s.id === sw?.id)?.name).toBe('Alert');
  });

  it('the rename row can delete the swatch it is editing', () => {
    useSwatchStore.getState().addSwatch('#ff0000', 'Brand Red');
    render(<ColorPicker value="#123456" onChange={jest.fn()} />);

    open();
    fireEvent.contextMenu(screen.getByLabelText('Use Brand Red'));
    // mouseDown, not click — the input's blur would otherwise re-render the
    // row away before a click landed. That is the bug this asserts against.
    fireEvent.mouseDown(screen.getByLabelText('Delete Brand Red'));

    expect(useSwatchStore.getState().swatches).toEqual([]);
  });
});

describe('the Document strip', () => {
  it('derives on open, not before', () => {
    defaultSceneGraph.addNode(shapeNode('a', '#c0ffee'));
    render(<ColorPicker value="#123456" onChange={jest.fn()} />);

    // Closed: nothing has walked the graph.
    expect(useSwatchStore.getState().documentColors).toEqual([]);
    expect(screen.queryByLabelText('Document colors')).toBeNull();

    open();

    const strip = screen.getByLabelText('Document colors');
    expect(within(strip).getByLabelText('Use #c0ffee')).toBeTruthy();
  });

  it('does not draw an empty strip for an unpainted document', () => {
    render(<ColorPicker value="#123456" onChange={jest.fn()} />);
    open();
    expect(screen.queryByLabelText('Document colors')).toBeNull();
  });
});

describe('recents are untouched by any of this', () => {
  it('still records the colour on close, and still lives in localStorage', () => {
    const { unmount } = render(<ColorPicker value="#abcdef" onChange={jest.fn()} />);
    open();
    fireEvent.keyDown(document, { key: 'Escape' });
    unmount();

    expect(localStorage.getItem('motion-editor.recentColors.v1')).toContain('#abcdef');
    // And nothing leaked into the document palette.
    expect(useSwatchStore.getState().swatches).toEqual([]);
  });
});
