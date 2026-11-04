import { useEffect, useSyncExternalStore } from 'react';
import { useParams } from 'react-router-dom';
import { useLayoutStore } from '@stores/layoutStore';
import { panelDef } from '@layout/EditorLayout/panelDefs';
import { getAllPanelRenderers } from '@layout/EditorLayout/DemoPanels';
import { WorkspaceViewport } from '@layout/Workspace';
import { PopoutTimeline } from '@layout/BottomTimeline/PopoutTimeline';
import { PresentationModeWindow } from '@layout/Presentation/PresentationModeWindow';

import { pluginToolPanelRenderer } from '@layout/Plugins/PluginToolPanel';
import { AiChatProvider } from '@layout/AiChat/AiChatContext';
import { panelIdFromPopoutSegment } from '@core/layout/popoutPath';
import { t } from '@core/i18n';
import { LocaleBoundary } from '@components/LocaleBoundary';
import { pluginContribRevision, pluginPanel, subscribePluginContrib } from '@core/nativePlugins/pluginContrib';
import { EmptyState } from '@components/EmptyState';
import { Providers } from '../providers/Providers';
import styles from './PopoutRoute.module.css';

function PopoutContent(): JSX.Element {
  // The segment is encoded (a plugin panel's id holds a '/': core/layout/popoutPath.ts).
  const { panelId: segment } = useParams<{ panelId: string }>();
  const panelId = segment ? panelIdFromPopoutSegment(segment) : undefined;
  const panels = useLayoutStore((s) => s.panels);
  const panel = panelId ? panels[panelId] : undefined;
  // A plugin panel is named by its manifest, which arrives with the plugin list.
  const contrib = useSyncExternalStore(subscribePluginContrib, pluginContribRevision, pluginContribRevision);

  useEffect(() => {
    const titleMap: Record<string, string> = {
      viewport: t('pages.popout.titleViewport', 'Viewport Preview — Premation'),
      timeline: t('pages.popout.titleTimeline', 'Timeline — Premation'),
      presentation: t('pages.popout.titlePresentation', 'Presentation Mode — Premation'),
    };
    // `panel` comes from the layout store, which is EMPTY in a pop-out window
    // (registerPanel only runs in the editor shell), so this always fell through
    // to the generic "Detached Window". The shared registry knows the real name.
    const name = panel?.title ?? panelDef(panelId ?? '')?.title ?? pluginPanel(panelId ?? '')?.panel.name;
    document.title = titleMap[panelId ?? ''] ?? (name ? t('pages.popout.titlePanel', '{name} — Premation', { name }) : t('pages.popout.titleDetached', 'Detached Window'));

    // The document reaches this window from the engine (windowSync: the page
    // replica refreshes from `exportDocument`, the mirror follows the engine).
  }, [panelId, panel, contrib]);

  // Special full-window pop-outs: Viewport, Timeline, Presentation Mode.
  if (panelId === 'viewport') {
    return (
      <div className={styles.fill}>
        <WorkspaceViewport />
      </div>
    );
  }

  if (panelId === 'timeline') {
    return (
      <div className={styles.fill}>
        <PopoutTimeline />
      </div>
    );
  }

  if (panelId === 'presentation') {
    return <PresentationModeWindow />;
  }

  const renderers = panelId ? getAllPanelRenderers() : {};
  // P7d: a plugin panel resolves by its id even before this window knows the plugin list.
  const renderContent = panelId ? renderers[panelId] ?? pluginToolPanelRenderer(panelId) : undefined;

  return (
    <div className={styles.panel}>
      {/* No header row: the window's title bar names the panel (TitleBar). */}
      <div className={styles.body}>
        {/* The AI panel reads its chat state from <AiChatProvider>, which only
            EditorShell mounts — a popped-out AI panel needs its own. */}
        {renderContent
          ? (panelId === 'ai' ? <AiChatProvider>{renderContent()}</AiChatProvider> : renderContent())
          : (
            <EmptyState
              icon="pop-out"
              title={t('pages.popout.unavailableTitle', 'Nothing to show here')}
              message={t('pages.popout.unavailable', 'This panel is not available in a separate window.')}
              // Closing the window docks the panel back (EditorLayout/popoutWindows).
              action={{ label: t('pages.popout.dockBack', 'Dock Back'), onClick: () => void (window.electronAPI?.window?.close?.() ?? window.close()) }}
            />
          )}
      </div>
    </div>
  );
}

export function PopoutRoute(): JSX.Element {
  return (
    <Providers>
      <LocaleBoundary>
        <PopoutContent />
      </LocaleBoundary>
    </Providers>
  );
}
