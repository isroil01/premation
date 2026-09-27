/**
 * History: undo / redo / jump without an engine route step the history
 * service directly; `resetHistory` empties it (a load boundary). With an
 * engine, `setHistoryRoute` sends them as engine requests (ownerMode.test.ts,
 * commandLog.test.ts cover that route).
 */

import { performUndo, performRedo, performJumpTo, resetHistory, setHistoryRoute } from './historyStore';
import { CommandSystem, getCommandSystem, setCommandSystem } from '@core/commands/CommandSystem';

let value = 0;
const step = (label: string, to: number): void => {
  const from = value;
  getCommandSystem().getHistory().push({ label, execute: () => { value = to; }, undo: () => { value = from; } });
  value = to;
};

beforeEach(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  setHistoryRoute(null);
  value = 0;
});

describe('without an engine route', () => {
  it('undo and redo step the history service', async () => {
    step('one', 1);
    step('two', 2);
    await performUndo();
    expect(value).toBe(1);
    await performRedo();
    expect(value).toBe(2);
  });

  it('jumps to an entry', async () => {
    step('one', 1);
    step('two', 2);
    step('three', 3);
    await performJumpTo(0);
    expect(value).toBe(1);
  });

  it('nothing to undo is a no-op', async () => {
    await performUndo();
    expect(value).toBe(0);
  });
});

describe('with an engine route', () => {
  it('sends the step to the route instead', async () => {
    const calls: string[] = [];
    setHistoryRoute({ step: async (dir) => { calls.push(dir); }, jump: async (p) => { calls.push(`jump ${p}`); } });
    step('one', 1);
    await performUndo();
    await performJumpTo(0);
    expect(calls).toEqual(['undo', 'jump 1']);
    expect(value).toBe(1);
  });
});

describe('resetHistory', () => {
  it('empties the stack: nothing behind a load boundary', async () => {
    step('before the load', 1);
    resetHistory();
    expect(getCommandSystem().getHistory().canUndo()).toBe(false);
    await performUndo();
    expect(value).toBe(1);
  });
});
