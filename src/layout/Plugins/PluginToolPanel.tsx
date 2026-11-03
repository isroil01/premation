/**
 * A native plugin's dockable panel (P7d, manifest `panels`): the bundle's page
 * in the P5 sandbox (`plugin-ui://<id>/<page>`, no Node, no network), talking
 * to the editor by postMessage only (core/nativePlugins/pluginToolPanel.ts).
 * Every request is the engine API: a query, or an edit command sent with
 * origin `plugin` as ONE undo entry. The page gets `context` (the active
 * composition, the selection, the playhead) on ready and after every
 * document, selection or time change — undo and redo included.
 */

import { useCallback, useEffect, useRef } from 'react';
import { secondsToFlicks } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import { pluginPanel } from '@core/nativePlugins/pluginContrib';
import { PANEL_SANDBOX } from '@core/nativePlugins/pluginPanel';
import {
  parseToolPanelMessage,
  toolPanelContext,
  toolPanelLabel,
  toolPanelReply,
  toolPanelUrl,
  type ToolPanelMessage,
} from '@core/nativePlugins/pluginToolPanel';
import { panelThemeMessage } from '@core/nativePlugins/panelTheme';
import { useMirrorRevision } from '@hooks/useMirror';
import { usePanelTheme } from '@hooks/usePanelTheme';
import { usePluginContrib } from '@hooks/usePluginContrib';
import { useThrottledTime } from '@stores/playbackClockStore';
import { useProjectStore } from '@stores/projectStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useKeyframeSelectionStore } from '@stores/keyframeSelectionStore';
import { usePropertySelectionStore } from '@stores/propertySelectionStore';
import {
  acceptPanelShortcuts,
  openPanelFile,
  panelEditorCommands,
  panelSelection,
  panelShortcutFor,
  pluginPanelSettings,
  runPanelEditorCommand,
  runPanelScript,
  savePanelFile,
} from './panelEditorCommands';
import { runPanelShortcut } from './panelShortcut';
import { PluginEffectHomePanel } from './PluginEffectHomePanel';
import { t } from '@core/i18n';

export function PluginToolPanel({ panelId }: { panelId: string }): JSX.Element {
  usePluginContrib();
  const entry = pluginPanel(panelId);
  if (!entry) {
    return (
      <div style={{ padding: 12, color: 'var(--color-text-secondary)', fontSize: 'var(--panel-body-size, 12px)' }}>
        {t('plugins.toolPanel.notLoaded', 'This panel\'s plugin is not loaded. Enable it in Plugins to use the panel again.')}
      </div>
    );
  }
  if (entry.kind === 'effect') return <PluginEffectHomePanel key={panelId} panelId={panelId} plugin={entry.plugin} pluginName={entry.pluginName} />;
  return <ToolFrame key={panelId} plugin={entry.plugin} page={entry.panel.page} name={entry.panel.name} />;
}

