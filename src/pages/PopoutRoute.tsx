import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useLayoutStore } from '@stores/layoutStore';
import { requestDocumentSync } from '@core/layout/windowSync';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { PanelHeader } from '@layout/EditorLayout/PanelHeader';
import { panelDef } from '@layout/EditorLayout/panelDefs';
import { getAllPanelRenderers } from '@layout/EditorLayout/DemoPanels';
import { WorkspaceViewport } from '@layout/Workspace';
import { Timeline, type TimelineModel } from '@layout/Timeline';
import { PresentationModeWindow } from '@layout/Presentation/PresentationModeWindow';

import { Providers } from '../providers/Providers';

function PopoutContent(): JSX.Element {
  const { panelId } = useParams<{ panelId: string }>();
  const panels = useLayoutStore((s) => s.panels);
  const panel = panelId ? panels[panelId] : undefined;

  useEffect(() => {
    const titleMap: Record<string, string> = {
      viewport: 'Viewport Preview — Motion Editor',
      timeline: 'Timeline — Motion Editor',
      presentation: 'Presentation Mode — Motion Editor',
    };
    // `panel` comes from the layout store, which is EMPTY in a pop-out window
    // (registerPanel only runs in the editor shell), so this always fell through
    // to the generic "Detached Window". The shared registry knows the real name.
    const name = panel?.title ?? panelDef(panelId ?? '')?.title;
    document.title = titleMap[panelId ?? ''] ?? (name ? `${name} — Motion Editor` : 'Detached Window');

    // Ask the editor shell for the live document. `startWindowSync` (mounted by
    // Providers, above this component) owns the subscriptions that apply it and
    // keep selection/playhead in step; this window only has to announce itself.
    //
    // Retry briefly: the shell answers on its own event loop and this window may
    // finish booting first. Stops as soon as a document lands.
    let attempts = 0;
    requestDocumentSync();
    const poll = window.setInterval(() => {
      attempts += 1;
      const hasContent = defaultSceneGraph.getRoots().length > 0;
      if (hasContent || attempts > 10) {
        window.clearInterval(poll);
        return;
      }
      requestDocumentSync();
    }, 250);

    return () => window.clearInterval(poll);
  }, [panelId, panel]);

  if (!panelId) {
    return <div style={{ color: '#fff', padding: 20 }}>No panel ID specified.</div>;
  }

  // Handle special full-screen popout types: Viewport, Timeline, Presentation Mode
  if (panelId === 'viewport') {
    return (
      <div style={{ width: '100vw', height: '100vh', background: '#121213', overflow: 'hidden' }}>
        <WorkspaceViewport />
      </div>
    );
  }

  if (panelId === 'timeline') {
    const emptyModel: TimelineModel = {
      tracks: [],
      markers: [],
      duration: 10,
      currentTime: 0,
      frameRate: 30,
      pixelsPerSecond: 100,
    };
    return (
      <div style={{ width: '100vw', height: '100vh', background: '#121213', overflow: 'hidden' }}>
        <Timeline model={emptyModel} />
      </div>
    );
  }

  if (panelId === 'presentation') {
    return <PresentationModeWindow />;
  }

  const renderers = getAllPanelRenderers();
  const renderContent = renderers[panelId];

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        background: 'var(--color-surface-1, #121213)',
        color: '#ffffff',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <PanelHeader panelId={panelId} title={panel?.title ?? panelDef(panelId)?.title ?? panelId} icon={panel?.icon ?? panelDef(panelId)?.icon} closable={false} isPopout />
      <div style={{ flex: 1, overflow: 'auto', position: 'relative' }}>
        {renderContent ? renderContent() : <div style={{ padding: 20 }}>Panel Content ({panelId})</div>}
      </div>
    </div>
  );
}

export function PopoutRoute(): JSX.Element {
  return (
    <Providers>
      <PopoutContent />
    </Providers>
  );
}
