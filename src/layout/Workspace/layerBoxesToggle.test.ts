/**
 * The layer-bounding-box toggle, checked on the READ side.
 *
 * A toggle that flips a boolean nobody consults is the most common way a
 * settings control ships broken: the store updates, the button lights up, and
 * the canvas is unchanged. `includeLayerBoxes: true` was a literal, and nothing
 * in the type system distinguishes a wired flag from a hardcoded one — so the
 * toggle could pass every behavioural test here while doing nothing at all.
 *
 * It lives in `preferenceStore`, not `guidesStore`, and that placement is the
 * substance of the feature rather than a detail. `guidesStore` is view state:
 * `groundGridVisible` and `draft3d` both reset on reload. Whether you want an
 * outline around every layer is a settled working style, so a session-scoped
 * toggle would mean turning it off on every launch — which is the complaint,
 * not the fix.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { usePreferenceStore, DEFAULT_PREFERENCES } from '@stores/preferenceStore';

const SRC = (rel: string): string => readFileSync(join(__dirname, '..', '..', rel), 'utf8');

describe('layer bounding boxes toggle', () => {
  beforeEach(() => {
    usePreferenceStore.getState().set('showLayerBounds', true);
  });

  it('defaults to visible — the previous behaviour', () => {
    // Turning them off by default would silently change what every existing
    // project looks like on open. The complaint was that they cannot be turned
    // off, not that they are on.
    expect(DEFAULT_PREFERENCES.showLayerBounds).toBe(true);
  });

  it('toggles both ways', () => {
    usePreferenceStore.getState().set('showLayerBounds', false);
    expect(usePreferenceStore.getState().showLayerBounds).toBe(false);
    usePreferenceStore.getState().set('showLayerBounds', true);
    expect(usePreferenceStore.getState().showLayerBounds).toBe(true);
  });

  it('is a persisted preference, not session view state', () => {
    // The distinction this whole placement rests on. If it ever moves back into
    // `guidesStore` it silently becomes session-scoped again, and the only
    // symptom is a user re-toggling it every launch — which nobody reports as a
    // bug, they just stop using the control.
    expect(Object.keys(DEFAULT_PREFERENCES)).toContain('showLayerBounds');
    expect(SRC('stores/guidesStore.ts')).not.toContain('layerBoxes');
  });

  it('reaches the overlay — collectSceneGizmos gets the flag, not `true`', () => {
    const src = SRC('layout/Workspace/useSceneRefGeometry.ts');
    expect(src).toContain('includeLayerBoxes: layerBoxesVisible');
    expect(src).not.toContain('includeLayerBoxes: true');
    // …and the memo must re-run when it changes, or the boxes persist on screen
    // until something unrelated invalidates the gizmo list.
    const depsAt = src.indexOf('[scene3d,');
    expect(depsAt).toBeGreaterThan(-1);
    expect(src.slice(depsAt, depsAt + 220)).toContain('layerBoxesVisible');
  });

  it('is reachable from both places that own view chrome', () => {
    // The scene toolbar for reach, the View menu for discoverability. A control
    // in only the toolbar is one nobody finds; one in only the menu is one
    // nobody uses twice.
    expect(SRC('layout/SceneControls/SceneControls.tsx')).toContain('showLayerBounds');
    expect(SRC('layout/TopNav/TopNav.tsx')).toContain('showLayerBounds');
  });
});
