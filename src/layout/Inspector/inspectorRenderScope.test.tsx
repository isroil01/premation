/**
 * The render-scope guarantee: **a scrub re-renders the rows it changed, and
 * nothing else.**
 *
 * The Properties panel used to subscribe to `useSceneRevision((s) => s.rev)`
 * — ONE counter for the whole scene — at the panel root and again in every
 * section. Dragging a value on one layer therefore re-rendered every section
 * drawn for every other selected layer, plus the shell, on every pointer
 * event: with eight layers selected and a Transform section apiece that is
 * dozens of React trees per mouse move, all of them producing identical
 * output.
 *
 * The fix has three parts and this file pins all three, because any one of
 * them silently undoes the other two:
 *
 *   1. `nodeRevision` — a counter PER NODE, fed from the events that already
 *      name the node they touched, so a write to A does not advance B;
 *   2. `useNodeRevision` / `useNodesRevision` — the subscription a row uses,
 *      which must wake for its own layer and stay asleep for anyone else's;
 *   3. `React.memo` on the row and the sections, so a parent re-render with
 *      unchanged props does not re-render the subtree anyway.
 *
 * The counters below are real React render counts, driven by a real property
 * write through the real multi-selection seam — not by poking the store.
 */

import { memo, useRef } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { getEventBus } from '@core/events/EventBus';
import { defaultAnimation } from '@motion/animation';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import { useNodeRevision, useNodesRevision } from '@hooks/useNodeRevision';
import { nodeRevision } from '@core/inspector/nodeRevision';
import { applyAbsolute } from '@core/inspector/multiSelection';
import { MultiPropertyRow } from './MultiPropertyRow';
import { TransformSection } from './TransformSection';
import { AppearanceSection } from './AppearanceSection';
import { SelectionHeader } from './SelectionHeader';
import type { SceneNode } from '@core/types';

const A = 'rs_a';
const B = 'rs_b';

beforeAll(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  defaultAnimation.setChangeListener((nodeId) => getEventBus().emit('AnimationChanged', { nodeId }));
});

function addNode(id: string): void {
  defaultSceneGraph.addNode({
    id,
    name: id,
    parent: null,
    children: [],
    visible: true,
    locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      {
        id: `${id}_t`,
        type: 'Transform',
        props: { [SCENE_KIND_PROP]: 'shape', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 100 },
      },
    ],
  } as unknown as SceneNode);
}

beforeEach(() => {
  for (const id of [A, B]) defaultSceneGraph.removeNode?.(id);
  addNode(A);
  addNode(B);
});

afterEach(cleanup);

afterAll(() => {
  for (const id of [A, B]) defaultSceneGraph.removeNode?.(id);
});

/**
 * A stand-in for one inspector row: it subscribes exactly as the real row
 * does and counts how many times React rendered it.
 */
const counts = new Map<string, number>();

const Row = memo(function Row({ nodeId }: { nodeId: string }): JSX.Element {
  useNodeRevision(nodeId);
  const n = useRef(0);
  n.current += 1;
  counts.set(nodeId, n.current);
  return <span data-testid={`row-${nodeId}`} />;
});

const SelectionRow = memo(function SelectionRow({ ids, name }: { ids: string[]; name: string }): JSX.Element {
  useNodesRevision(ids);
  const n = useRef(0);
  n.current += 1;
  counts.set(name, n.current);
  return <span data-testid={`sel-${name}`} />;
});

/** A property write through the seam the ValueField and the scrub both use. */
function scrub(nodeId: string, value: number): void {
  act(() => {
    applyAbsolute([nodeId], 'x', value, { compTime: 0, mergeKey: `scrub:${nodeId}`, label: 'Set X' });
  });
}

describe('per-node revision', () => {
  it('advances only the written node`s counter', () => {
    const beforeA = nodeRevision(A);
    const beforeB = nodeRevision(B);
    // A live subscriber is what arms the bus wiring, so mount one first.
    render(<Row nodeId={A} />);
    scrub(A, 25);
    expect(nodeRevision(A)).toBeGreaterThan(beforeA);
    expect(nodeRevision(B)).toBe(beforeB);
  });
});

describe('a scrub on one layer', () => {
  it('re-renders that layer`s row and leaves the other row alone', () => {
    counts.clear();
    render(
      <>
        <Row nodeId={A} />
        <Row nodeId={B} />
      </>,
    );
    expect(counts.get(A)).toBe(1);
    expect(counts.get(B)).toBe(1);

    scrub(A, 10);
    expect(counts.get(A)).toBe(2);
    expect(counts.get(B)).toBe(1); // ← the whole point of the change

    scrub(A, 20);
    scrub(A, 30);
    expect(counts.get(A)).toBe(4);
    expect(counts.get(B)).toBe(1);
  });

  it('costs one render per write, not one per subscriber — a drag is not quadratic', () => {
    counts.clear();
    render(
      <>
        <Row nodeId={A} />
        <Row nodeId={B} />
      </>,
    );
    for (let i = 0; i < 10; i += 1) scrub(A, i);
    expect(counts.get(A)).toBe(11); // 1 mount + 10 writes
    expect(counts.get(B)).toBe(1);
  });

  it('wakes a MULTI-node subscriber only when one of ITS nodes changes', () => {
    counts.clear();
    render(
      <>
        <SelectionRow ids={[A]} name="just-a" />
        <SelectionRow ids={[A, B]} name="both" />
        <SelectionRow ids={[B]} name="just-b" />
      </>,
    );
    scrub(A, 5);
    expect(counts.get('just-a')).toBe(2);
    expect(counts.get('both')).toBe(2);
    expect(counts.get('just-b')).toBe(1);
  });

  it('unsubscribes on unmount — a removed row cannot be re-rendered', () => {
    counts.clear();
    const view = render(<Row nodeId={A} />);
    scrub(A, 1);
    const afterOne = counts.get(A);
    view.unmount();
    scrub(A, 2);
    expect(counts.get(A)).toBe(afterOne);
  });
});

/*
 * `React.memo` is the third leg. Without it the subscription work above is
 * wasted: the panel shell re-renders for its own reasons (a selection change,
 * a search keystroke) and hands every section identical props, and an unmemoized
 * section re-renders anyway. These are identity assertions rather than render
 * counts because that is exactly what React checks at the boundary.
 */
describe('the rows and sections are memoized', () => {
  const MEMO = Symbol.for('react.memo');
  it.each([
    ['MultiPropertyRow', MultiPropertyRow],
    ['TransformSection', TransformSection],
    ['AppearanceSection', AppearanceSection],
    ['SelectionHeader', SelectionHeader],
  ])('%s', (_name, component) => {
    expect((component as unknown as { $$typeof?: symbol }).$$typeof).toBe(MEMO);
  });
});
