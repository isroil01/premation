/**
 * Pop-out windows follow the layout store.
 *
 * `externalPanels` is the record of which panels are out; this keeps the real
 * windows in step with it, in the editor window only:
 *
 *   a panel enters `externalPanels`  → its window opens (or comes forward)
 *   a panel leaves it (Re-dock)      → its window closes
 *   the user closes the window       → the panel docks back where it was
 *
 * Before, each half was on its own: closing a pop-out left its panel gone from
 * the dock (or the main window saying "open in an external window") for good,
 * Re-dock left the window open, and the Dual Monitor workspace marked panels
 * external without opening anything.
 */

import { useLayoutStore } from '@stores/layoutStore';
import { popoutHash } from '@core/layout/popoutPath';

/** Undock a panel (or the viewport / timeline) into a window of its own. */
export function popOutPanel(panelId: string): void {
  const store = useLayoutStore.getState();
  if (store.externalPanels.includes(panelId)) {
    // Already out: bring its window forward.
    openWindow(panelId);
    return;
  }
  store.popoutPanel(panelId);
}

/** Put a popped-out panel back where it came from. */
function redock(panelId: string): void {
  const store = useLayoutStore.getState();
  if (!store.externalPanels.includes(panelId)) return;
  store.dockPanel(panelId, store.panels[panelId]?.region);
}

/** A browser build has no window manager: `window.open` children, watched for closing. */
const browserWindows = new Map<string, Window>();
let browserPoll: ReturnType<typeof setInterval> | null = null;

function watchBrowserWindows(): void {
  if (browserPoll !== null) return;
  browserPoll = setInterval(() => {
    for (const [id, w] of browserWindows) {
      if (!w.closed) continue;
      browserWindows.delete(id);
      redock(id);
    }
    if (browserWindows.size === 0 && browserPoll !== null) {
      clearInterval(browserPoll);
      browserPoll = null;
    }
  }, 500);
}

function openWindow(panelId: string): void {
  const bridge = window.motionEditor?.popout;
  if (bridge?.spawnWindow) {
    bridge.spawnWindow(panelId);
    return;
  }
  const open = browserWindows.get(panelId);
  if (open && !open.closed) {
    open.focus();
    return;
  }
  const url = `${window.location.origin}${window.location.pathname}${popoutHash(panelId)}`;
  const w = window.open(url, `popout-${panelId}`, 'width=1000,height=700,resizable=yes');
  if (!w) {
    // Blocked: nothing opened, so nothing is out.
    redock(panelId);
    return;
  }
  browserWindows.set(panelId, w);
  watchBrowserWindows();
}

function closeWindow(panelId: string): void {
  const bridge = window.motionEditor?.popout;
  if (bridge?.close) {
    void bridge.close(panelId);
    return;
  }
  const w = browserWindows.get(panelId);
  browserWindows.delete(panelId);
  if (w && !w.closed) w.close();
}

/** Start keeping the windows in step with the store. Returns the teardown. */
export function installPopoutWindows(): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const bridge = window.motionEditor?.popout;
  let alive = true;
  /** Windows the store learns of from main (a reloaded editor page) — already open. */
  const adopting = new Set<string>();

  const unsubStore = useLayoutStore.subscribe((state, prev) => {
    if (state.externalPanels === prev.externalPanels) return;
    const before = new Set(prev.externalPanels);
    const after = new Set(state.externalPanels);
    for (const id of after) {
      if (before.has(id)) continue;
      if (adopting.delete(id)) continue;
      openWindow(id);
    }
    for (const id of before) if (!after.has(id)) closeWindow(id);
  });

  const offClosed = bridge?.onClosed?.((panelId) => redock(panelId)) ?? (() => undefined);

  // Reconcile with what is actually open: panels a workspace marked external
  // before this ran get their windows; windows that outlived a reload of this
  // page are adopted rather than reopened.
  const pending = useLayoutStore.getState().externalPanels;
  void (async () => {
    const open = new Set(bridge?.list ? await bridge.list().catch(() => [] as string[]) : []);
    if (!alive) return;
    const store = useLayoutStore.getState();
    for (const id of open) {
      if (store.externalPanels.includes(id)) continue;
      adopting.add(id);
      useLayoutStore.getState().popoutPanel(id);
    }
    for (const id of pending) if (!open.has(id)) openWindow(id);
  })();

  return () => {
    alive = false;
    unsubStore();
    offClosed();
  };
}