function ToolFrame({ plugin, page, name }: { plugin: string; page: string; name: string }): JSX.Element {
  const frame = useRef<HTMLIFrameElement>(null);
  const ready = useRef(false);
  const revision = useMirrorRevision(true);
  const time = useThrottledTime();
  const comp = useProjectStore((s) => (s.activeTabId ? s.tabs[s.activeTabId]?.compositionId ?? '' : ''));
  const layers = useSelectionStore((s) => s.ids);
  const keySelection = useKeyframeSelectionStore((s) => s.ids);
  const propSelection = usePropertySelectionStore((s) => s.entries);
  const live = useRef({ comp, layers, time });
  live.current = { comp, layers, time };
  // The panel's editor-wide shortcuts (chord key → binding id), and how long a delivered one
  // lets the panel act as if clicked (runPanelEditorCommand / runPanelScript / files).
  const shortcuts = useRef(new Map<string, string>());
  const grantedUntil = useRef(0);

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

  const pushContext = useCallback(() => {
    const { comp: c, layers: l, time: now } = live.current;
    post(toolPanelContext({ plugin, comp: c, layers: [...l], time: secondsToFlicks(now), ...panelSelection() }));
  }, [plugin, post]);

  const run = useCallback(async (msg: Exclude<ToolPanelMessage, { type: 'ready' } | { type: 'shortcut' }>) => {
    const ok = (result: unknown) => toolPanelReply(msg.id, { ok: true, result });
    if (msg.type === 'settings') return ok(pluginPanelSettings(plugin, msg.set));
    if (msg.type === 'listEditorCommands') return ok({ commands: panelEditorCommands() });
    if (msg.type === 'editorCommand') {
      await runPanelEditorCommand(msg.command, frame.current, grantedUntil.current);
      return ok({});
    }
    if (msg.type === 'runScript') return ok({ value: await runPanelScript(msg.source, msg.name, frame.current, grantedUntil.current) });
    if (msg.type === 'setShortcuts') {
      const { accepted, refused } = acceptPanelShortcuts(msg.shortcuts);
      shortcuts.current = accepted;
      return ok({ refused });
    }
    if (msg.type === 'saveFile') {
      savePanelFile(msg.name, msg.text, frame.current, grantedUntil.current);
      return ok({});
    }
    if (msg.type === 'openFile') return ok(await openPanelFile(msg.accept, frame.current, grantedUntil.current));
    const client = engine();
    if (msg.type === 'query') {
      const res = await client.query(msg.request);
      return res.ok ? toolPanelReply(msg.id, { ok: true, result: res.value }) : toolPanelReply(msg.id, { ok: false, error: res.error.message });
    }
    // One command: an execute (runPluginCommand then logs the plugin's own edits); several: one batch.
    // Either way ONE undo entry, origin `plugin`.
    if (msg.commands.length === 1) {
      const res = await client.execute(msg.commands[0]!, { origin: 'plugin' });
      return res.ok ? toolPanelReply(msg.id, { ok: true, result: res.value }) : toolPanelReply(msg.id, { ok: false, error: res.error.message });
    }
    const res = await client.batch(toolPanelLabel(msg.commands, msg.label, name), msg.commands, { origin: 'plugin' });
    return res.ok ? toolPanelReply(msg.id, { ok: true, result: res.value }) : toolPanelReply(msg.id, { ok: false, error: res.error.message });
  }, [name, plugin]);

  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      // Only this panel's frame; its origin is opaque ('null'), so the source window is the check.
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const msg = parseToolPanelMessage(e.data);
      if (!msg) return;
      if (msg.type === 'ready') {
        ready.current = true;
        pushTheme();
        pushContext();
        return;
      }
      if (msg.type === 'shortcut') {
        runPanelShortcut(msg.action, frame.current);
        return;
      }
      if (msg.type === 'invalid') {
        post(toolPanelReply(msg.id, { ok: false, error: msg.error }));
        return;
      }
      void run(msg).then(post, (err: unknown) => post(toolPanelReply(msg.id, { ok: false, error: err instanceof Error ? err.message : String(err) })));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [pushContext, pushTheme, run, post]);

  // The panel's shortcuts work anywhere in the editor while the panel is open. Capture phase so a
  // binding the editor does not own reaches the panel; acceptPanelShortcuts refused any it owns.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const id = panelShortcutFor(e, shortcuts.current);
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      grantedUntil.current = performance.now() + 2000;
      post({ premation: 1, type: 'invoke', id });
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [post]);

  // Every document change (an edit from anywhere, undo, redo), selection or time change.
  useEffect(() => {
    if (ready.current) pushContext();
  }, [revision, time, comp, layers, keySelection, propSelection, pushContext]);

  return (
    <iframe
      ref={frame}
      title={name}
      src={toolPanelUrl(plugin, page)}
      sandbox={PANEL_SANDBOX}
      referrerPolicy="no-referrer"
      onLoad={pushTheme}
      // No minimum: a short dock (a toolbar strip) must fit the frame, not scroll it.
      style={{ width: '100%', height: '100%', minHeight: 0, border: 'none', background: 'transparent', display: 'block' }}
    />
  );
}

/** The dock renderer for a `plugin:<id>/<panel>` id (panelRenderers.ts, PopoutRoute). */
export function pluginToolPanelRenderer(panelId: string): (() => JSX.Element) | undefined {
  return panelId.startsWith('plugin:') ? () => <PluginToolPanel panelId={panelId} /> : undefined;
}
