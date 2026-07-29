/**
 * Plugin UI, in a sandboxed frame, docked like every other panel.
 *
 * Two things are going on here.
 *
 * **The sandbox.** A plugin's *logic* runs in a Worker (no DOM, so it cannot
 * draw); its *interface* runs here in an iframe that can draw but can reach
 * nothing:
 *
 *   • `sandbox="allow-scripts"` **without** `allow-same-origin` — the frame gets
 *     an opaque origin, so it cannot read this document, our cookies, our
 *     `localStorage`, or anything else same-origin policy protects.
 *   • The markup is delivered by `srcdoc`, so the frame never navigates to a URL
 *     and no network request is made on its behalf.
 *   • The only way out is `postMessage` to the parent, which `PluginHost`
 *     accepts solely from frames it registered, on the origin it registered them
 *     with, and forwards ONLY to the worker that owns the frame. A panel cannot
 *     name an API method, a layer, or another plugin.
 *
 * So a panel can ask its own plugin for something; it can never ask the editor.
 *
 * **The placement.** This used to be `openModal(...)` — a Radix dialog with a
 * scrim and a focus trap. A plugin panel exists to be used *while* you drag on
 * the canvas and scrub the timeline, and a modal is precisely the one container
 * that forbids that. It is a dock panel now, so it tabs alongside Effects and
 * Graph, can be floated or popped out to a second monitor by the same dock
 * machinery as everything else, and its position survives a reload.
 */

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { Panel } from '@components/Panel';
import { Icon } from '@components/Icon';
import { cn } from '@utils/cn';
import { useLayoutStore } from '@stores/layoutStore';
import { usePluginStore } from '@stores/pluginStore';
import pluginHost from '@core/plugins/PluginHost';
import styles from './PluginsModal.module.css';

/** The dock panel's id, as registered in `panelDefs.ts`. */
export const PLUGIN_PANEL_ID = 'plugins';

/**
 * Which plugin's panel the dock tab is showing.
 *
 * Separate from `pluginHost` because it is pure view state: which of several
 * running plugins is in front says nothing about any of them.
 */
interface PluginPanelStore {
  active: string | null;
  setActive(id: string | null): void;
}

const usePluginPanelStore = create<PluginPanelStore>((set) => ({
  active: null,
  setActive: (active) => set({ active }),
}));

