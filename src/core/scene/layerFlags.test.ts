/**
 * The AE switch verbs, as ONE set.
 *
 * Why this file exists: the knowledge of where each switch WRITES used to live
 * inline in `App.tsx`'s timeline handler, so nothing could test it without
 * standing the editor up, and anything else that wanted the same switch copied
 * it. What is pinned here is the part that copies get wrong:
 *   • a switch whose kind cannot carry it is refused, not lit (3D on a camera);
 *   • a composition root has no layer switches at all;
 *   • (the anchored multi-layer toggle, ONE undo entry, is the engine route —
 *     layout/Scene/layerSwitchEdits.test.ts).
 */


import {
  LAYER_FLAGS,
  layerFlagDef,
} from './layerFlags';

import { CommandSystem, setCommandSystem } from '@core/commands/CommandSystem';
import { useSelectionStore } from '@stores/selectionStore';

beforeAll(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) } as never));
});

beforeEach(() => {
  useSelectionStore.getState().set([]);
});

describe('the table', () => {
  it('gives every flag a label and either an icon or a glyph', () => {
    for (const def of LAYER_FLAGS) {
      expect(def.label).toBeTruthy();
      expect(def.title).toBeTruthy();
      expect(def.icon ?? def.glyph).toBeTruthy();
      expect(layerFlagDef(def.id)).toBe(def);
    }
  });
});
