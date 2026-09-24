/**
 * The name of the composition the user is looking at — one answer, for every
 * piece of chrome that prints it (the status bar's comp chip, the viewer tab).
 *
 * The status bar used to print the active TAB's `title`. A tab's title is set
 * when the tab is minted ("Main Comp") and nothing renames it, so after
 * Composition Settings ▸ rename, or after adopting the scaffolding comp as
 * "Comp 2", the bar went on saying "Main Comp" beside a timeline and a Project
 * list that both said otherwise. The composition's own record is the source;
 * the tab title is only the last resort for a tab whose comp is not (yet) in
 * the store.
 */

import { useProjectStore } from '@stores/projectStore';
import { useActiveMirrorComp } from '@hooks/useMirror';

interface ProjectNameState {
  activeTabId: string | null | undefined;
  tabs: Record<string, { compositionId: string; title: string } | undefined>;
  comps: Record<string, { name: string } | undefined>;
}

/**
 * Pure resolver. `liveName` is the composition store's name — the record the
 * settings dialog writes first, so a rename shows before the project store's
 * copy catches up.
 */
export function resolveActiveCompName(project: ProjectNameState, liveName?: string): string | undefined {
  const tab = project.activeTabId ? project.tabs[project.activeTabId] : undefined;
  if (!tab) return liveName?.trim() || undefined;
  const recorded = project.comps[tab.compositionId]?.name?.trim();
  // `updateComp` auto-creates a missing record as `name: id`; an id is not a
  // name anybody should read in the chrome.
  const fromComp = recorded && recorded !== tab.compositionId ? recorded : undefined;
  return fromComp || liveName?.trim() || tab.title?.trim() || undefined;
}

/** The active composition's name, live across rename and tab switch. */
export function useActiveCompName(): string | undefined {
  // B4: the active composition's own name from the document mirror.
  const liveName = useActiveMirrorComp()?.settings.name;
  return useProjectStore((s) => resolveActiveCompName(s, liveName));
}
