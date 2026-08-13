/**
 * Render-tick subscription (regression for doc §12.2).
 *
 * `onRender` was a single-slot setter (`this.renderCb = cb`) with THREE call
 * sites: the viewport draw in useWorkspace, plus the puppet and bone canvas
 * overlays. Last writer won, so the overlays' redraw-on-camera-movement was
 * silently dead — verified in the running app: panning the camera with the
 * puppet tool active left the pin handles frozen until an unrelated state
 * change re-rendered the component.
 *
 * These tests are on the Set semantics rather than the controller singleton, so
 * they stay honest about what actually broke: multiple registrants coexisting,
 * and disposal removing only the caller's own subscription.
 */

import { getWorkspaceController } from './WorkspaceController';

describe('§12.2 — render-tick subscribers', () => {
  it('registering twice keeps BOTH subscribers', () => {
    const c = getWorkspaceController();
    const seen: string[] = [];
    const offA = c.onRender(() => seen.push('a'));
    const offB = c.onRender(() => seen.push('b'));

    // Reach past the private field to fire a tick without waiting on rAF
    // (jsdom has no real frame loop, and the point under test is dispatch).
    const cbs = (c as unknown as { renderCbs: Set<() => void> }).renderCbs;
    expect(cbs.size).toBe(2);
    for (const cb of [...cbs]) cb();
    expect(seen).toEqual(['a', 'b']);

    offA();
    offB();
  });

  it('a disposer removes only its own subscription', () => {
    const c = getWorkspaceController();
    const cbs = (c as unknown as { renderCbs: Set<() => void> }).renderCbs;
    const before = cbs.size;

    const seen: string[] = [];
    const offA = c.onRender(() => seen.push('a'));
    const offB = c.onRender(() => seen.push('b'));
    expect(cbs.size).toBe(before + 2);

    offA();
    expect(cbs.size).toBe(before + 1);
    for (const cb of [...cbs]) cb();
    expect(seen).toEqual(['b']);

    offB();
    expect(cbs.size).toBe(before);
  });

  it('disposing twice is harmless', () => {
    const c = getWorkspaceController();
    const cbs = (c as unknown as { renderCbs: Set<() => void> }).renderCbs;
    const before = cbs.size;
    const off = c.onRender(() => undefined);
    off();
    off();
    expect(cbs.size).toBe(before);
  });

  it('a subscriber unsubscribing DURING a tick does not corrupt the dispatch', () => {
    const c = getWorkspaceController();
    const seen: string[] = [];

    let offSelf: (() => void) | null = null;
    offSelf = c.onRender(() => {
      seen.push('self');
      offSelf?.();
    });
    const offOther = c.onRender(() => seen.push('other'));

    const cbs = (c as unknown as { renderCbs: Set<() => void> }).renderCbs;
    for (const cb of [...cbs]) cb();

    // Both ran this tick; the self-removing one is gone for the next.
    expect(seen).toEqual(['self', 'other']);
    seen.length = 0;
    for (const cb of [...cbs]) cb();
    expect(seen).toEqual(['other']);

    offOther();
  });
});
