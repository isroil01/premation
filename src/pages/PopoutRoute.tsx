import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useLayoutStore } from '@stores/layoutStore';
import { syncChannel } from '@core/layout/syncChannel';
import { PanelHeader } from '@layout/EditorLayout/PanelHeader';
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
    document.title = titleMap[panelId ?? ''] ?? (panel ? `${panel.title} — Motion Editor` : 'Detached Window');

    // Subscribe to state sync bus to keep stores synchronized in pop-out window
    const unsubTime = syncChannel.subscribe('time-update', (_payload: unknown) => {
      // Synchronize playhead time
    });

    const unsubSelection = syncChannel.subscribe('selection-update', (_payload: unknown) => {
      // Synchronize selection
    });

    return () => {
      unsubTime();
      unsubSelection();
    };
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
      <PanelHeader panelId={panelId} title={panel?.title ?? panelId} icon={panel?.icon} closable={false} />
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
