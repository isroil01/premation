/**
 * A native plugin's panel (plan P5): the bundle's `ui/index.html` in a
 * sandboxed frame (`plugin-ui://<id>/`, served by main with a no-network
 * policy; electron/pluginPanelProtocol.ts). The frame talks to this component
 * by postMessage only; each request becomes one engine command or query
 * (src/core/nativePlugins/pluginPanel.ts), so a panel edit is an ordinary undo
 * entry. While open, the panel gets `state` after every document change — undo
 * and redo included.
 *
 * Where it shows (owner 2026-10-14, AE's model — Element 3D's Scene Setup is a
 * window of its own, never a strip inside Effect Controls):
 *   - the effect card header's panel button (manifest `panelTitle`, default
 *     "Panel"; PluginCardHeader) opens it in a floating tool window
 *     (no scrim, the app stays live, the frame remembered per plugin);
 *   - the plugin's own sidebar panel (PluginEffectHomePanel) shows it for the
 *     selected layer's instance of the effect.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { EffectUi } from '@motion/engine-api';
import { secondsToFlicks } from '@motion/engine-api';
import { Modal } from '@components/Modal';
import { engine } from '@core/engine/engineInstance';
import { edit } from '@core/engine/uiEdits';
import { paths } from '@core/engine/propRefs';
import type { Effect } from '@core/inspector/effectCatalog';
import type { PluginEffectDef } from '@core/inspector/pluginEffectDefs';
import {
  PANEL_SANDBOX,
  bytesToBase64,
  panelCommands,
  panelLabel,
  panelReply,
  panelState,
  panelUrl,
  parsePanelMessage,
  type PanelReply,
  type PanelRequest,
} from '@core/nativePlugins/pluginPanel';
import { panelThemeMessage } from '@core/nativePlugins/panelTheme';
import { useMirrorRevision } from '@hooks/useMirror';
import { usePanelTheme } from '@hooks/usePanelTheme';
import { useActiveWorkspace } from '@stores/projectStore';
import { runPanelShortcut } from '@layout/Plugins/panelShortcut';
import { t } from '@core/i18n';

interface Props {
  nodeId: string;
  effect: Effect;
  def: PluginEffectDef;
  /** The editor's time, seconds. */
  time: number;
  /** The engine's getEffectUi answer (null until it answers). */
  ui: EffectUi | null;
}

/**
 * The plugin's panel in its floating tool window (remembered per plugin), opened
 * from the effect card header's panel button (PluginCardHeader); `time`
 * defaults to the editor's.
 */
export function PluginPanelWindow({
  nodeId,
  effect,
  def,
  plugin,
  open,
  onClose,
  time,
}: Omit<Props, 'ui' | 'time'> & { plugin: string; open: boolean; onClose: () => void; time?: number }): JSX.Element {
  const now = useActiveWorkspace()?.time ?? 0;
  return (
    <Modal open={open} onClose={onClose} id={`plugin-panel:${plugin}`} title={def.label} variant="floating" size="lg" resizable>
      {open ? (
        <div style={{ height: '100%', minHeight: 240 }}>
          <PluginEffectFrame nodeId={nodeId} effect={effect} def={def} time={time ?? now} plugin={plugin} />
        </div>
      ) : null}
    </Modal>
  );
}

/** The plugin's page for one effect instance; fills its container. */
export function PluginEffectFrame({ nodeId, effect, def, time, plugin }: Omit<Props, 'ui'> & { plugin: string }): JSX.Element {
  const frame = useRef<HTMLIFrameElement>(null);
  const ready = useRef(false);
  const revision = useMirrorRevision(true);
  // The latest inputs, for the message handler (registered once).
  const live = useRef({ nodeId, effect, def, time });
  live.current = { nodeId, effect, def, time };

  const post = useCallback((msg: unknown) => {
    frame.current?.contentWindow?.postMessage(msg, '*');
  }, []);

  // The editor's look (AE's app colours / CEP skin): on load, on ready, on every change.
  const theme = usePanelTheme();
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const pushTheme = useCallback(() => post(panelThemeMessage(themeRef.current)), [post]);
  useEffect(() => {
    pushTheme();
  }, [theme, pushTheme]);

  const pushState = useCallback(async () => {
    const { nodeId: layer, effect: fx, def: d, time: t } = live.current;
    const res = await engine().query({ type: 'getEffectUi', layer, effect: paths.effectGroup(fx.id), time: secondsToFlicks(t) });
    if (!res.ok || !ready.current) return;
    post(panelState({
      effect: { id: fx.id, type: fx.type, name: d.label },
      plugin,
      time: t,
      params: res.value.params,
      values: fx.params as Record<string, unknown> | undefined,
      data: res.value.data,
    }));
  }, [plugin, post]);

  const run = useCallback(async (req: PanelRequest): Promise<PanelReply> => {
    const { nodeId: layer, effect: fx, def: d, time: t } = live.current;
    if (req.type === 'requestPreview') {
      const res = await engine().query({ type: 'getThumbnail', layer, time: secondsToFlicks(t), maxSize: req.maxSize });
      if (!res.ok) return panelReply(req.id, { ok: false, error: res.error.message });
      if (res.value.data.length === 0) return panelReply(req.id, { ok: false, error: 'Nothing to preview at this time.' });
      return panelReply(req.id, { ok: true, image: `data:image/${res.value.format || 'png'};base64,${bytesToBase64(res.value.data)}` });
    }
    const label = panelLabel(req, d.label, d.params.map((p) => ({ key: p.key, name: p.label, enabled: true, hidden: false })));
    const choices = new Map(d.params.filter((p) => p.options && p.options.length > 0).map((p) => [p.key, p.options!.map((o) => String(o.label))]));
    const res = await edit(label, panelCommands(req, { layer, effectId: fx.id, time: secondsToFlicks(t), choices }), { quiet: true });
    return res.ok ? panelReply(req.id, { ok: true }) : panelReply(req.id, { ok: false, error: res.error.message });
  }, []);

  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      // Only this panel's frame; its origin is opaque ('null'), so the source window is the check.
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const msg = parsePanelMessage(e.data);
      if (!msg) return;
      if (msg.type === 'ready') {
        ready.current = true;
        pushTheme();
        void pushState();
        return;
      }
      if (msg.type === 'shortcut') {
        runPanelShortcut(msg.action, frame.current);
        return;
      }
      void run(msg).then(post, (err: unknown) => post(panelReply(msg.id, { ok: false, error: err instanceof Error ? err.message : String(err) })));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [pushState, pushTheme, run, post]);

  // Every document change (an edit from anywhere, undo, redo) and every time change: fresh state.
  useEffect(() => {
    if (ready.current) void pushState();
  }, [revision, time, pushState]);

  return (
    <iframe
      ref={frame}
      title={t('effects.pluginPanel.frameTitle', '{name} panel', { name: def.label })}
      src={panelUrl(plugin)}
      sandbox={PANEL_SANDBOX}
      referrerPolicy="no-referrer"
      onLoad={pushTheme}
      style={{ width: '100%', height: '100%', minHeight: 200, border: 'none', background: 'transparent', display: 'block' }}
    />
  );
}
