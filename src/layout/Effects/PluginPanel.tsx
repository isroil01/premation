/**
 * A native plugin's panel on its effect card (plan P5): the bundle's
 * `ui/index.html` in a sandboxed frame (`plugin-ui://<id>/`, served by main with
 * a no-network policy; electron/pluginPanelProtocol.ts). The frame talks to
 * this component by postMessage only; each request becomes one engine command
 * or query (src/core/nativePlugins/pluginPanel.ts), so a panel edit is an
 * ordinary undo entry. While open, the panel gets `state` after every document
 * change — undo and redo included.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { EffectUi } from '@motion/engine-api';
import { secondsToFlicks } from '@motion/engine-api';
import { Button } from '@components/Button';
import { engine } from '@core/engine/engineInstance';
import { edit } from '@core/engine/uiEdits';
import { paths } from '@core/engine/propRefs';
import type { Effect } from '@core/inspector/effectCatalog';
import type { PluginEffectDef } from '@core/inspector/pluginEffectDefs';
import {
  PANEL_SANDBOX,
  bytesToBase64,
  panelCommand,
  panelLabel,
  panelReply,
  panelState,
  panelUrl,
  parsePanelMessage,
  type PanelReply,
  type PanelRequest,
} from '@core/nativePlugins/pluginPanel';
import { useMirrorRevision } from '@hooks/useMirror';
import row from '@layout/Inspector/TextAnimatorControls.module.css';

interface Props {
  nodeId: string;
  effect: Effect;
  def: PluginEffectDef;
  /** The editor's time, seconds. */
  time: number;
  /** The engine's getEffectUi answer (null until it answers). */
  ui: EffectUi | null;
}

/** "Open Panel" under a plugin effect whose bundle ships one; the frame below it while open. */
export function PluginPanel({ nodeId, effect, def, time, ui }: Props): JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (!ui?.panel || !ui.plugin) return null;
  return (
    <div style={{ paddingLeft: 22, paddingRight: 6 }}>
      <div className={row.paramRow}>
        <Button size="sm" variant="secondary" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? 'Close Panel' : 'Open Panel'}
        </Button>
      </div>
      {open ? <PanelFrame nodeId={nodeId} effect={effect} def={def} time={time} plugin={ui.plugin} /> : null}
    </div>
  );
}

function PanelFrame({ nodeId, effect, def, time, plugin }: Omit<Props, 'ui'> & { plugin: string }): JSX.Element {
  const frame = useRef<HTMLIFrameElement>(null);
  const ready = useRef(false);
  const revision = useMirrorRevision(true);
  // The latest inputs, for the message handler (registered once).
  const live = useRef({ nodeId, effect, def, time });
  live.current = { nodeId, effect, def, time };

  const post = useCallback((msg: unknown) => {
    frame.current?.contentWindow?.postMessage(msg, '*');
  }, []);

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
    const res = await edit(label, panelCommand(req, { layer, effectId: fx.id, time: secondsToFlicks(t) }), { quiet: true });
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
        void pushState();
        return;
      }
      void run(msg).then(post, (err: unknown) => post(panelReply(msg.id, { ok: false, error: err instanceof Error ? err.message : String(err) })));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [pushState, run, post]);

  // Every document change (an edit from anywhere, undo, redo) and every time change: fresh state.
  useEffect(() => {
    if (ready.current) void pushState();
  }, [revision, time, pushState]);

  return (
    <iframe
      ref={frame}
      title={`${def.label} panel`}
      src={panelUrl(plugin)}
      sandbox={PANEL_SANDBOX}
      referrerPolicy="no-referrer"
      style={{ width: '100%', height: 320, border: '1px solid var(--color-border)', borderRadius: 3, background: 'transparent' }}
    />
  );
}
