/**
 * UI component presets — each insert should drop an editable GROUP of primitive
 * layers under the composition root, so the user can move/restyle/keyframe it.
 */

import { UI_COMPONENT_PRESETS } from './uiComponents';
import defaultSceneGraph from './DefaultSceneGraph';
import { useSelectionStore } from '@stores/selectionStore';
import type { SceneNode } from '@core/types';

function seedRoot(): void {
  defaultSceneGraph.clear();
  defaultSceneGraph.addNode({
    id: 'comp_root', name: 'Comp', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'comp_root_m', type: 'group', props: { __kind: 'group' } }],
  } as unknown as SceneNode);
}

describe('UI component presets', () => {
  beforeEach(seedRoot);

  it('exposes the expected preset set', () => {
    expect(UI_COMPONENT_PRESETS.map((p) => p.id)).toEqual(
      ['browser', 'phone', 'card', 'button', 'chat', 'notification', 'chart',
       'stat', 'avatar', 'toggle', 'input', 'progress', 'tabs', 'tablerow', 'cursor'],
    );
  });

  it.each(UI_COMPONENT_PRESETS.map((p) => [p.id, p] as const))(
    'inserts "%s" as a selected group of editable layers',
    (_id, preset) => {
      const before = defaultSceneGraph.size;
      const groupId = preset.insert();
      // It grew the scene by several nodes (group + children).
      expect(defaultSceneGraph.size).toBeGreaterThan(before + 2);
      // The group is parented to the comp root and holds children.
      const g = defaultSceneGraph.getNode(groupId);
      expect(g).toBeDefined();
      expect(g!.parent).toBe('comp_root');
      expect(defaultSceneGraph.getChildren(groupId).length).toBeGreaterThanOrEqual(2);
      // …and it's selected, ready to move/animate.
      expect(useSelectionStore.getState().ids).toContain(groupId);
    },
  );
});
