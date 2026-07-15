import { getTimelineController } from '@core/timeline/TimelineController';
import { applyAiOps, type AIOperation } from './applyOps';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
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
    defaultAnimation.setKeyframe('node1', 'x', getTimelineController().toLayerTime('node1', 0), 100);

    const ops: AIOperation[] = [
      { op: 'set', target: 'node1', properties: { opacity: 50 }, timing: { t: 1 } },
      { op: 'move', target: 'node1', prop: 'x', timing: { t: 0, toT: 2 } },
      { op: 'easing', target: 'node1', prop: 'x', timing: { t: 2, curve: 'ease-in' } },
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

  test('applies custom bezier curves correctly', () => {
    const ops: AIOperation[] = [
      { op: 'set', target: 'node1', properties: { x: 500 }, timing: { t: 1.5, curve: 'cubic-bezier(0.25, 0.1, 0.25, 1.0)' } },
    ];

    applyAiOps('AI custom bezier', ops);

    const tracks = defaultAnimation.snapshot().tracks['node1'];
    expect(tracks?.['x']?.keyframes).toEqual([
      expect.objectContaining({ t: 1.5, value: 500, easing: 'bezier', bezier: [0.25, 0.1, 0.25, 1.0] })
    ]);
  });

  test('removes keyframes correctly', () => {
    defaultAnimation.setKeyframe('node2', 'y', getTimelineController().toLayerTime('node2', 1), 200);
    applyAiOps('remove op', [
      { op: 'remove', target: 'node2', prop: 'y', timing: { t: 1 } }
    ]);

    const tracks = defaultAnimation.snapshot().tracks['node2'];
    expect(tracks?.['y']?.keyframes ?? []).toHaveLength(0);
  });

  test('does nothing if ops array is empty', () => {
    applyAiOps('empty', []);
    const history = getCommandSystem().getHistory().getEntries();
    expect(history.length).toBe(0);
  });

  test('applies structural operations (create, delete, reparent) correctly', () => {
    // Start with a root and a layer
    const rootId = defaultSceneGraph.getRoots()[0]?.id ?? 'comp_root';
    defaultSceneGraph.addChild(rootId, { id: 'parent1', name: 'Parent', parent: null, children: [], transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } }, visible: true, locked: false, components: [] });
    defaultSceneGraph.addChild(rootId, { id: 'someOtherLayer', name: 'To Delete', parent: null, children: [], transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } }, visible: true, locked: false, components: [] });

    const ops: AIOperation[] = [
      { op: 'create_layer', target: 'newShape', properties: { kind: 'shape', name: 'My Shape' } },
      { op: 'reparent_layer', target: 'newShape', properties: { parentId: 'parent1' } },
      { op: 'delete_layer', target: 'someOtherLayer' }
    ];

    applyAiOps('Structural test', ops);

    const parentNode = defaultSceneGraph.getNode('parent1');
    expect(parentNode).toBeDefined();
    expect(parentNode!.children).toContain('newShape');

    const newNode = defaultSceneGraph.getNode('newShape');
    expect(newNode).toBeDefined();
    expect(newNode!.name).toBe('My Shape');
    expect(newNode!.parent).toBe('parent1');

    // Test undo
    getCommandSystem().getHistory().undo();
    expect(defaultSceneGraph.getNode('newShape')).toBeUndefined();
    expect(defaultSceneGraph.getNode('parent1')!.children).not.toContain('newShape');
    expect(defaultSceneGraph.getNode('someOtherLayer')).toBeDefined(); // It was deleted, now restored

    // Test redo
    getCommandSystem().getHistory().redo();
    expect(defaultSceneGraph.getNode('newShape')).toBeDefined();
    expect(defaultSceneGraph.getNode('someOtherLayer')).toBeUndefined();
  });
});
