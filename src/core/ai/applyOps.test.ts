import { applyAiOps, type KeyframeOp } from './applyOps';
import { defaultAnimation } from '@motion/animation';
import { getCommandSystem, setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';

describe('applyAiOps', () => {
  beforeAll(() => {
    const dummyServices: any = {
      undo: { push: () => {}, undo: () => {}, redo: () => {}, canUndo: () => false, canRedo: () => false },
      selection: { get: () => [], set: () => {}, clear: () => {} },
      panels: { open: () => {}, close: () => {}, toggle: () => {}, isOpen: () => false },
      workspace: { setActive: () => {}, getActive: () => '' },
      get: () => undefined,
    };
    setCommandSystem(new CommandSystem({ services: dummyServices, getState: () => ({}) }));
  });

  beforeEach(() => {
    // Reset animation engine and history before each test
    defaultAnimation.clear();
    getCommandSystem().getHistory().clear();
  });

  test('applies a sequence of operations and creates a single undoable command', () => {
    // Initial state: set a keyframe manually to have something to move/remove
    defaultAnimation.setKeyframe('node1', 'x', 0, 100);

    const ops: KeyframeOp[] = [
      { op: 'set', nodeId: 'node1', prop: 'opacity', t: 1, value: 50 },
      { op: 'move', nodeId: 'node1', prop: 'x', t: 0, toT: 2 },
      { op: 'easing', nodeId: 'node1', prop: 'x', t: 2, easing: 'easeIn' },
    ];

    applyAiOps('AI test', ops);

    // Verify effects on animation engine
    const tracks = defaultAnimation.snapshot().tracks['node1'];
    expect(tracks?.['opacity']?.keyframes).toEqual([
      expect.objectContaining({ t: 1, value: 50 })
    ]);
    expect(tracks?.['x']?.keyframes).toEqual([
      expect.objectContaining({ t: 2, value: 100, easing: 'easeIn' })
    ]);

    // Verify exactly one command was recorded on the undo stack
    const history = getCommandSystem().getHistory().getEntries();
    expect(history.length).toBe(1);
    expect(history[0]?.label).toBe('AI test');
  });

  test('removes keyframes correctly', () => {
    defaultAnimation.setKeyframe('node2', 'y', 1, 200);
    applyAiOps('remove op', [
      { op: 'remove', nodeId: 'node2', prop: 'y', t: 1 }
    ]);
    
    const tracks = defaultAnimation.snapshot().tracks['node2'];
    expect(tracks?.['y']?.keyframes ?? []).toHaveLength(0);
  });

  test('does nothing if ops array is empty', () => {
    applyAiOps('empty', []);
    const history = getCommandSystem().getHistory().getEntries();
    expect(history.length).toBe(0);
  });

  test('handles missing optional fields gracefully', () => {
    // E.g. 'move' without 'toT' or 'set' without 'value' should just be ignored or skipped
    // based on the implementation of applyAiOps.
    applyAiOps('invalid', [
      { op: 'set', nodeId: 'node3', prop: 'x', t: 0 }, // no value
      { op: 'move', nodeId: 'node3', prop: 'y', t: 0 }, // no toT
      { op: 'easing', nodeId: 'node3', prop: 'z', t: 0 } // no easing
    ]);
    
    // Nothing should have been authored
    expect(Object.keys(defaultAnimation.snapshot().tracks)).toHaveLength(0);
  });
});
