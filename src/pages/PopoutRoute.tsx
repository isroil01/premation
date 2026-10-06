import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useLayoutStore } from '@stores/layoutStore';
import { panelDef } from '@layout/EditorLayout/panelDefs';
import { getAllPanelRenderers } from '@layout/EditorLayout/DemoPanels';
import { WorkspaceViewport } from '@layout/Workspace';
import { PopoutTimeline } from '@layout/BottomTimeline/PopoutTimeline';
import { PresentationModeWindow } from '@layout/Presentation/PresentationModeWindow';

import { Providers } from '../providers/Providers';

function PopoutContent(): JSX.Element {
  const { panelId } = useParams<{ panelId: string }>();
  const panels = useLayoutStore((s) => s.panels);
  const panel = panelId ? panels[panelId] : undefined;

  useEffect(() => {
    const titleMap: Record<string, string> = {
      viewport: 'Viewport Preview — Premation',
      timeline: 'Timeline — Premation',
      presentation: 'Presentation Mode — Premation',
    };
    // `panel` comes from the layout store, which is EMPTY in a pop-out window
    // (registerPanel only runs in the editor shell), so this always fell through
    // to the generic "Detached Window". The shared registry knows the real name.
    const name = panel?.title ?? panelDef(panelId ?? '')?.title;
    document.title = titleMap[panelId ?? ''] ?? (name ? `${name} — Premation` : 'Detached Window');

    // The document reaches this window from the engine (windowSync: the page
    // replica refreshes from `exportDocument`, the mirror follows the engine).
  }, [panelId, panel]);

  if (!panelId) {
    return <div style={{ color: '#fff', padding: 20 }}>No panel ID specified.</div>;
  }

  // Handle special full-screen popout types: Viewport, Timeline, Presentation Mode
  if (panelId === 'viewport') {
    return (
      <div style={{ width: '100%', height: '100%', background: '#121213', overflow: 'hidden' }}>
        <WorkspaceViewport />
      </div>
    );
  }

  if (panelId === 'timeline') {
    return (
      <div style={{ width: '100%', height: '100%', background: '#121213', overflow: 'hidden' }}>
        <PopoutTimeline />
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
        width: '100%',
        height: '100%',
        background: 'var(--color-surface-1, #121213)',
        color: 'var(--color-text-primary)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* No header row: the window's title bar names the panel (TitleBar). */}
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
