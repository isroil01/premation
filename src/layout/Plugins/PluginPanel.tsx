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
 *   • The markup is delivered by `postMessage` into a fixed local shell
 *     (`public/plugin-panel.html`) — NOT by `srcdoc`, which inherits the
 *     embedder's CSP and made every panel's script silently inert. There is a
 *     regression guard for this in `noHostRealmEval.test.ts`.
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

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { inlinePanelStyles } from './panelHtml';
import { create } from 'zustand';
import { Panel } from '@components/Panel';
import { Icon } from '@components/Icon';
import { cn } from '@utils/cn';
import { useLayoutStore } from '@stores/layoutStore';
import { usePluginStore } from '@stores/pluginStore';
import pluginHost from '@core/plugins/PluginHost';
import { readPanelTheme, subscribeToTheme } from './panelTheme';
import { dedicatedPanelId, dedicatedPlacements, sharedPlacements } from './pluginPanelDefs';
import styles from './PluginPanel.module.css';

/** The dock panel's id, as registered in `panelDefs.ts`. */
export const PLUGIN_PANEL_ID = 'plugins';

/**
 * Which plugin's panel the dock tab is showing.
 *
 * Separate from `pluginHost` because it is pure view state: which of several
 * running plugins is in front says nothing about any of them.
 */
interface PluginPanelStore {
  /** `pluginId::panelId` — a plugin may contribute several panels, and each is
   *  its own tab, so the plugin id alone no longer identifies one. */
  active: string | null;
  setActive(key: string | null): void;
}

const usePluginPanelStore = create<PluginPanelStore>((set) => ({
  active: null,
  setActive: (active) => set({ active }),
}));

export interface PanelTab {
  key: string;
  pluginId: string;
  panelId: string;
  /** What the tab says. The panel's own title, prefixed with the plugin's name
   *  only when that plugin contributes more than one. */
  label: string;
}

const tabKey = (pluginId: string, panelId: string): string => `${pluginId}::${panelId}`;

/**
 * The panels that live in THIS panel — the ones whose placement resolved to
 * `shared`, either because they asked for nothing else or because the rail was
 * full when they asked. Panels that own a tab render standalone (see
 * `DedicatedPluginPanel`) and must not also appear here, or they would exist
 * twice with two independent frames talking to one worker.
 *
 * Listed for every ENABLED plugin, not only running ones. That is the change
 * that makes `onPanel:<id>` activation reachable at all: a lazily-activated
 * plugin's panel has to be visible before it starts, because selecting it is
 * the event that starts it. A tab that only appears once the plugin is running
 * can only be used by a plugin that did not need it.
 */
