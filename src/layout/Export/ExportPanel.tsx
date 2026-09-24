/**
 * ExportPanel — the Export form, docked (Window ▸ Export, `view.export`).
 *
 * Same form and same choices as the dialog (`exportFormStore`), so a format
 * picked here is the format the top-bar button offers. The point of the
 * panel is to queue renders WHILE working: the timeline stays on screen and
 * nothing here traps focus.
 */

import { Icon } from '@components/Icon';
import { Button } from '@components/Button';
import { useActiveMirrorComp } from '@hooks/useMirror';
import { settingsDurationSeconds, settingsFps } from '@core/mirror/compFacts';
import { ExportForm, useExportModel } from './ExportForm';
import styles from './ExportPanel.module.css';

export function ExportPanel(): JSX.Element {
  // B4: the active composition's settings from the document mirror.
  const settings = useActiveMirrorComp()?.settings;
  const duration = settingsDurationSeconds(settings);
  const fps = settingsFps(settings);
  const { busy, showQueue, outputName, activePreset, doExport, queueJob, serverRender } = useExportModel(duration, fps);

  return (
    <div className={styles.root} data-tour="export-panel">
      <div className={styles.form}>
        <ExportForm duration={duration} fps={fps} host="panel" />
      </div>
      <div className={styles.actions}>
        <span className={styles.fileName} title={outputName}>{outputName}</span>
        <div className={styles.buttons}>
          {serverRender ? (
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<Icon name="upload" size="sm" />}
              onClick={() => void serverRender.run()}
              disabled={busy}
              title="Render on the server from the project's cloud copy"
            >
              Server
            </Button>
          ) : null}
          {showQueue ? (
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<Icon name="queue" size="sm" />}
              onClick={() => queueJob()}
              disabled={busy}
              title="Queue this render in the Render Queue (F6)"
            >
              Add to Queue
            </Button>
          ) : null}
          <Button
            variant="primary"
            size="sm"
            leftIcon={<Icon name="export" size="sm" />}
            onClick={() => void doExport()}
            disabled={busy}
            title={activePreset?.hint}
          >
            {busy ? 'Exporting…' : 'Export'}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default ExportPanel;
