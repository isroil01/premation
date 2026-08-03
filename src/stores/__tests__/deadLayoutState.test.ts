/**
 * State that no UI can write, and state no UI can read, must not come back.
 *
 * WHY THIS EXISTS. The wiring audit found six half-built features in the layout
 * and guides stores, all the same shape — a store field with only one live end:
 *
 *   floatPanel / floatingPanels / floatingBounds  — no UI floats a panel; the
 *       panel menu offers Pop Out and two dock targets, never Float. Nothing
 *       rendered `placement: 'floating'`, so the array was permanently empty
 *       and every saved workspace faithfully recorded [].
 *   setFloatingBounds / bringFloatingToFront      — zero callers, operating on
 *       a `floatingBounds` nothing ever set.
 *   workspaceLocked                               — READ by PanelHeader to hide
 *       the options button, but `setWorkspaceLocked` had no caller anywhere. A
 *       gate on a switch that did not exist.
 *   gizmo3dSnapping                               — no writer AND no reader;
 *       its only appearance outside its own definition was the guides cache key.
 *   monitorId                                     — `popoutPanel(id, monitorId)`
 *       accepted one, every caller passed undefined, nothing enumerates
 *       monitors.
 *   allowGroup                                    — declared on the panel type,
 *       never set, never read.
 *   exportWorkspaceJSON / importWorkspaceJSON     — implemented, zero callers,
 *       no UI, and advertised in the module docstring.
 *
 * Each was cheap to keep and cost nothing to run, which is exactly why they
 * survived: nothing failed. Deleting them is only half the fix — this test is
 * the other half, so re-adding one requires deciding to, rather than drifting.
 *
 * IF THIS FAILS because you are genuinely building one of these: delete its
 * line here in the same commit that wires BOTH ends. That edit is the signal
 * this test exists to produce.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

const read = (rel: string): string => readFileSync(resolve(__dirname, '../..', rel), 'utf8');

/** Symbols that must not reappear, and where they used to live. */
const BURIED: ReadonlyArray<{ symbol: string; file: string; why: string }> = [
  { symbol: 'floatPanel', file: 'stores/layoutStore.ts', why: 'no UI floats a panel' },
  { symbol: 'floatingPanels', file: 'stores/layoutStore.ts', why: 'array was permanently empty' },
  { symbol: 'floatingBounds', file: 'stores/layoutStore.ts', why: 'nothing ever set it' },
  { symbol: 'setFloatingBounds', file: 'stores/layoutStore.ts', why: 'zero callers' },
  { symbol: 'bringFloatingToFront', file: 'stores/layoutStore.ts', why: 'zero callers' },
  { symbol: 'workspaceLocked', file: 'stores/layoutStore.ts', why: 'read-only gate, no setter caller' },
  { symbol: 'allowGroup', file: 'stores/layoutStore.ts', why: 'declared, never set, never read' },
  { symbol: 'gizmo3dSnapping', file: 'stores/guidesStore.ts', why: 'no writer and no reader' },
  { symbol: 'exportWorkspaceJSON', file: 'core/layout/workspaceManager.ts', why: 'zero callers, no UI' },
  { symbol: 'importWorkspaceJSON', file: 'core/layout/workspaceManager.ts', why: 'zero callers, no UI' },
];

/** Comments legitimately name these to explain the removal. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('deleted half-built layout state stays deleted', () => {
  it.each(BURIED.map((b) => [b.symbol, b.file, b.why]))(
    '`%s` is gone from %s (%s)',
    (symbol, file) => {
      expect(stripComments(read(file))).not.toMatch(new RegExp(`\\b${symbol}\\b`));
    },
  );

  it("PlacementMode cannot express 'floating'", () => {
    // Stronger than an absence check: the state the renderer has no host for is
    // now unrepresentable rather than merely unused.
    const src = read('stores/layoutStore.ts');
    const decl = /export type PlacementMode =([^;]+);/.exec(src)?.[1] ?? '';
    expect(decl).toContain("'docked'");
    expect(decl).toContain("'external'");
    expect(decl).not.toContain("'floating'");
  });

  it('the gizmo axis-mode setter now has a caller — this one was FINISHED, not deleted', () => {
    // The exception in the group. `useGizmo3d` already read `gizmo3dAxisMode`
    // (it feeds Gizmo3D.getGizmoBasis); only the control was missing, so the
    // gizmo was stuck in 'local' with world/view unreachable. Deleting a
    // feature the engine already implements would have been the wrong call.
    expect(read('layout/SceneControls/SceneControls.tsx')).toMatch(/setGizmo3dAxisMode/);
  });
});
