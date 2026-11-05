/**
 * EditorPage — the routed editor at /editor/:projectId. It mounts the full
 * editor (Providers boots the engine, EditorShell is the UI) and, once booted,
 * loads the requested cloud project's document into the running editor.
 *
 * ProjectLoader is a child of Providers, so it only mounts after the engine is
 * ready (Providers gates its children behind a loading screen) — meaning
 * restoreDocument runs against a live scene graph.
 */

import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Providers } from '@providers/Providers';
import { CloudThumbnailWorker } from '../components/CloudThumbnailWorker';
import { LocalThumbnailWorker } from '../components/LocalThumbnailWorker';
import { CloudAutosave } from '../components/CloudAutosave';
import { ReadOnlyBanner } from '../components/ReadOnlyBanner';
import { ClaudeActivityBadge } from '../components/ClaudeActivityBadge';
import { t } from '@core/i18n';
import { LocaleBoundary } from '@components/LocaleBoundary';
import { ProjectLoader } from './ProjectLoader';
import { ProjectOpenGate } from './ProjectOpenGate';

/**
 * Persists edits to the bound cloud project. Debounces the editor's change
 * events and PUTs the whole document to /projects/:id/autosave (which bumps the
 * revision and keeps a rolling snapshot). Armed after a short settle so the
 * project's own load doesn't immediately re-save it.
 */
// Imported CloudAutosave component replaces the inline implementation

/**
 * Keeps the project's poster frame current.
 *
 * Deliberately NOT on the autosave beat: that fires ~1.2s after every edit, and
 * rendering plus uploading a frame that often would cost far more than a card
 * picture is worth. Instead it rides the same change events but at a floor of
 * two minutes, and takes one final frame when you leave the editor — so the
 * card reflects where you actually stopped.
 *
 * Failure is silent by design. A missing preview costs the user a nice
 * thumbnail; an error toast about one costs them their attention.
 */
// CloudThumbnail removed; using worker component instead

import { Suspense, lazy } from 'react';
import { LoadingScreen } from '@components/LoadingScreen';
import { StartScreen } from '@layout/Start/StartScreen';
import { useStartScreenVisible } from '@layout/Start/useStartScreenVisible';
import { AboutCommandInstaller } from '@layout/Help/AboutDialog';
import { setStartScreenVisible } from '@stores/onboardingStore';
import { cloudProjectsEnabled } from '@core/config/edition';

const LazyEditorShell = lazy(() => import('../App').then(m => ({ default: m.EditorShell })));

/**
 * The local edition's start screen, over the booted editor.
 *
 * Shown when there is no current project — which at boot is always, since
 * nothing creates one until the user does. The cloud edition has the dashboard
 * for this and never mounts it.
 *
 * Dismissal is session state, not a preference: closing it means "not now",
 * and a user who returns to an empty editor next launch should be offered
 * their recents again rather than having silently opted out forever.
 *
 * Visibility FOLLOWS the project manager (see `useStartScreenVisible`). It was
 * read once at mount and cleared only by the screen's own buttons, so a
 * project opened any other way — Ctrl+O, File ▸ Open, a crash-recovery
 * Restore — loaded behind it and stayed hidden until the user found
 * "Continue without a project".
 */
function LocalStart(): JSX.Element | null {
  const { visible, dismiss } = useStartScreenVisible(!cloudProjectsEnabled());
  // The onboarding tour must not auto-start behind this screen; tell the
  // store while it is up and again when it goes (dismissal or unmount).
  useEffect(() => {
    setStartScreenVisible(visible);
    return () => setStartScreenVisible(false);
  }, [visible]);
  if (!visible) return null;
  return <StartScreen onDismiss={dismiss} />;
}

export function EditorPage(): JSX.Element {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <Providers>
      <Suspense fallback={<LoadingScreen message={t('pages.editor.loading', 'Loading editor…')} />}>
        {projectId ? <ProjectLoader projectId={projectId} /> : null}
        {projectId ? <CloudAutosave projectId={projectId} /> : null}
        {projectId ? <CloudThumbnailWorker projectId={projectId} /> : null}
        {/* The local edition's thumbnail capture — same policy, disk sink.
            Mounted for the whole session; it resolves the current bundle per
            capture and no-ops without one (or without a desktop bridge). */}
        {!cloudProjectsEnabled() ? <LocalThumbnailWorker /> : null}
        {/* Help ▸ About, registered after boot so it replaces the stale copy —
            see AboutCommandInstaller for why it has to be in here. */}
        <AboutCommandInstaller />
        {/*
          The read-only bar sits ABOVE the shell in a flex column so it pushes the
          editor down rather than floating over the canvas — a locked document is
          still a document the user needs to see all of. It renders nothing when
          the account can write (and always in the local edition), so this column
          is a plain full-height editor in the common case.
        */}
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
          <ReadOnlyBanner />
          <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
            {/* Only the views: Providers and the project loaders above stay mounted. */}
            <LocaleBoundary>
              <LazyEditorShell />
            </LocaleBoundary>
            {/* Over the shell until the routed project is the one it shows:
                never the boot document's empty cards, never the last project. */}
            <ProjectOpenGate projectId={projectId} />
            <LocalStart />
            {/* Claude for Premation: runs the calls an MCP client sends, and
                says so while it does (docs/MCP_PLAN.md). */}
            <ClaudeActivityBadge />
          </div>
        </div>
      </Suspense>
    </Providers>
  );
}

export default EditorPage;
