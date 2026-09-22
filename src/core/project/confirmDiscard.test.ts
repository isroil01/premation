/**
 * The unsaved-changes prompt: whose changes, and what you can do about them.
 *
 * WHY THIS EXISTS. Two reproduced bugs. The prompt named the active workspace
 * TAB — a composition — so closing a project called "qa1" asked about
 * “Main Comp”. And it could only ask yes-or-no, so it offered Cancel and
 * "Discard and continue": the thing a person closing a dirty project usually
 * wants, keeping the work, was not on the dialog.
 */

import type { SaveChoice } from '@components/Modal/Dialogs';

const customSaveChoice = jest.fn<Promise<SaveChoice>, [string, string]>();
jest.mock('@components/Modal/Dialogs', () => ({
  customSaveChoice: (title: string, message: string) => customSaveChoice(title, message),
}));

let currentName: string | null = 'qa1';
jest.mock('@core/services/coreServices', () => ({
  tryCoreServices: () => ({
    project: { getState: () => ({ current: currentName ? { id: 'p', name: currentName, path: null } : null }) },
  }),
}));

const execute = jest.fn<Promise<void>, [string]>();
jest.mock('@core/commands/CommandSystem', () => ({
  getCommandSystem: () => ({ execute: (id: string) => execute(id) }),
}));

import { confirmDiscardChanges, SAVE_COMMAND } from './confirmDiscard';
import { useProjectStore } from '@stores/projectStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { ProjectCommands } from '@layout/Menu/menuModel';

function setDirty(dirty: boolean): void {
  const s = useProjectStore.getState();
  if (s.activeTabId) s.actions.markDirty(s.activeTabId, dirty);
}

beforeEach(() => {
  customSaveChoice.mockReset();
  execute.mockReset();
  currentName = 'qa1';
  usePreferenceStore.getState().set('confirmOnClose', true);
  setDirty(true);
});

describe('confirmDiscardChanges', () => {
  it('names the PROJECT, not the active composition tab', async () => {
    customSaveChoice.mockResolvedValue('cancel');
    await confirmDiscardChanges('Close the project');
    const message = customSaveChoice.mock.calls[0]![1];
    expect(message).toContain('“qa1” has unsaved changes.');
    const s = useProjectStore.getState();
    const tabTitle = s.activeTabId ? s.tabs[s.activeTabId]?.title : undefined;
    if (tabTitle && tabTitle !== 'qa1') expect(message).not.toContain(tabTitle);
    // ...and says what is about to happen, mid-sentence.
    expect(message).toContain('before you close the project?');
  });

  it('does not invent a name for a scratch scene that was never a project', async () => {
    currentName = null;
    customSaveChoice.mockResolvedValue('cancel');
    await confirmDiscardChanges('Create a new project');
    expect(customSaveChoice.mock.calls[0]![1]).toContain('This project has unsaved changes.');
  });

  it('Cancel stops the caller; Don’t Save lets it go ahead without saving', async () => {
    customSaveChoice.mockResolvedValueOnce('cancel');
    expect(await confirmDiscardChanges('Close the project')).toBe(false);

    customSaveChoice.mockResolvedValueOnce('discard');
    expect(await confirmDiscardChanges('Close the project')).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it('Save runs the real Save command, and proceeds once it has landed', async () => {
    customSaveChoice.mockResolvedValue('save');
    execute.mockImplementation(async () => setDirty(false));
    expect(await confirmDiscardChanges('Close the project')).toBe(true);
    expect(execute).toHaveBeenCalledWith(SAVE_COMMAND);
  });

  it('Save that did NOT land — dialog cancelled, write failed — must not go on to discard', async () => {
    customSaveChoice.mockResolvedValue('save');
    execute.mockResolvedValue(undefined); // the tab stays dirty
    expect(await confirmDiscardChanges('Close the project')).toBe(false);
  });

  it('asks nothing when there is nothing to lose, or the preference is off', async () => {
    setDirty(false);
    expect(await confirmDiscardChanges('Close the project')).toBe(true);
    setDirty(true);
    usePreferenceStore.getState().set('confirmOnClose', false);
    expect(await confirmDiscardChanges('Close the project')).toBe(true);
    expect(customSaveChoice).not.toHaveBeenCalled();
  });

  it('points at the same command id the File menu does', () => {
    expect(SAVE_COMMAND).toBe(ProjectCommands.Save);
  });
});
