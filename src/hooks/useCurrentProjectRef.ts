import { useEffect, useState } from 'react';
import { getProjectManager, tryCoreServices } from '@core/services/coreServices';
import { currentProjectRef } from '@core/export/renderProject';
import type { ProjectRef } from '@core/project/ProjectManager';

/** The project open in the editor, following opens, saves and closes. */
export function useCurrentProjectRef(): ProjectRef | null {
  const [project, setProject] = useState<ProjectRef | null>(currentProjectRef);
  useEffect(() => {
    setProject(currentProjectRef());
    // Not booted: the core's project manager does not exist yet.
    if (!tryCoreServices()) return undefined;
    return getProjectManager().subscribe((s) => setProject(s.current));
  }, []);
  return project;
}
