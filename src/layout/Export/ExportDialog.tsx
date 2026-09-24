/**
 * ExportDialog — the Export form as a modal, for the top-bar button.
 *
 * The form, its preview and its actions live in `ExportForm.tsx` and are
 * shared with the docked Export panel; this file only puts them in a dialog
 * with a `DialogFooter` (output name as the note, Add to Queue as the
 * secondary, Export as the primary — which is what Enter runs).
 */

import { Icon } from '@components/Icon';
import { Button } from '@components/Button';
import { DialogFooter } from '@components/Modal';
import { openModal } from '@stores/modalStore';
import { documentMirror } from '@stores/documentMirror';
import { activeCompIdNow } from '@hooks/useMirror';
import { ExportForm, useExportModel } from './ExportForm';
import styles from './ExportDialog.module.css';

function ExportDialogFooter({ duration, fps, onClose }: { duration: number; fps: number; onClose: () => void }): JSX.Element {
  const { busy, showQueue, outputName, activePreset, doExport, queueJob, serverRender } = useExportModel(duration, fps);
  return (
    <DialogFooter
      note={
        <span className={styles.fileMeta} title={outputName}>
          <Icon name="export" size="sm" />
          <span className={styles.fileName}>{outputName}</span>
        </span>
      }
      secondary={
        showQueue || serverRender ? (
          <>
            {serverRender ? (
              <Button
                variant="secondary"
                size="md"
                leftIcon={<Icon name="upload" size="sm" />}
                onClick={() => {
                  // The render runs on the server from the cloud copy of the
                  // project; the job tray follows it. Nothing left to show here.
                  void serverRender.run();
                  onClose();
                }}
                disabled={busy}
                title="Render this composition on the server from its cloud copy — keeps going after you close the app"
              >
                {serverRender.label}
              </Button>
            ) : null}
            {showQueue ? (
              <Button
                variant="secondary"
                size="md"
                leftIcon={<Icon name="queue" size="sm" />}
                onClick={() => {
                  // Close the modal: it used to open the Render Queue panel
                  // BEHIND itself and toast about a panel the user could not see.
                  if (queueJob()) onClose();
                }}
                disabled={busy}
                title="Queue this render in the Render Queue (F6) instead of exporting now"
              >
                Add to Queue
              </Button>
            ) : null}
          </>
        ) : undefined
      }
      primary={
        <Button
          variant="primary"
          size="md"
          leftIcon={<Icon name="export" size="sm" />}
          onClick={() => void doExport()}
          disabled={busy}
          title={activePreset?.hint}
        >
          {busy ? 'Exporting…' : 'Export'}
        </Button>
      }
    />
  );
}

/** Open the export dialog as a modal. */
export function openExportDialog(duration: number, fps: number): void {
  const name = documentMirror().comp(activeCompIdNow() ?? '')?.settings.name?.trim() || 'Composition';
  openModal({
    id: 'export-dialog',
    title: 'Export composition',
    description: name,
    size: 'lg',
    // Persistent: Esc / a backdrop click used to unmount the dialog. A running
    // export now lives in `exportFormStore` and survives the dialog closing
    // (the job tray keeps showing it), but a reflex keypress should still not
    // take the form away from someone mid-choice.
    persistent: true,
    render: () => <ExportForm duration={duration} fps={fps} host="modal" />,
    footer: (close) => <ExportDialogFooter duration={duration} fps={fps} onClose={close} />,
  });
}