function panelTabs(): PanelTab[] {
  const store = usePluginStore.getState();
  return sharedPlacements()
    .map((p) => {
      const name = store.get(p.pluginId)?.manifest.name ?? p.pluginId;
      const panels = store.get(p.pluginId)?.manifest.contributes.panels ?? [];
      return {
        key: tabKey(p.pluginId, p.panel.id),
        pluginId: p.pluginId,
        panelId: p.panel.id,
        label: panels.length > 1 ? `${name}: ${p.panel.title}` : name,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** The dock-panel id for a (plugin, panel) that owns a tab, or null. */
function dedicatedIdFor(pluginId: string, panelId: string): string | null {
  const id = dedicatedPanelId(pluginId, panelId);
  return dedicatedPlacements().some((p) => dedicatedPanelId(p.pluginId, p.panel.id) === id)
    ? id
    : null;
}

/**
 * Reveal a plugin's panel, wherever the host decided that panel lives.
 *
 * This is what `motion.ui.openPanel()` reaches, and what the manager's "Open"
 * button and the Plugins menu call. Callers deliberately do not know whether
 * the panel got its own tab — a plugin that had to ask would have to handle
 * being demoted when the rail is full, and there is nothing useful it could do
 * about that.
 */
export function showPluginPanel(pluginId: string, panelId: string): void {
  const dedicated = dedicatedIdFor(pluginId, panelId);
  if (dedicated) {
    openDock(dedicated, 0);
    return;
  }
  usePluginPanelStore.getState().setActive(tabKey(pluginId, panelId));
  openDock(PLUGIN_PANEL_ID, 0);
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
function openDock(dockId: string, attempt: number): void {
  const layout = useLayoutStore.getState();
  if (layout.panels[dockId]) { layout.openPanel(dockId); return; }
  if (attempt >= 40) return;
  setTimeout(() => openDock(dockId, attempt + 1), 100);
}

/**
 * Hide it again — the shared host only.
 *
 * A panel with its OWN tab is deliberately unaffected. Its tab is registered
 * from what is installed and enabled (`pluginPanelDefs`), not from what is
 * running, so it survives the plugin stopping and comes back the moment it
 * starts again — the alternative is a rail glyph that vanishes and reappears
 * under the user's cursor. `PluginHost.stop` calls this for every panel, and
 * for a dedicated one the right answer is to do nothing at all: disabling or
 * uninstalling is what removes the tab, and both go through the store the
 * registration effect is watching.
 */
export function hidePluginPanel(pluginId: string, panelId: string): void {
  if (dedicatedIdFor(pluginId, panelId)) return;
  const store = usePluginPanelStore.getState();
  const key = tabKey(pluginId, panelId);
  if (store.active !== null && store.active !== key) return;
  const next = panelTabs().find((p) => p.key !== key);
  store.setActive(next?.key ?? null);
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

/**
 * What to say when the frame cannot be shown yet, and whether to offer a retry.
 *
 * A panel tab now exists for every enabled plugin, so "not running" is a state
 * the user can actually look at rather than an impossible one — and each reason
 * for it wants a different sentence. Rendering an empty frame for all of them is
 * how "my plugin panel is blank" becomes unanswerable.
 */
function statusBody(status: string): { text: string; retry: boolean } | null {
  switch (status) {
    case 'running':
      return null;
    case 'inactive':
      // Being started by the effect below. Momentary, but a panel that shows
      // nothing at all for a second reads as broken rather than as loading.
      return { text: 'Starting…', retry: false };
    case 'error':
      return { text: 'This plugin stopped after an error. Its log is on its page in Plugins.', retry: true };
    default:
      return { text: 'This plugin is not running.', retry: true };
  }
}

function PanelFrame({ pluginId, panelId }: { pluginId: string; panelId: string }): JSX.Element {
  const ref = useRef<HTMLIFrameElement>(null);
  const entry = usePluginStore((s) => s.get(pluginId));
  const panel = entry?.manifest.contributes.panels.find((p) => p.id === panelId);
  const entryPath = panel?.entry.replace(/^\.\//, '');
  const rawHtml = entryPath ? entry?.files[entryPath] : undefined;
  /*
    Linked stylesheets resolved against the PACKAGE, before the markup leaves
    this origin.

    A relative `href` in the frame would resolve against the app's own origin —
    the shell is loaded from `plugin-panel.html`, not from anywhere the
    package's files exist — and the frame has `connect-src 'none'`, so it could
    not fetch one even if the URL were right. Doing it here is also what keeps
    that promise: a link that stayed a link would be the one thing in a panel
    able to reach outward.
  */
  const html = useMemo(
    () => (rawHtml !== undefined && entryPath
      ? inlinePanelStyles(rawHtml, entry?.files ?? {}, entryPath)
      : rawHtml),
    [rawHtml, entryPath, entry?.files],
  );
  useSyncExternalStore((cb) => pluginHost.subscribe(cb), () => pluginHost.getRevision());
  const status = pluginHost.info(pluginId).status;

  // `inactive` and ONLY `inactive`: that is the lazy state, and opening the
  // panel is the declared event that ends it. Retrying on `error` or `stopped`
  // here instead would restart a crashing plugin on every revision bump — a
  // boot loop driven by its own failures, with the panel as the trigger. Those
  // two get a button, so a restart is something the user asked for once.
  useEffect(() => {
    if (status !== 'inactive') return;
    void pluginHost.showPanel(pluginId, panelId);
  }, [pluginId, panelId, status]);

  useEffect(() => {
    const win = ref.current?.contentWindow;
    if (!win || !entry) return;
    // A sandboxed frame without `allow-same-origin` has the opaque origin,
    // which serialises as the literal string "null" on its messages — true
    // whether it was written with srcdoc or loaded from a URL, so loading the
    // shell from our own origin does not weaken the provenance check.
    const offFrame = pluginHost.registerFrame(win, 'null');
    // Claimed for a (plugin, panel) PAIR. Routing is by frame identity, so a
    // panel cannot address another panel by putting an id in its payload.
    const offOwner = pluginHost.claimFrame(win, pluginId, panelId);
    const offPanel = pluginHost.attachPanel(pluginId, panelId, (data: unknown) => {
      try { win.postMessage({ data }, '*'); } catch { /* frame gone */ }
    });
    return () => { offFrame(); offOwner(); offPanel(); };
  }, [entry, pluginId, panelId]);

  useEffect(() => {
    // Theme now, and again whenever it changes — a panel that is only themed at
    // load is a panel that goes the wrong colour the first time the user
    // switches, and stays wrong until they reopen it.
    const post = (): void => {
      const win = ref.current?.contentWindow;
      if (!win) return;
      try { win.postMessage({ __panelTheme: readPanelTheme() }, '*'); } catch { /* frame gone */ }
    };
    post();
    return subscribeToTheme(post);
  }, [pluginId, panelId, html]);

  if (!entry || !panel || html === undefined) {
    return <p className={styles.emptyBody}>This plugin has no panel.</p>;
  }

  // Checked AFTER the hooks above, never before: an early return that skips a
  // useEffect is a different hook order on the next status change.
  const blocked = statusBody(status);
  if (blocked) {
    return (
      <div className={styles.empty}>
        <Icon name="plugin" size="lg" />
        <span className={styles.emptyTitle}>{entry.manifest.name}</span>
        <p className={styles.emptyBody}>{blocked.text}</p>
        {blocked.retry && (
          <button type="button" className={styles.retry} onClick={() => pluginHost.restart(pluginId)}>
            Start it
          </button>
        )}
      </div>
    );
  }

  return (
    <iframe
      ref={ref}
      title={`${entry.manifest.name} — ${panel.title}`}
      className={styles.panelFrame}
      sandbox="allow-scripts"
      src={PANEL_SHELL_URL}
      // The markup is handed over AFTER load rather than embedded in the URL:
      // the shell has to be running (and have installed `motionPanel`) before
      // the plugin's own script does.
      onLoad={() => {
        try {
          // Theme first, so the panel's own script sees the variables already
          // set rather than repainting a frame later.
          ref.current?.contentWindow?.postMessage({ __panelTheme: readPanelTheme() }, '*');
          ref.current?.contentWindow?.postMessage({ __panelHtml: html }, '*');
        } catch { /* frame gone */ }
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
/**
 * One plugin panel that earned a tab of its own, rendered as a first-class dock
 * panel beside Scene or Properties.
 *
 * No tab strip and no ✕ — it is one panel, and it belongs to the rail for as
 * long as the plugin is installed and enabled. `hideHeader`, like every other
 * docked panel: the rail tab already names it, and a second title bar inside a
 * 280px column is a row of chrome that repeats what the tooltip just said.
 *
 * `onClose` is deliberately not passed. `Panel` only draws the button when it
 * is, so this is the one place the absence has to be maintained rather than
 * asserted — hence `noPluginPanelCloseAffordance.test.tsx`.
 */
export function DedicatedPluginPanel({
  pluginId,
  panelId,
}: {
  pluginId: string;
  panelId: string;
}): JSX.Element {
  const entry = usePluginStore((s) => s.get(pluginId));
  const panel = entry?.manifest.contributes.panels.find((p) => p.id === panelId);
  return (
    <Panel
      id={dedicatedPanelId(pluginId, panelId)}
      title={panel?.title ?? entry?.manifest.name ?? 'Plugin'}
      icon={(panel?.icon ?? 'plugin') as 'plugin'}
      hideHeader
      noScroll
    >
      <div className={styles.dockPanel}>
        <PanelFrame pluginId={pluginId} panelId={panelId} />
      </div>
    </Panel>
  );
}

/**
 * Renderers for every plugin panel that currently owns a tab, keyed by dock id.
 *
 * Merged into `getAllPanelRenderers()`, which both sidebars and `PopoutRoute`
 * read — a plugin panel popped out into its own window resolves through the
 * same map as Scene does, so it needs no special case there.
 */
export function pluginPanelRenderers(): Record<string, () => JSX.Element> {
  const out: Record<string, () => JSX.Element> = {};
  for (const p of dedicatedPlacements()) {
    const { pluginId } = p;
    const panelId = p.panel.id;
    out[dedicatedPanelId(pluginId, panelId)] = () => (
      <DedicatedPluginPanel pluginId={pluginId} panelId={panelId} />
    );
  }
  return out;
}

export function PluginsDockPanel(): JSX.Element {
  // Two sources, both needed: the STORE says what is installed, the HOST says
  // what is running. A tab may only exist when both agree.
  useSyncExternalStore((cb) => pluginHost.subscribe(cb), () => pluginHost.getRevision());
  usePluginStore((s) => s.plugins);
  const active = usePluginPanelStore((s) => s.active);
  const setActive = usePluginPanelStore((s) => s.setActive);

  const available = panelTabs();
  const current = available.find((p) => p.key === active) ?? available[0];

  return (
    <Panel
      id={PLUGIN_PANEL_ID}
      title="Plugins"
      icon="plugin"
      hideHeader
      noScroll
      // No `onClose`, so `Panel` draws no ✕ — see `panelDefs.ts`. Removal is the
      // toggle on the plugin's row in the Plugins panel, which also stops the
      // worker; a dock button that only hid the container was a second, weaker
      // version of that with none of the effect.
    >
      {available.length === 0 ? (
        <div className={styles.empty}>
          <Icon name="plugin" size="lg" />
          <span className={styles.emptyTitle}>No plugin panels here</span>
          <p className={styles.emptyBody}>
            Plugins that ship a small interface show it here. Ones that ask for a
            tab of their own appear in the sidebar instead. Install one from the
            Plugins panel.
          </p>
        </div>
      ) : (
        <div className={styles.dockPanel}>
          {available.length > 1 && (
            <div className={styles.dockTabs} role="tablist">
              {available.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  role="tab"
                  aria-selected={p.key === current?.key}
                  className={cn(styles.dockTab, p.key === current?.key && styles.dockTabActive)}
                  onClick={() => setActive(p.key)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          )}
          {current && <PanelFrame key={current.key} pluginId={current.pluginId} panelId={current.panelId} />}
        </div>
      )}
    </Panel>
  );
}
