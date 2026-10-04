/**
 * Library inserts as engine clients — motion-graphics items, cursors and
 * animation presets laid into a FragmentBuilder (keys from the playhead) build
 * fragments the engine takes: each pastes as one undoable entry with every
 * built layer. (The parity with the legacy off-document builders went with
 * the page replica, block 3.)
 */

import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { MOGRAPH_ITEMS, buildMographFragment } from '@core/library/mographLibrary';
import { CURSOR_ITEMS, buildCursorItem } from '@core/library/cursorLibrary';
import { ANIM_PRESETS, buildAnimPresetFragment } from '@core/template/animPresets';
import { useWorkspaceStore } from '@stores/projectStore';
import { FragmentBuilder } from './fragmentBuilder';
import { insertFrame, type InsertFrame } from './insertFragment';
import type { Command } from '@motion/engine-api';

let h: Harness;
beforeEach(async () => {
  h = await setupAppEngine();
});
afterEach(async () => {
  await h.dispose();
});

/** The playhead the legacy builders read (the active tab's time). */
function setPlayhead(t: number): void {
  const ws = useWorkspaceStore.getState();
  const tab = ws.activeTabId;
  if (!tab) throw new Error('no active tab');
  useWorkspaceStore.setState({ tabs: { ...ws.tabs, [tab]: { ...ws.tabs[tab]!, time: t } } });
}

/**
 * The builder's fragment is one the ENGINE takes: it pastes into the
 * composition as one undoable entry, creating every built layer.
 */
async function expectPastes(mine: (b: FragmentBuilder, f: InsertFrame) => unknown): Promise<void> {
  const b = new FragmentBuilder({ idPrefix: 't' });
  mine(b, insertFrame('comp_root'));
  const built = b.build();
  expect(built).not.toBeNull();
  const before = await h.doc();
  const r = await h.client.execute({ type: 'pasteLayers', comp: 'comp_root', fragment: built!.fragment } as Command);
  expect(r.ok ? 'ok' : r.error.message).toBe('ok');
  const layers = r.ok ? ((r.value as { layers?: string[] }).layers ?? []) : [];
  expect(layers).toHaveLength(built!.scratchIds.length);
  await h.run({ type: 'undo' });
  expect(await h.doc()).toBe(before);
}

describe('library items as engine clients', () => {
  it.each(MOGRAPH_ITEMS.map((m) => [m.id]))('motion graphic %s (at the playhead)', async (id) => {
    setPlayhead(1.5);
    await expectPastes((b) => buildMographFragment(b, insertFrame('comp_root'), id, 1.5, 400, 300));
  });

  it.each(CURSOR_ITEMS.map((c) => [c.id]))('cursor %s', async (id) => {
    await expectPastes((b) => buildCursorItem(b, insertFrame('comp_root'), id, 0.5, 200, 200), );
  });

  it.each(ANIM_PRESETS.map((p) => [p.id]))('animation preset %s (at the playhead)', async (id) => {
    setPlayhead(0.5);
    await expectPastes((b) => buildAnimPresetFragment(b, insertFrame('comp_root'), id, 0.5, 300, 300));
  });
});
