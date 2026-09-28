/**
 * The picker's three strips, and the one thing that is easy to get wrong.
 *
 * The document strip is DERIVED, and the whole reason it is affordable is that
 * it derives on open rather than on every scene bump. That is a timing
 * property, and timing properties are exactly what a rendered snapshot cannot
 * see — so it is asserted directly: nothing is collected while the popover is
 * shut, and the colours appear once it opens.
 */

import { render, screen, fireEvent, within, act } from '@testing-library/react';
import { ColorPicker, colorManagementSummary } from './ColorPicker';
import { useColorManagementStore } from '@stores/colorManagementStore';
import { useSwatchStore } from '@stores/swatchStore';
import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';

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
  it('shows the project palette where colours are chosen, labelled as such', () => {
    useSwatchStore.getState().addSwatch('#00ff00', 'Brand Green');
    render(<ColorPicker value="#123456" onChange={jest.fn()} />);

    open();

    expect(screen.getByText('Project swatches')).toBeTruthy();
    const strip = screen.getByLabelText('Project swatches');
    expect(within(strip).getByLabelText('Use Brand Green')).toBeTruthy();
  });

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
  it('derives on open, not before', async () => {
    // A real layer of the composition: the colours are the engine's getDocumentColors answer (B4).
    const h = await setupAppEngine();
    const { layer } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'shape', name: 'a', init: [] });
    await h.run({ type: 'setProperty', prop: { layer, path: 'layer/fills' }, value: { kind: 'json', value: JSON.stringify([{ type: 'solid', color: '#c0ffee' }]) } });
    await engineIdle();
    useSwatchStore.setState({ documentColors: [] });
    render(<ColorPicker value="#123456" onChange={jest.fn()} />);

    // Closed: nothing has walked the graph.
    expect(useSwatchStore.getState().documentColors).toEqual([]);
    expect(screen.queryByLabelText('Document colors')).toBeNull();

    open();

    // The engine's getDocumentColors answer lands asynchronously (B4).
    const strip = await screen.findByLabelText('Document colors');
    expect(within(strip).getByLabelText('Use #c0ffee')).toBeTruthy();
    await h.dispose();
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

/*
 * A hex is not a colour until you know what space it is in: the same
 * `#B34A2F` is a different pixel under ACEScg than under linear Rec.709. The
 * readout is the picker's disclosure of that, and it is a READOUT — the
 * settings are project-wide and render-affecting, so a swatch popover must
 * never be able to change them.
 */
describe('colour-management readout', () => {
  afterEach(() => {
    act(() => {
      useColorManagementStore.getState().setWorkingSpace('srgb-linear');
      useColorManagementStore.getState().setDisplayTransform('srgb');
      useColorManagementStore.getState().setBitDepth(16);
    });
  });

  it('names the working space, the display transform and the bit depth', () => {
    expect(colorManagementSummary({ workingSpace: 'srgb-linear', displayTransform: 'srgb', bitDepth: 16 }))
      .toBe('Linear Rec.709 · sRGB · 16-bit');
    expect(colorManagementSummary({ workingSpace: 'aces-cg', displayTransform: 'aces', bitDepth: 32 }))
      .toBe('ACEScg · ACES · 32-bit');
  });

  it('shows the project`s current settings when the popover opens', () => {
    render(<ColorPicker value="#123456" onChange={jest.fn()} />);
    open();
    expect(screen.getByText('Linear Rec.709 · sRGB · 16-bit')).toBeTruthy();
  });

  it('follows a change made in project settings', () => {
    render(<ColorPicker value="#123456" onChange={jest.fn()} />);
    act(() => {
      useColorManagementStore.getState().setWorkingSpace('aces-cg');
      useColorManagementStore.getState().setDisplayTransform('pq');
      useColorManagementStore.getState().setBitDepth(32);
    });
    open();
    expect(screen.getByText('ACEScg · PQ · 32-bit')).toBeTruthy();
  });

  it('offers no control that could re-grade the comp from inside a swatch', () => {
    render(<ColorPicker value="#123456" onChange={jest.fn()} />);
    open();
    const readout = screen.getByText('Linear Rec.709 · sRGB · 16-bit').parentElement!;
    expect(readout.querySelector('button, input, select')).toBeNull();
  });
});
