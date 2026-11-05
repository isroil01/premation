/**
 * Which routed project the editor is SHOWING — the one whose document the
 * engine holds and the document mirror reflects.
 *
 * WHY THIS EXISTS. The editor shell mounts as soon as the engine is up, and the
 * routed project (`#/editor/<id>`) opens only after that: its document is
 * fetched, opened by the engine, and the mirror refetches. For that whole wait
 * the shell drew whatever the engine still held:
 *
 *   - first entry: the engine's boot document — one pristine empty comp — so
 *     the workspace showed its empty-composition cards between the loading
 *     screen and the project;
 *   - re-entry (project A, back to the dashboard, project B): the engine
 *     process and the mirror outlive the editor route, so the viewer, timeline
 *     and layers showed project A until B landed.
 *
 * The page cannot tell either case from the mirror alone ("0 layers" is also a
 * real empty project, and A's layers are a real document), so the open says
 * when it is done: `ProjectLoader` marks the project shown once the engine has
 * opened it, the mirror has caught up and its one-shot setup (a parked video, a
 * Library item) has landed, and the editor keeps its loading screen up until
 * the routed project is the shown one. Leaving the editor clears the mark, so
 * nothing of the previous project is ever revealed under the next one's route.
 *
 * Session state, never in the document. No React here beyond the store.
 */

import { create } from 'zustand';

export interface ProjectOpenState {
  /** The routed project the editor shows; null while none is (or one is still opening). */
  shownProjectId: string | null;
}

export const useProjectOpenStore = create<ProjectOpenState>(() => ({ shownProjectId: null }));

/** The routed project is open and in the mirror (an id), or the editor left / started another open (null). */
export function markProjectShown(projectId: string | null): void {
  if (useProjectOpenStore.getState().shownProjectId !== projectId) useProjectOpenStore.setState({ shownProjectId: projectId });
}

/**
 * Whether the editor must keep its loading screen over the workspace: the
 * route names a project that is not the one shown yet. No routed project (the
 * local edition's plain `/editor`) never waits — its start screen covers the
 * no-project state, and every open there resolves only after the mirror has
 * the new document.
 */
export function projectOpenPending(routeProjectId: string | null | undefined, shownProjectId: string | null): boolean {
  return !!routeProjectId && routeProjectId !== shownProjectId;
}
