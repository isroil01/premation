/**
 * Library inserts as engine clients — motion-graphics items, cursors and
 * animation presets laid into a FragmentBuilder (keys from the playhead) build
 * the SAME fragment as their legacy builders run off-document over the page
 * replica (offDocument.ts buildLayerFragment): rows, keys, expressions,
 * text.source data keys, motion-blur switches and the item's clip window.
 */

import { buildLayerFragment } from '@core/engine/offDocument';
import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { MOGRAPH_ITEMS, buildMographFragment } from '@core/library/mographLibrary';
import { buildMographItem } from '@core/library/mographInsertLegacy';
import { CURSOR_ITEMS, buildCursorItem } from '@core/library/cursorLibrary';
import { ANIM_PRESETS, buildAnimPresetFragment } from '@core/template/animPresets';
import { insertAnimPreset } from '@core/template/animPresetsLegacy';
import { legacyFrame, legacySink } from '@core/scene/sceneInsert';
import { useCompositionStore } from '@stores/compositionStore';
import { useWorkspaceStore } from '@stores/projectStore';
import { FragmentBuilder } from './fragmentBuilder';
import { insertFrame } from './insertFragment';
import { normalizeFragment } from './__testHelpers__/fragmentParity';

let h: Harness & { engine: LocalEngine };
beforeEach(async () => {
  h = await setupAppEngine();
});
afterEach(async () => {
  await h.dispose();
});

function frames(): number {
  const c = useCompositionStore.getState().comp();
  return Math.round(c.durationSeconds * c.fps);
}

/** The playhead the legacy builders read (the active tab's time). */
function setPlayhead(t: number): void {
  const ws = useWorkspaceStore.getState();
  const tab = ws.activeTabId;
  if (!tab) throw new Error('no active tab');
  useWorkspaceStore.setState({ tabs: { ...ws.tabs, [tab]: { ...ws.tabs[tab]!, time: t } } });
}

function expectParity(legacy: () => unknown, mine: (b: FragmentBuilder) => unknown): void {
  const old = buildLayerFragment('comp_root', legacy);
  const b = new FragmentBuilder({ idPrefix: 'lib' });
  mine(b);
  const built = b.build();
  expect(old).not.toBeNull();
  expect(built).not.toBeNull();
  expect(normalizeFragment(built!.fragment, frames())).toEqual(normalizeFragment(old!.fragment, frames()));
}

describe('library items as engine clients', () => {
  it.each(MOGRAPH_ITEMS.map((m) => [m.id]))('motion graphic %s (at the playhead)', (id) => {
    setPlayhead(1.5);
    expectParity(() => buildMographItem(id, 400, 300), (b) => buildMographFragment(b, insertFrame('comp_root'), id, 1.5, 400, 300));
  });

  it.each(CURSOR_ITEMS.map((c) => [c.id]))('cursor %s', (id) => {
    expectParity(
      () => buildCursorItem(legacySink(), legacyFrame(), id, 0.5, 200, 200),
      (b) => buildCursorItem(b, insertFrame('comp_root'), id, 0.5, 200, 200),
    );
  });

  it.each(ANIM_PRESETS.map((p) => [p.id]))('animation preset %s (at the playhead)', (id) => {
    setPlayhead(0.5);
    expectParity(() => insertAnimPreset(id, 300, 300), (b) => buildAnimPresetFragment(b, insertFrame('comp_root'), id, 0.5, 300, 300));
  });
});
