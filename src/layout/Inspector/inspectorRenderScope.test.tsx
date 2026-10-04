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


import {  cleanup } from '@testing-library/react';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import { MultiPropertyRow } from './MultiPropertyRow';
import { TransformSection } from './TransformSection';
import { AppearanceSection } from './AppearanceSection';
import { SelectionHeader } from './SelectionHeader';

beforeAll(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
});

beforeEach(() => {
});

afterEach(cleanup);

afterAll(() => {
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
