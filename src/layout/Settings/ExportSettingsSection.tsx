/**
 * Settings ▸ Export — the desktop encode pipeline.
 *
 * Two preferences, both desktop-only (a browser build has no ffmpeg and
 * shows neither): whether frames stream straight into the encoder as raw
 * RGBA (`exportRawPipe`) and which H.264/HEVC encoder writes an MP4
 * (`exportVideoEncoder`). The encoder chips list only what THIS machine
 * passed a smoke encode with — asked once through `render:probeEncoders`
 * and cached in main — so nobody is offered NVENC on a laptop without an
 * NVIDIA GPU and told at export time that it fell back.
 */

import { useEffect, useState } from 'react';
import { cn } from '@utils/cn';
import { Switch } from '@components/Switch';
import { usePreferenceStore } from '@stores/preferenceStore';
import { canEncodeLocally } from '@core/export/renderSpec';
import { exportSupervisorAvailable } from '@core/export/exportSupervisorClient';
import { VIDEO_ENCODER_LABELS, isVideoEncoderId, type VideoEncoderId } from '@core/export/renderSpec';
import { t } from '@core/i18n';
import styles from './CustomizeDialog.module.css';

/** Hardware encoders main vouched for; null while the probe is still running. */
function useHardwareEncoders(): VideoEncoderId[] | null {
  const [list, setList] = useState<VideoEncoderId[] | null>(null);
  useEffect(() => {
    let live = true;
    const probe = window.motionEditor?.render?.probeEncoders;
    if (!probe) {
      setList([]);
      return undefined;
    }
    probe()
      .then((r) => { if (live) setList(r.hardware.filter(isVideoEncoderId)); })
      .catch(() => { if (live) setList([]); });
    return () => { live = false; };
  }, []);
  return list;
}

export function ExportSettingsSection(): JSX.Element | null {
  const rawPipe = usePreferenceStore((s) => s.exportRawPipe);
  const inProcess = usePreferenceStore((s) => s.exportInProcess);
  const encoder = usePreferenceStore((s) => s.exportVideoEncoder);
  const setPref = usePreferenceStore((s) => s.set);
  const hardware = useHardwareEncoders();
  const supervisor = exportSupervisorAvailable();
  if (!canEncodeLocally()) return null;

  // Software first, then whatever works here. A preference naming an encoder
  // this machine no longer has (a GPU swapped out) still shows, marked, so
  // the user can see why their exports fall back and fix it.
  const choices: VideoEncoderId[] = ['libx264', ...(hardware ?? [])];
  if (!choices.includes(encoder)) choices.push(encoder);

  return (
    <div className={styles.sectionGroup}>
      <div className={styles.sectionHeading}>
        <span className={styles.sectionTitle}>{t('settings.exportPipeline.title', 'Rendering')}</span>
        <span className={styles.hint}>{t('settings.exportPipeline.hint', 'How frames reach the encoder.')}</span>
      </div>

      <div className={styles.settingCard}>
        <div className={styles.switchRow}>
          <div className={styles.settingInfo}>
            <span className={styles.settingTitle}>{t('settings.exportPipeline.rawPipe', 'Stream frames to the encoder')}</span>
            <span className={styles.settingDesc}>
              {t('settings.exportPipeline.rawPipeDesc', 'Encode while rendering. Off writes image files first, which is slower.')}
            </span>
          </div>
          <Switch
            checked={rawPipe}
            onChange={(e) => setPref('exportRawPipe', e.target.checked)}
            aria-label={t('settings.exportPipeline.rawPipe', 'Stream frames to the encoder')}
          />
        </div>

        {supervisor ? (
          <div className={styles.switchRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingTitle}>{t('settings.exportPipeline.inProcess', 'Render exports in the editor window')}</span>
              <span className={styles.settingDesc}>
                {t('settings.exportPipeline.inProcessDesc', 'Off renders in a separate window, so a crash cannot lose the export.')}
              </span>
            </div>
            <Switch
              checked={inProcess}
              onChange={(e) => setPref('exportInProcess', e.target.checked)}
              aria-label={t('settings.exportPipeline.inProcess', 'Render exports in the editor window')}
            />
          </div>
        ) : null}

        <div className={styles.settingRow}>
          <div className={styles.settingInfo}>
            <span className={styles.settingTitle}>{t('settings.exportPipeline.encoder', 'MP4 video encoder')}</span>
            <span className={styles.settingDesc}>
              {hardware === null
                ? t('settings.exportPipeline.encoderDescChecking', 'Hardware is faster and falls back to software. Checking this machine…')
                : hardware.length === 0
                  ? t('settings.exportPipeline.encoderDescNone', 'No working hardware encoder was found here.')
                  : t('settings.exportPipeline.encoderDesc', 'Hardware is faster and falls back to software if it cannot start.')}
            </span>
          </div>
          <div className={styles.segmented} role="radiogroup" aria-label={t('settings.exportPipeline.encoder', 'MP4 video encoder')}>
            {choices.map((id) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={encoder === id}
                className={cn(styles.segItem, encoder === id && styles.segItemActive)}
                onClick={() => setPref('exportVideoEncoder', id)}
                title={hardware && id !== 'libx264' && !hardware.includes(id) ? t('settings.exportPipeline.encoderUnavailable', 'Not available on this machine — exports will use software') : undefined}
              >
                {VIDEO_ENCODER_LABELS[id]}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
