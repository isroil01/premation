/**
 * Every dock destination the panel menu offers must be a region that actually
 * renders panels.
 *
 * WHY THIS EXISTS. `PanelHeader` offered three dock targets: Left Sidebar,
 * Right Inspector, and Bottom Timeline. `layoutStore.dockPanel` accepts any
 * `RegionId` — it set `region: 'bottomTimeline'` and pushed the panel id into
 * that region's `panelOrder` without complaint. But `DockPanel` is only mounted
 * for `leftSidebar` and `rightInspector`; `EditorLayout` puts the timeline
 * ELEMENT in the bottom pane, not a dock host.
 *
 * So "Dock Bottom Timeline" moved a panel into a region nothing renders. The
 * panel vanished — and its header, the only way to dock it back, vanished with
 * it. The only recovery was Reset Layout or a panel-specific reopen command.
 *
 * The store is right to stay permissive: `bottomTimeline` is a real region with
 * real geometry. It is the MENU that must only offer reachable destinations,
 * which is what this test pins.
 *
 * IF THIS FAILS, either mount a DockPanel for the region you are offering, or
 * do not offer it.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

const LAYOUT_ROOT = resolve(__dirname, '..');

const PANEL_HEADER = resolve(LAYOUT_ROOT, 'EditorLayout/PanelHeader.tsx');
/** Every component that mounts a <DockPanel region="…">. */
const DOCK_HOSTS = [
  resolve(LAYOUT_ROOT, 'LeftSidebar/LeftSidebar.tsx'),
  resolve(LAYOUT_ROOT, 'RightInspector/RightInspector.tsx'),
];

function stripComments(src: string): string {
  // The fix left a comment naming the removed 'bottomTimeline' target, which is
  // the context a future reader needs and would otherwise trip this test.
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function matchAll(src: string, re: RegExp): string[] {
  return [...src.matchAll(re)].map((m) => m[1]!);
}

describe('panel dock destinations are regions that render panels', () => {
  const offered = new Set(
    matchAll(stripComments(readFileSync(PANEL_HEADER, 'utf8')), /handleDock\(\s*['"]([A-Za-z]+)['"]\s*\)/g),
  );
  const renderable = new Set(
    DOCK_HOSTS.flatMap((f) => matchAll(readFileSync(f, 'utf8'), /<DockPanel[^>]*\bregion=["']([A-Za-z]+)["']/g)),
  );

  it('finds the menu targets and the dock hosts it is comparing', () => {
    // Guards the guard: two empty sets satisfy a subset check vacuously.
    expect(offered.size).toBeGreaterThan(0);
    expect(renderable.size).toBeGreaterThan(0);
  });

  it('offers no dock target that has no DockPanel host', () => {
    const unreachable = [...offered].filter((r) => !renderable.has(r));
    expect(unreachable).toEqual([]);
  });
});
