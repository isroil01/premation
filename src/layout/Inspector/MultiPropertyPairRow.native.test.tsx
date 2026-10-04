/**
 * MultiPropertyPairRow — `Position [X][Y]` on one row, without losing what the
 * two separate rows could do.
 *
 * The risk of merging two rows is quiet capability loss: a mixed field that no
 * longer offsets per layer, a group stopwatch that seeds Y from X's reader, a
 * right-click that opens the wrong property's menu, a Z field appearing that
 * changes the hook count. Each of those is pinned here through the real
 * multi-selection seam and the C++ engine.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Command } from '@motion/engine-api';
import { requestExpressionEditor } from '@core/animation/expressionEditorRequests';
import { useContextMenuStore, closeContextMenu } from '@stores/contextMenuStore';
import { useProjectStore } from '@stores/projectStore';
import { documentMirror } from '@stores/documentMirror';
import { historyLabels, sampleTrack, sec, settleEdits, setupAppEngine, storedTrack, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';
import { InspectorSelectionProvider } from './inspectorSelection';
import { MultiPropertyPairRow, type PairFieldSpec } from './MultiPropertyPairRow';

let h: Harness;
let A = '';
let B = '';

const position2 = (x: number, y: number) => ({ kind: 'vec2', value: { x, y } });

async function addLayer(name: string, x: number, y: number): Promise<string> {
  const layer = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'rectangle', name, init: [] } as Command) as { layer: string }).layer;
  await h.run({ type: 'setProperty', prop: { layer, path: 'transform/position' }, value: position2(x, y) } as Command);
  return layer;
}

const spec = (prop: string, prefix: string, extra: Partial<PairFieldSpec> = {}): PairFieldSpec =>
  ({ prop, prefix, ...extra });

/** The stored value at 0 s (Position in px, Scale as the multiplier). */
const staticProp = (id: string, prop: string): Promise<number | undefined> => storedTrack(id, prop, 0);

/** Inspector writes are engine commands (B3): asynchronous. */
const idle = async (): Promise<void> => { await act(async () => { await settleEdits(); }); };

const setTime = (t: number): void => {
  act(() => { useProjectStore.getState().actions.setTime(t, Math.round(t * 30)); });
};

beforeEach(async () => {
  h = await setupAppEngine();
  A = await addLayer('pair_a', 5, 7);
  B = await addLayer('pair_b', 15, 7);
  await settleEdits();
  await documentMirror().loadTrees([A, B]);
  setTime(0);
  closeContextMenu();
});

afterEach(async () => {
  cleanup();
  await h.dispose();
});

const position = (ids: string[] = [A], props: PairFieldSpec[] = [spec('x', 'X'), spec('y', 'Y')]): JSX.Element => (
  <InspectorSelectionProvider nodeIds={ids}>
    <MultiPropertyPairRow nodeId={ids[0]!} label="Position" props={props} />
  </InspectorSelectionProvider>
);

