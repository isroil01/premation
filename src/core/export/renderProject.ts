/**
 * Which project a render belongs to.
 *
 * Main's export queue is one machine-wide list, so a render carries a key
 * saying where it came from: the editor's Render Queue and Export tabs show the
 * open project's renders, and the dashboard's Renders page shows everything.
 *
 * The key is what stays true across sessions: a cloud project's id or a saved
 * file's path (`ProjectRef.path` holds either). A project that was never saved
 * has neither, so it is keyed by its session id until it is.
 */

import { getProjectManager } from '@core/services/coreServices';
import type { ProjectRef } from '@core/project/ProjectManager';
import { looksLikeFilePath } from '@core/project/projectName';

const UNSAVED_PREFIX = 'session:';

type ProjectIdentity = Pick<ProjectRef, 'id' | 'path'>;

/** The key of an unsaved project. */
function sessionKey(ref: ProjectIdentity): string {
  return `${UNSAVED_PREFIX}${ref.id}`;
}

/** The project open in the editor, or null (none open, or the core is not booted: the dashboard). */
export function currentProjectRef(): ProjectRef | null {
  try {
    return getProjectManager().getState().current;
  } catch {
    return null;
  }
}

/** The open project's key, for stamping a job. */
export function currentProjectKey(): string | undefined {
  const ref = currentProjectRef();
  return ref ? (ref.path ?? sessionKey(ref)) : undefined;
}

/**
 * Does a job with this key belong to `project`?
 *
 * The session key still counts once a project has a path, so a job queued
 * before the first Save stays in that project. With no project open, the jobs
 * nobody can place are the ones shown.
 */
export function belongsToProject(jobKey: string | undefined, project: ProjectIdentity | null): boolean {
  if (!project) return !jobKey;
  return jobKey === project.path || jobKey === sessionKey(project);
}

/** The cloud project id in a key, or null for a file path, an unsaved project or no key. */
export function cloudProjectIdOf(jobKey: string | undefined): string | null {
  if (!jobKey || jobKey.startsWith(UNSAVED_PREFIX) || looksLikeFilePath(jobKey)) return null;
  return jobKey;
}
