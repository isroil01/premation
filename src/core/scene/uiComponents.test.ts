/**
 * UI component presets — each builds an editable GROUP of primitive layers at
 * the top of the composition (the app pastes it as one entry and selects the
 * group), so the user can move/restyle/keyframe it. Laid into a fragment, a
 * preset gives the same layers as laid into the page replica off-document
 * (the build it replaced).
 */

import { UI_COMPONENT_PRESETS } from './uiComponents';
import { legacyFrame, legacySink } from './sceneInsert';
import { buildLayerFragment } from '@core/engine/offDocument';
import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { useCompositionStore } from '@stores/compositionStore';
import { FragmentBuilder } from '@/engine-client/fragmentBuilder';
import { insertFrame } from '@/engine-client/insertFragment';
import { normalizeFragment } from '@/engine-client/__testHelpers__/fragmentParity';

let h: Harness & { engine: LocalEngine };
beforeEach(async () => {
  h = await setupAppEngine();
});
afterEach(async () => {
  await h.dispose();
});

describe('UI component presets', () => {
  it('exposes the expected preset set', () => {
    expect(UI_COMPONENT_PRESETS.map((p) => p.id)).toEqual(
      ['code-editor', 'browser', 'phone', 'card', 'button', 'chat', 'notification', 'chart',
       'stat', 'avatar', 'toggle', 'input', 'progress', 'tabs', 'tablerow', 'cursor'],
    );
  });

  it.each(UI_COMPONENT_PRESETS.map((p) => [p.id, p] as const))(
    'builds "%s" as one top-level group of editable layers (same as the off-document build)',
    (_id, preset) => {
      const b = new FragmentBuilder({ idPrefix: 'ui' });
      const groupId = preset.build(b, insertFrame('comp_root'));
      const built = b.build()!;
      expect(built.tops).toEqual([groupId]);
      expect(b.row(groupId).children.length).toBeGreaterThanOrEqual(2);
      expect(built.layers.length).toBeGreaterThanOrEqual(3);

      const legacy = buildLayerFragment('comp_root', () => preset.build(legacySink(), legacyFrame()));
      const c = useCompositionStore.getState().comp();
      const frames = Math.round(c.durationSeconds * c.fps);
      expect(normalizeFragment(built.fragment, frames)).toEqual(normalizeFragment(legacy!.fragment, frames));
    },
  );
});