describe('one row, every field a full field', () => {
  it('draws one labelled row with a named, prefixed field per property and ONE group stopwatch', async () => {
    const { container } = render(position());
    expect(screen.getByRole('spinbutton', { name: 'Position X' })).toHaveAttribute('aria-valuenow', '5');
    expect(screen.getByRole('spinbutton', { name: 'Position Y' })).toHaveAttribute('aria-valuenow', '7');
    expect([...container.querySelectorAll('[data-value-prefix]')].map((e) => e.textContent)).toEqual(['X', 'Y']);
    expect(screen.getAllByRole('button', { name: /animation$/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Enable Position animation' })).toBeInTheDocument();
  });

  it('a mixed field shows `—` and a nudge offsets EACH layer from its own value, as one undo step', async () => {
    render(position([A, B]));
    const x = screen.getByRole('spinbutton', { name: 'Position X' });
    expect(x).toHaveAttribute('aria-valuetext', 'Mixed');
    // Y agrees across the two layers, so it is not mixed.
    expect(screen.getByRole('spinbutton', { name: 'Position Y' })).not.toHaveAttribute('aria-valuetext', 'Mixed');

    const before = (await historyLabels()).length;
    fireEvent.keyDown(x, { key: 'ArrowUp' });
    await idle();
    expect(await staticProp(A, 'x')).toBe(6);
    expect(await staticProp(B, 'x')).toBe(16);
    expect((await historyLabels()).length - before).toBeLessThanOrEqual(1);
  });

  it('each field honours its OWN display unit', async () => {
    render(position([A], [spec('x', 'X', { displayContext: { scale: 10, unit: '%', precision: 2 } }), spec('y', 'Y')]));
    expect(screen.getByRole('spinbutton', { name: 'Position X' })).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByRole('spinbutton', { name: 'Position Y' })).toHaveAttribute('aria-valuenow', '7');
  });
});

describe('the group controls', () => {
  it('the stopwatch seeds EVERY member from its own reader (Y is not seeded from X)', async () => {
    render(position());
    fireEvent.click(screen.getByRole('button', { name: 'Enable Position animation' }));
    await idle();
    expect((await docView()).isAnimated(A, 'x')).toBe(true);
    expect((await docView()).isAnimated(A, 'y')).toBe(true);
    expect(await sampleTrack(A, 'x', 0)).toBeCloseTo(5);
    expect(await sampleTrack(A, 'y', 0)).toBeCloseTo(7);
  });

  it('the merged navigator steps to the nearest key of ANY member, and the diamond keys all of them', async () => {
    const prop = { layer: A, path: 'transform/position' };
    await h.run({ type: 'addKeyframes', keys: [
      { prop, time: 0, value: position2(5, 7), spatialIn: [], spatialOut: [] },
      { prop, time: sec(2), value: position2(5, 70), spatialIn: [], spatialOut: [] },
    ] } as Command);
    await idle();
    setTime(1);
    render(position());

    expect(screen.getByRole('button', { name: 'Previous Position keyframe' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next Position keyframe' })).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Add Position keyframe at playhead' }));
    await idle();
    const view = await docView();
    const at1 = (p: string): boolean =>
      (view.getTrackKeyframes(A, p) ?? []).some((k) => Math.abs(k.t - 1) < 1e-4);
    expect(at1('x')).toBe(true);
    expect(at1('y')).toBe(true);
  });

  it('Linked writes both members from either field, and the toggle reports its state', async () => {
    const onToggle = jest.fn();
    render(
      <MultiPropertyPairRow
        nodeId={A}
        label="Scale"
        props={[spec('scaleX', 'W'), spec('scaleY', 'H')]}
        linked={{ value: true, onToggle, label: 'Scale dimensions' }}
      />,
    );
    const link = screen.getByRole('button', { name: 'Unlink Scale dimensions' });
    expect(link).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(link);
    expect(onToggle).toHaveBeenCalledTimes(1);

    const w = screen.getByRole('spinbutton', { name: 'Scale X' });
    fireEvent.keyDown(w, { key: 'Enter' });
    const input = w.querySelector('input')!;
    fireEvent.change(input, { target: { value: '200' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await idle();
    expect(await staticProp(A, 'scaleX')).toBeCloseTo((await staticProp(A, 'scaleY'))!);
    expect(await staticProp(A, 'scaleX')).not.toBe(1);
  });
});

describe('menus and expressions stay per property', () => {
  it('right-click on a field opens THAT property’s menu', async () => {
    render(position());
    const y = screen.getByRole('spinbutton', { name: 'Position Y' });
    fireEvent.contextMenu(y);
    const { open, items } = useContextMenuStore.getState();
    expect(open).toBe(true);
    expect(items.map((i) => String(i.label))).toContain('Reset Position Y');
    expect(items.map((i) => String(i.label))).not.toContain('Reset Position X');
  });

  it('right-click on the label lists every member by name', async () => {
    render(position());
    fireEvent.contextMenu(screen.getByText('Position'));
    expect(useContextMenuStore.getState().items.map((i) => String(i.label))).toEqual(['Position X', 'Position Y']);
  });

  it('an Edit Expression request for one member opens that member under the row', async () => {
    // B4: the row reads the document mirror, and the API has one expression
    // per PROPERTY (Position), reported from its lead member — so the fixture
    // puts it on the property, not on Y alone.
    await h.run({ type: 'setExpression', prop: { layer: A, path: 'transform/position' }, source: 'value', enabled: true } as Command);
    await idle();
    render(position());
    const mark = screen.getByRole('button', { name: /Position expressions/ });
    expect(mark).toHaveAttribute('aria-pressed', 'false');
    act(() => { requestExpressionEditor({ nodeId: A, prop: 'y' }); });
    expect(screen.getByRole('button', { name: /Position expressions/ })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('hook stability', () => {
  it('gaining and losing a third field (a layer turning 3D) does not change the hook count', async () => {
    const view = render(position());
    expect(() => view.rerender(position([A], [spec('x', 'X'), spec('y', 'Y'), spec('z', 'Z')]))).not.toThrow();
    expect(screen.getByRole('spinbutton', { name: 'Position Z' })).toBeInTheDocument();
    expect(() => view.rerender(position())).not.toThrow();
    expect(screen.queryByRole('spinbutton', { name: 'Position Z' })).toBeNull();
  });
});
