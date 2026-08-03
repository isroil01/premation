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
import { customConfirm } from '@components/Modal/Dialogs';

/** True when the active document has edits that are not on disk / in the cloud. */
export function hasUnsavedChanges(): boolean {
  const { tabs, activeTabId } = useProjectStore.getState();
  if (!activeTabId) return false;
  return tabs[activeTabId]?.dirty === true;
}

/**
 * True while a discard prompt is on screen.
 *
 * The old `window.confirm` was modal to the entire renderer, so the chord that
 * opened it (Cmd+N / Cmd+O) could not fire again while it was up. `customConfirm`
 * is an in-app modal and does NOT block the ShortcutManager, so mashing Cmd+N
 * would stack a dialog per press — and answering one would leave the rest
 * orphaned on screen. Answering "no" to a second, concurrent request is the
 * conservative choice: it declines to throw work away.
 *
 * Deduping on a fixed modal id instead would drop the earlier entry without
 * running its `onClose`, leaving its promise permanently unresolved.
 */
let discardPromptOpen = false;

/**
 * Ask before discarding, and answer whether to go ahead.
 *
 * Resolves true when the caller should proceed: nothing to lose, the preference
 * is off, or the user confirmed. `action` is the verb shown to them
 * ("Create a new project"), so the prompt names what is about to happen rather
 * than asking an abstract "are you sure?".
 *
 * ASYNC because it renders the app's own modal rather than a native dialog —
 * native `confirm` blocks the renderer thread and ignores app chrome, and
 * `window.prompt`, its sibling, does not exist in Electron at all. Callers must
 * await; `Command.execute` already returns `void | Promise<void>`.
 */
export async function confirmDiscardChanges(action: string): Promise<boolean> {
  if (!hasUnsavedChanges()) return true;
  if (!usePreferenceStore.getState().confirmOnClose) return true;
  if (discardPromptOpen) return false;

  const { tabs, activeTabId } = useProjectStore.getState();
  const name = (activeTabId && tabs[activeTabId]?.title) || 'this project';

  discardPromptOpen = true;
  try {
    return await customConfirm(
      'Unsaved changes',
      `“${name}” has unsaved changes.\n\n${action} anyway? Your unsaved work will be lost.`,
      { confirmLabel: 'Discard and continue', isDanger: true },
    );
  } finally {
    discardPromptOpen = false;
  }
}
