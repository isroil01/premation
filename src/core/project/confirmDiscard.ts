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
import { customSaveChoice } from '@components/Modal/Dialogs';
import { tryCoreServices } from '@core/services/coreServices';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { asCommandId } from '@app-types/common';

/**
 * `ProjectCommands.Save`, by value: the menu model lives in the layout layer,
 * which this module must not import. `confirmDiscard.test` pins the two equal.
 */
export const SAVE_COMMAND = 'project.save';

/**
 * The name to put in the prompt.
 *
 * This read the active workspace TAB's title, which is the composition's — so
 * closing a project called "qa1" asked about “Main Comp”. The project's name
 * lives on the ProjectManager; a scratch scene that was never made a project
 * has none, and says so rather than borrowing a comp's.
 */
function projectSubject(): string {
  const name = tryCoreServices()?.project.getState().current?.name;
  return name ? `“${name}”` : 'This project';
}

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

/** "Close the project" → "close the project", for use mid-sentence. */
function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * Ask before discarding, and answer whether to go ahead.
 *
 * Resolves true when the caller should proceed: nothing to lose, the preference
 * is off, the user chose Don't Save, or they chose Save AND the save landed.
 * `action` is the verb shown to them ("Create a new project"), so the prompt
 * names what is about to happen rather than asking an abstract "are you sure?".
 *
 * Save runs the real Save command rather than `ProjectManager.save()`: the
 * command owns the browser's portable-file fallback, the toasts and the
 * dirty/recovery bookkeeping, and none of that should exist twice. Whether it
 * worked is read back from the dirty flag — a cancelled Save As dialog or a
 * failed write leaves it set, and then the answer is NO: the user asked to
 * keep their work, so the caller must not go on to destroy it.
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

  discardPromptOpen = true;
  try {
    const choice = await customSaveChoice(
      'Unsaved changes',
      `${projectSubject()} has unsaved changes.\n\nSave them before you ${lowerFirst(action)}?`,
    );
    if (choice === 'cancel') return false;
    if (choice === 'discard') return true;
    await getCommandSystem().execute(asCommandId(SAVE_COMMAND));
    return !hasUnsavedChanges();
  } finally {
    discardPromptOpen = false;
  }
}
