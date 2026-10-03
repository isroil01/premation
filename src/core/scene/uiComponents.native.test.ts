/**
 * UI component presets — each builds an editable GROUP of primitive layers at
 * the top of the composition (the app pastes it as one entry and selects the
 * group), so the user can move/restyle/keyframe it — laid into a fragment
 * the engine pastes.
 */

import { UI_COMPONENT_PRESETS } from './uiComponents';
import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import type { Command } from '@motion/engine-api';
import { docView } from '@core/engine/__testHelpers__/docView';
import { readNodeKind } from './sceneDerive';
import { FragmentBuilder } from '@/engine-client/fragmentBuilder';
import { insertFrame } from '@/engine-client/insertFragment';

let h: Harness;
beforeEach(async () => {
  h = await setupAppEngine();
});
afterEach(async () => {
  await h.dispose();
});

describe('UI component presets', () => {
  it('exposes the expected preset set', async () => {
    expect(UI_COMPONENT_PRESETS.map((p) => p.id)).toEqual(
      ['code-editor', 'browser', 'phone', 'card', 'button', 'chat', 'notification', 'chart',
       'stat', 'avatar', 'toggle', 'input', 'progress', 'tabs', 'tablerow', 'cursor'],
    );
  });

  it.each(UI_COMPONENT_PRESETS.map((p) => [p.id, p] as const))(
    'builds "%s" as one top-level group of editable layers the engine pastes',
    async (_id, preset) => {
      const b = new FragmentBuilder({ idPrefix: 'ui' });
      const groupId = preset.build(b, insertFrame('comp_root'));
      const built = b.build()!;
      expect(built.tops).toEqual([groupId]);
      expect(b.row(groupId).children.length).toBeGreaterThanOrEqual(2);
      expect(built.layers.length).toBeGreaterThanOrEqual(3);

      const r = await h.client.execute({ type: 'pasteLayers', comp: 'comp_root', fragment: built.fragment, index: 0 } as Command);
      expect(r.ok ? 'ok' : r.error.message).toBe('ok');
      const ids = r.ok ? ((r.value as { layers?: string[] }).layers ?? []) : [];
      expect(ids).toHaveLength(built.layers.length);
      // One unparented group; every other layer sits under it.
      const v = await docView();
      const roots = ids.filter((id) => !ids.includes(v.getNode(id)?.parent ?? ''));
      expect(roots).toHaveLength(1);
      expect(readNodeKind(v.getNode(roots[0]!)!)).toBe('group');
    },
  );
});
