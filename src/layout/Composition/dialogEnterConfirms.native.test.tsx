/**
 * Enter runs a dialog's primary action (Modal.tsx: "Enter anywhere in a dialog").
 *
 * The Modal finds it through `useDialogPrimaryAction`, a `DialogFooter`, or the
 * footer chrome. A form dialog that lays its buttons in its own <div> has none of
 * them, and Enter did nothing: nothing fails, the key is just dead.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { readSource } from '@/__testHelpers__/readSource';
import { TooltipProvider } from '@components/Tooltip';
import { setupAppEngine, settleEdits, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { activeCompRootId } from '@core/scene/activeComp';
import { ModalHost } from '@layout/overlays';
import { openCameraDialog } from '@layout/Workspace/SceneInsertDialogs';
import { documentMirror } from '@stores/documentMirror';
import { useModalStore } from '@stores/modalStore';

/** The form dialogs with their own footer <div>. */
const OWN_FOOTER = [
  'layout/Timeline/KeyframeVelocityDialog.tsx',
  'layout/Timeline/TransitionSettingsDialog.tsx',
  'layout/Assets/AssembleDialog.tsx',
  'layout/Assets/InterpretFootageModal.tsx',
  'layout/Inspector/DuckingDialog.tsx',
  'layout/Inspector/SilenceRemovalDialog.tsx',
  'layout/Workspace/SceneInsertDialogs.tsx',
];

describe('Enter confirms a dialog', () => {
  it.each(OWN_FOOTER)('%s registers its primary action', (file) => {
    expect(readSource(file)).toMatch(/useDialogPrimaryAction\(/);
  });

  describe('in the running dialog', () => {
    let h: Harness;
    beforeEach(async () => {
      h = await setupAppEngine({ panels: true });
      useModalStore.setState({ stack: [] });
    });
    afterEach(async () => {
      useModalStore.setState({ stack: [] });
      await h.dispose();
    });

    it('New Camera: Enter in its form creates the camera, once, and closes', async () => {
      render(<TooltipProvider><ModalHost /></TooltipProvider>);
      act(() => openCameraDialog());
      const comp = activeCompRootId() as string;
      const before = documentMirror().comp(comp)?.layers.length ?? 0;
      const input = (await screen.findAllByRole('textbox'))[0]!;
      await act(async () => {
        fireEvent.keyDown(input, { key: 'Enter' });
        await settleEdits();
      });
      expect(documentMirror().comp(comp)?.layers.length).toBe(before + 1);
      expect(useModalStore.getState().stack).toHaveLength(0);
    });
  });
});
