/**
 * A plugin's own UI, in a sandboxed frame.
 *
 * The panel is the second half of the sandbox story. The plugin's *logic* runs
 * in a Worker (no DOM, so it cannot draw); its *interface* runs here in an
 * iframe that can draw but can reach nothing:
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
 */

import { useEffect, useRef } from 'react';
import { openModal, closeModal } from '@stores/modalStore';
import { usePluginStore } from '@stores/pluginStore';
import pluginHost from '@core/plugins/PluginHost';
import styles from './PluginsModal.module.css';

/**
 * Injected ahead of the plugin's own panel markup.
 *
 * Gives panel authors a two-call API instead of hand-rolled `postMessage`, and
 * — more importantly — makes the message SHAPE fixed, so the host's forwarder
 * has exactly one thing to expect.
 */
const PANEL_PREAMBLE = `<!doctype html><meta charset="utf-8">
<script>
window.motionPanel = {
  send: function (data) { parent.postMessage({ data: data }, '*'); },
  onMessage: function (fn) {
    window.addEventListener('message', function (e) {
      if (e.source === parent && e.data && typeof e.data === 'object') fn(e.data.data);
    });
  }
};
</script>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 12px; font: 13px/1.45 system-ui, sans-serif; color: #e8e8ea; background: #17171a; }
  button { font: inherit; padding: 6px 12px; border-radius: 6px; border: 1px solid #3a3a40; background: #232329; color: inherit; cursor: pointer; }
  button:hover { background: #2c2c33; }
  input, select { font: inherit; padding: 5px 8px; border-radius: 6px; border: 1px solid #3a3a40; background: #101014; color: inherit; }
</style>
`;

function PanelFrame({ pluginId }: { pluginId: string }): JSX.Element {
  const ref = useRef<HTMLIFrameElement>(null);
  const entry = usePluginStore((s) => s.get(pluginId));
  const html = entry?.manifest.panel ? entry.files[entry.manifest.panel.replace(/^\.\//, '')] : undefined;

  useEffect(() => {
    const win = ref.current?.contentWindow;
    if (!win || !entry) return;
    // A sandboxed frame without `allow-same-origin` has the opaque origin,
    // which serialises as the literal string "null" on its messages.
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
      srcDoc={PANEL_PREAMBLE + html}
    />
  );
}

/** Open a plugin's panel as a floating window. */
export function openPluginPanel(pluginId: string): void {
  const entry = usePluginStore.getState().get(pluginId);
  if (!entry) return;
  const id = `plugin-panel-${pluginId}`;
  openModal({
    id,
    title: entry.manifest.name,
    size: 'md',
    onClose: () => closeModal(id),
    render: () => <PanelFrame pluginId={pluginId} />,
  });
}
