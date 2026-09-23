/**
 * MultiPropertyPairRow — `Position [X][Y]` on one row, without losing what the
 * two separate rows could do.
 *
 * The risk of merging two rows is quiet capability loss: a mixed field that no
 * longer offsets per layer, a group stopwatch that seeds Y from X's reader, a
 * right-click that opens the wrong property's menu, a Z field appearing that
 * changes the hook count. Each of those is pinned here through the real
 * multi-selection seam and the real animation engine.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { getEventBus } from '@core/events/EventBus';
import { defaultAnimation } from '@motion/animation';
import { setCommandSystem, CommandSystem, getCommandSystem } from '@core/commands/CommandSystem';
import { staticOrDefaultValue } from '@core/inspector/propertyValue';
import type { PropertyAccess } from '@core/inspector/multiSelection';
import { requestExpressionEditor } from '@core/animation/expressionCommands';
import { useContextMenuStore, closeContextMenu } from '@stores/contextMenuStore';
import { useProjectStore } from '@stores/projectStore';
import { engineIdle } from '@core/engine/engineInstance';
import { InspectorSelectionProvider } from './inspectorSelection';
import { MultiPropertyPairRow, type PairFieldSpec } from './MultiPropertyPairRow';
import type { SceneNode } from '@core/types';

const A = 'pair_a';
const B = 'pair_b';

beforeAll(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  defaultAnimation.setChangeListener((nodeId) => getEventBus().emit('AnimationChanged', { nodeId }));
});

/** The composition root the layers live in (the engine addresses LAYERS: nodes inside a comp). */
const ROOT = 'pair_root';

function addNode(id: string, props: Record<string, number>): void {
  if (!defaultSceneGraph.getNode(ROOT)) {
    defaultSceneGraph.addNode({
      id: ROOT, name: 'Comp', parent: null, children: [], visible: true, locked: false,
      transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [],
    } as unknown as SceneNode);
  }
  defaultSceneGraph.addChild(ROOT, {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 0, y: 0, scaleX: 1, scaleY: 1, ...props } },
    ],
  } as unknown as SceneNode);
}

/** Per-prop readers, shaped like TransformSection's `accessFor`. */
const readers = new Map<string, PropertyAccess>();
const reader = (prop: string): PropertyAccess => {
  let a = readers.get(prop);
  if (!a) {
    a = { read: (id) => (defaultSceneGraph.getNode(id) ? staticOrDefaultValue(id, prop) : undefined) };
    readers.set(prop, a);
  }
  return a;
};

const spec = (prop: string, prefix: string, extra: Partial<PairFieldSpec> = {}): PairFieldSpec =>
  ({ prop, prefix, access: reader(prop), ...extra });

const staticProp = (id: string, prop: string): unknown =>
  defaultSceneGraph.getNode(id)?.components.find((c) => c.type === 'Transform')?.props[prop];

/** Inspector writes are engine commands (B3): asynchronous. */
const idle = async (): Promise<void> => { await act(async () => { await engineIdle(); }); };

const setTime = (t: number): void => {
  act(() => { useProjectStore.getState().actions.setTime(t, Math.round(t * 30)); });
};

beforeEach(() => {
  defaultAnimation.clear();
  for (const id of [A, B]) if (defaultSceneGraph.getNode(id)) defaultSceneGraph.removeNode(id);
  addNode(A, { x: 5, y: 7 });
  addNode(B, { x: 15, y: 7 });
  setTime(0);
  closeContextMenu();
});

afterEach(cleanup);

const position = (ids: string[] = [A], props: PairFieldSpec[] = [spec('x', 'X'), spec('y', 'Y')]): JSX.Element => (
  <InspectorSelectionProvider nodeIds={ids}>
    <MultiPropertyPairRow nodeId={ids[0]!} label="Position" props={props} />
  </InspectorSelectionProvider>
);

describe('one row, every field a full field', () => {
  it('draws one labelled row with a named, prefixed field per property and ONE group stopwatch', () => {
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

    const before = getCommandSystem().getHistory().getEntries().length;
    fireEvent.keyDown(x, { key: 'ArrowUp' });
    await idle();
    expect(staticProp(A, 'x')).toBe(6);
    expect(staticProp(B, 'x')).toBe(16);
    expect(getCommandSystem().getHistory().getEntries().length - before).toBeLessThanOrEqual(1);
  });

  it('each field honours its OWN display unit', () => {
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
    expect(defaultAnimation.isAnimated(A, 'x')).toBe(true);
    expect(defaultAnimation.isAnimated(A, 'y')).toBe(true);
    expect(defaultAnimation.sample(A, 'x', 0)).toBeCloseTo(5);
    expect(defaultAnimation.sample(A, 'y', 0)).toBeCloseTo(7);
  });

  it('the merged navigator steps to the nearest key of ANY member, and the diamond keys all of them', async () => {
    defaultAnimation.setKeyframe(A, 'x', 0, 5);
    defaultAnimation.setKeyframe(A, 'y', 0, 7);
    defaultAnimation.setKeyframe(A, 'y', 2, 70);
    setTime(1);
    render(position());

    expect(screen.getByRole('button', { name: 'Previous Position keyframe' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next Position keyframe' })).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Add Position keyframe at playhead' }));
    await idle();
    const at1 = (p: string): boolean =>
      (defaultAnimation.getTrackKeyframes(A, p) ?? []).some((k) => Math.abs(k.t - 1) < 1e-4);
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
    expect(staticProp(A, 'scaleX')).toBeCloseTo(staticProp(A, 'scaleY') as number);
    expect(staticProp(A, 'scaleX')).not.toBe(1);
  });
});

describe('menus and expressions stay per property', () => {
  it('right-click on a field opens THAT property’s menu', () => {
    render(position());
    const y = screen.getByRole('spinbutton', { name: 'Position Y' });
    fireEvent.contextMenu(y);
    const { open, items } = useContextMenuStore.getState();
    expect(open).toBe(true);
    expect(items.map((i) => String(i.label))).toContain('Reset Position Y');
    expect(items.map((i) => String(i.label))).not.toContain('Reset Position X');
  });

  it('right-click on the label lists every member by name', () => {
    render(position());
    fireEvent.contextMenu(screen.getByText('Position'));
    expect(useContextMenuStore.getState().items.map((i) => String(i.label))).toEqual(['Position X', 'Position Y']);
  });

  it('an Edit Expression request for one member opens that member under the row', () => {
    // B4: the row reads the document mirror, and the API has one expression
    // per PROPERTY (Position), reported from its lead member — so the fixture
    // puts it on the property, not on Y alone.
    defaultAnimation.setExpression(A, 'x', 'value');
    defaultAnimation.setExpression(A, 'y', 'value');
    render(position());
    const mark = screen.getByRole('button', { name: /Position expressions/ });
    expect(mark).toHaveAttribute('aria-pressed', 'false');
    act(() => { requestExpressionEditor({ nodeId: A, prop: 'y' }); });
    expect(screen.getByRole('button', { name: /Position expressions/ })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('hook stability', () => {
  it('gaining and losing a third field (a layer turning 3D) does not change the hook count', () => {
    const view = render(position());
    expect(() => view.rerender(position([A], [spec('x', 'X'), spec('y', 'Y'), spec('z', 'Z')]))).not.toThrow();
    expect(screen.getByRole('spinbutton', { name: 'Position Z' })).toBeInTheDocument();
    expect(() => view.rerender(position())).not.toThrow();
    expect(screen.queryByRole('spinbutton', { name: 'Position Z' })).toBeNull();
  });
});
