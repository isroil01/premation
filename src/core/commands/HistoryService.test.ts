import { HistoryService } from './HistoryService';
import type { Command, CommandContext } from './Command';
import { asCommandId } from '@app-types/common';

/** A minimal context — real commands used here ignore it, but it must exist. */
const ctx: CommandContext = {
  state: {},
  services: {
    undo: { push: () => {}, undo: () => {}, redo: () => {}, canUndo: () => false, canRedo: () => false },
    selection: { get: () => [], set: () => {}, clear: () => {} },
    panels: { open: () => {}, close: () => {}, toggle: () => {}, isOpen: () => false },
    workspace: { setActive: () => {}, getActive: () => '' },
    get: () => undefined,
  },
};

function counterCommand(log: string[]): Command {
  return {
    id: asCommandId('test.counter'),
    label: 'Counter',
    execute: () => { log.push('execute'); },
    undo: () => { log.push('undo'); },
  };
}

describe('HistoryService', () => {
  test('peek returns the top of the undo stack without popping', () => {
    const h = new HistoryService(500, () => ctx);
    expect(h.peek()).toBeUndefined();
    const cmd = counterCommand([]);
    h.push(cmd);
    expect(h.peek()).toBe(cmd);
    expect(h.canUndo()).toBe(true);
  });

  test('undo/redo re-run the command via the injected context builder', () => {
    const log: string[] = [];
    let built = 0;
    const h = new HistoryService(500, (c) => { built++; expect(c).toBeDefined(); return ctx; });

    h.push(counterCommand(log));
    h.undo();
    expect(log).toEqual(['undo']);
    expect(h.canRedo()).toBe(true);

    h.redo();
    expect(log).toEqual(['undo', 'execute']);
    expect(built).toBe(2); // one context built per undo and per redo
  });

  test('without a context builder, undo throws a clear error (misuse guard)', () => {
    const h = new HistoryService(); // no builder
    h.push(counterCommand([]));
    expect(() => h.undo()).toThrow(/context builder/);
  });

  test('a fresh push clears the redo stack', () => {
    const h = new HistoryService(500, () => ctx);
    h.push(counterCommand([]));
    h.undo();
    expect(h.canRedo()).toBe(true);
    h.push(counterCommand([]));
    expect(h.canRedo()).toBe(false);
  });
});