/** Every installed plugin that is running and has a panel to show. */
function panelPlugins(): Array<{ id: string; name: string }> {
  return usePluginStore
    .getState()
    .plugins.filter((p) => p.manifest.panel && pluginHost.isRunning(p.manifest.id))
    .map((p) => ({ id: p.manifest.id, name: p.manifest.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Reveal a plugin's panel — the dock panel opens, that plugin's tab is selected.
 *
 * This is what `motion.ui.openPanel()` reaches, and what the manager's "Open"
 * button and the Plugins menu call.
 */
export function showPluginPanel(pluginId: string): void {
  usePluginPanelStore.getState().setActive(pluginId);
  openDock(0);
}

/**
 * Open the dock panel, waiting for the dock to exist if it does not yet.
 *
 * Two orderings make a straight `openPanel()` lose at boot. The editor shell
 * registers its panels in a mount effect, while enabled plugins are started
 * from `pluginHost.configure()` — so a plugin calling `motion.ui.openPanel()`
 * from `activate()` can arrive before the panel is registered, and
 * `layoutStore.openPanel` drops an unknown id silently. Worse, the same effect
 * CLOSES on-demand panels immediately after registering them, so even winning
 * the first race loses the second. Polling past both is what makes
 * "open my panel on startup" work at all; the deadline is there so a pop-out
 * window (which never registers panels) stops instead of retrying forever.
 */
function openDock(attempt: number): void {
  const layout = useLayoutStore.getState();
  if (layout.panels[PLUGIN_PANEL_ID]) { layout.openPanel(PLUGIN_PANEL_ID); return; }
  if (attempt >= 40) return;
  setTimeout(() => openDock(attempt + 1), 100);
}

/**
 * Hide it again.
 *
 * Also called when a plugin stops, so the last panel closing takes the whole
 * dock panel with it rather than leaving an empty tab the user has to tidy up.
 */
export function hidePluginPanel(pluginId: string): void {
  const store = usePluginPanelStore.getState();
  if (store.active !== null && store.active !== pluginId) return;
  const next = panelPlugins().find((p) => p.id !== pluginId);
  store.setActive(next?.id ?? null);
  if (!next) useLayoutStore.getState().closePanel(PLUGIN_PANEL_ID);
}

/**
 * The panel host document (`public/plugin-panel.html`).
 *
 * Relative on purpose: the packaged app is loaded over `file://` from
 * `dist/index.html`, so an absolute `/plugin-panel.html` would resolve to the
 * filesystem root. Both dev and packaged resolve this correctly against the
 * document's base.
 */
const PANEL_SHELL_URL = 'plugin-panel.html';

function PanelFrame({ pluginId }: { pluginId: string }): JSX.Element {
  const ref = useRef<HTMLIFrameElement>(null);
  const entry = usePluginStore((s) => s.get(pluginId));
  const html = entry?.manifest.panel ? entry.files[entry.manifest.panel.replace(/^\.\//, '')] : undefined;

  useEffect(() => {
    const win = ref.current?.contentWindow;
    if (!win || !entry) return;
    // A sandboxed frame without `allow-same-origin` has the opaque origin,
    // which serialises as the literal string "null" on its messages — true
    // whether it was written with srcdoc or loaded from a URL, so loading the
    // shell from our own origin does not weaken the provenance check.
    const offFrame = pluginHost.registerFrame(win, 'null');
    const offOwner = pluginHost.claimFrame(win, pluginId);
    const offPanel = pluginHost.attachPanel(pluginId, (data) => {
      try { win.postMessage({ data }, '*'); } catch { /* frame gone */ }
    });
    return () => { offFrame(); offOwner(); offPanel(); };
  }, [entry, pluginId]);

  if (!entry || html === undefined) {
    return <p className={styles.emptyBody}>This plugin has no panel.</p>;
  }

  return (
    <iframe
      ref={ref}
      title={`${entry.manifest.name} panel`}
      className={styles.panelFrame}
      sandbox="allow-scripts"
      src={PANEL_SHELL_URL}
      // The markup is handed over AFTER load rather than embedded in the URL:
      // the shell has to be running (and have installed `motionPanel`) before
      // the plugin's own script does.
      onLoad={() => {
        try { ref.current?.contentWindow?.postMessage({ __panelHtml: html }, '*'); } catch { /* frame gone */ }
      }}
    />
  );
}

/**
 * The docked Plugins panel: a tab per running plugin that has UI.
 *
 * The tab strip only appears with more than one — a single plugin should not
 * pay for a chrome row that explains nothing.
 */
export function PluginsDockPanel(): JSX.Element {
  // Two sources, both needed: the STORE says what is installed, the HOST says
  // what is running. A tab may only exist when both agree.
  useSyncExternalStore((cb) => pluginHost.subscribe(cb), () => pluginHost.getRevision());
  usePluginStore((s) => s.plugins);
  const active = usePluginPanelStore((s) => s.active);
  const setActive = usePluginPanelStore((s) => s.setActive);

  const available = panelPlugins();
  const current = available.find((p) => p.id === active) ?? available[0];

  return (
    <Panel
      id={PLUGIN_PANEL_ID}
      title="Plugins"
      icon="plugin"
      hideHeader
      noScroll
      onClose={() => useLayoutStore.getState().closePanel(PLUGIN_PANEL_ID)}
    >
      {available.length === 0 ? (
        <div className={styles.empty}>
          <Icon name="plugin" size={22} />
          <span className={styles.emptyTitle}>No plugin panels open</span>
          <p className={styles.emptyBody}>
            A plugin that ships an interface shows it here. Install one from
            Plugins ▸ Manage Plugins…, then open its panel.
          </p>
        </div>
      ) : (
        <div className={styles.dockPanel}>
          {available.length > 1 && (
            <div className={styles.dockTabs} role="tablist">
              {available.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="tab"
                  aria-selected={p.id === current?.id}
                  className={cn(styles.dockTab, p.id === current?.id && styles.dockTabActive)}
                  onClick={() => setActive(p.id)}
                >
                  {p.name}
                </button>
              ))}
            </div>
          )}
          {current && <PanelFrame key={current.id} pluginId={current.id} />}
        </div>
      )}
    </Panel>
  );
}
