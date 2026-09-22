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
import { canEncodeLocally } from '@core/export/videoSink';
import { exportSupervisorAvailable } from '@core/export/exportSupervisorClient';
import { VIDEO_ENCODER_LABELS, isVideoEncoderId, type VideoEncoderId } from '@core/export/rawPipe';
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
        <span className={styles.sectionTitle}>Export Pipeline</span>
        <span className={styles.hint}>How rendered frames reach the video encoder on this machine.</span>
      </div>

      <div className={styles.settingCard}>
        <div className={styles.switchRow}>
          <div className={styles.settingInfo}>
            <span className={styles.settingTitle}>Stream frames to the encoder</span>
            <span className={styles.settingDesc}>
              Pipe raw RGBA straight into ffmpeg and encode while the composition renders.
              Off stages every frame as an image file first — slower, and MP4/WebM lose a JPEG generation.
            </span>
          </div>
          <Switch
            checked={rawPipe}
            onChange={(e) => setPref('exportRawPipe', e.target.checked)}
            aria-label="Stream frames to the encoder"
          />
        </div>

        {supervisor ? (
          <div className={styles.switchRow}>
            <div className={styles.settingInfo}>
              <span className={styles.settingTitle}>Render exports in the editor window</span>
              <span className={styles.settingDesc}>
                Off: each export renders in a hidden window the app owns, so closing or crashing the
                editor cannot lose it and a failed render cannot take the editor down.
                On: the export runs inside this window, as it did before.
              </span>
            </div>
            <Switch
              checked={inProcess}
              onChange={(e) => setPref('exportInProcess', e.target.checked)}
              aria-label="Render exports in the editor window"
            />
          </div>
        ) : null}

        <div className={styles.settingRow}>
          <div className={styles.settingInfo}>
            <span className={styles.settingTitle}>MP4 video encoder</span>
            <span className={styles.settingDesc}>
              Software is the reference encode. A hardware encoder is faster at the same quality tier and
              falls back to software, with a notice, if it cannot start.
              {hardware === null ? ' Checking this machine…' : hardware.length === 0 ? ' No working hardware encoder was found here.' : ''}
            </span>
          </div>
          <div className={styles.segmented} role="radiogroup" aria-label="MP4 video encoder">
            {choices.map((id) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={encoder === id}
                className={cn(styles.segItem, encoder === id && styles.segItemActive)}
                onClick={() => setPref('exportVideoEncoder', id)}
                title={hardware && id !== 'libx264' && !hardware.includes(id) ? 'Not available on this machine — exports will use software' : undefined}
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
