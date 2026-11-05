/**
 * The loading screen over the editor while the routed project opens.
 *
 * The workspace stays MOUNTED underneath (the lazy shell, its panels and the
 * viewer's GPU setup are not free, and the open's own follow-up steps — the
 * parked video, a Library item — run against it); this only keeps it out of
 * sight until the project the route names is the one the engine and the mirror
 * hold (`projectOpenStore`). Without it the shell showed the engine's previous
 * document for the whole open: the empty-composition cards on a first entry,
 * the last project's viewer, timeline and layers on a re-entry.
 *
 * One React render when the open finishes; nothing per frame.
 */

import { LoadingScreen } from '@components/LoadingScreen';
import { projectOpenPending, useProjectOpenStore } from '@stores/projectOpenStore';
import { t } from '@core/i18n';

export function ProjectOpenGate({ projectId }: { projectId: string | null | undefined }): JSX.Element | null {
  const pending = useProjectOpenStore((s) => projectOpenPending(projectId, s.shownProjectId));
  if (!pending) return null;
  // The line reads the boot's 'project' stage, which ProjectLoader holds open for the open.
  return <LoadingScreen message={t('pages.editor.loading', 'Loading editor…')} />;
}
