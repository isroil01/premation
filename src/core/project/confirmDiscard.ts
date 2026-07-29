/**
 * The guard in front of anything that throws away unsaved work.
 *
 * `confirmOnClose` has shipped as a preference — default ON, offered in two
 * separate settings surfaces, described as "Ask for confirmation when a
 * New/Open/Close would throw away unsaved work" — while nothing anywhere read
 * it. New Project, Open and Close each replaced the document outright, with no
 * prompt, at Cmd+N/Cmd+O reach of a mis-key. A setting that promises to protect
 * work and doesn't is worse than no setting: it is why the user didn't save.
 *
 * Everything destructive routes through here.
 */

import { useProjectStore } from '@stores/projectStore';
import { usePreferenceStore } from '@stores/preferenceStore';

/** True when the active document has edits that are not on disk / in the cloud. */
export function hasUnsavedChanges(): boolean {
  const { tabs, activeTabId } = useProjectStore.getState();
  if (!activeTabId) return false;
  return tabs[activeTabId]?.dirty === true;
}

/**
 * Ask before discarding, and answer whether to go ahead.
 *
 * Returns true when the caller should proceed: nothing to lose, the preference
 * is off, or the user confirmed. `action` is the verb shown to them
 * ("Create a new project"), so the prompt names what is about to happen rather
 * than asking an abstract "are you sure?".
 *
 * `window.confirm` deliberately: it is modal to the whole renderer, so it
 * cannot be dismissed by the very keyboard shortcut that triggered it, and it
 * cannot render behind the modal host. The cost is styling, on a dialog that
 * should be seen a handful of times a year.
 */
export function confirmDiscardChanges(action: string): boolean {
  if (!hasUnsavedChanges()) return true;
  if (!usePreferenceStore.getState().confirmOnClose) return true;

  const { tabs, activeTabId } = useProjectStore.getState();
  const name = (activeTabId && tabs[activeTabId]?.title) || 'this project';

  return window.confirm(
    `“${name}” has unsaved changes.\n\n${action} anyway? Your unsaved work will be lost.`,
  );
}
