/**
 * Preferences ▸ Audio — AE's Audio Hardware pane.
 *
 * Two settings, and both of them are the kind that are invisible until they are
 * wrong. Output Device is why: someone monitoring on an interface while their
 * system default is the laptop speakers previously had to change the OS setting
 * for every application to hear a preview in the right place.
 *
 * Both are read by `AudioEngine` when it BUILDS its context, which it does
 * lazily on the first sound. A context's latency cannot be changed afterwards,
 * so the note about taking effect on the next playback is a real constraint
 * rather than an apology.
 */

import { useEffect, useState } from 'react';
import {
  canChooseOutput,
  getAudioHardware,
  listAudioOutputs,
  setAudioHardware,
  type AudioOutputDevice,
} from '@core/audio/audioHardware';
import { audioEngine } from '@core/audio/AudioEngine';
import { t } from '@core/i18n';
import styles from './CustomizeDialog.module.css';

/** Latency choices, in ms. 0 is "let the platform decide". A function: t() runs at render. */
function latencies(): ReadonlyArray<{ ms: number; label: string }> {
  return [
    { ms: 0, label: t('settings.audio.latencyAuto', 'Automatic') },
    { ms: 10, label: t('settings.audio.latencyLowest', '10 ms — lowest') },
    { ms: 25, label: '25 ms' },
    { ms: 50, label: '50 ms' },
    { ms: 100, label: t('settings.audio.latencyStable', '100 ms — most stable') },
  ];
}

export function AudioHardwareSection(): JSX.Element {
  const [devices, setDevices] = useState<AudioOutputDevice[]>([]);
  const [settings, setSettings] = useState(() => getAudioHardware());
  const [unlabelled, setUnlabelled] = useState(false);

  useEffect(() => {
    let alive = true;
    void listAudioOutputs().then((list) => {
      if (!alive) return;
      setDevices(list);
      // Empty labels mean the browser is withholding them until microphone
      // permission is granted. Saying so is better than showing "Output 1,
      // Output 2" and leaving the user to guess why.
      setUnlabelled(list.length > 1 && list.slice(1).every((d) => /^Output \d+$/.test(d.label)));
    });
    return () => { alive = false; };
  }, []);

  const supported = canChooseOutput();

  const update = (patch: Parameters<typeof setAudioHardware>[0]): void => {
    setSettings(setAudioHardware(patch));
  };

  return (
    <div className={styles.section}>
      <h3 className={styles.sectionTitle}>{t('settings.audio.title', 'Audio hardware')}</h3>

      <div className={styles.row}>
        <span className={styles.rowLabel}>{t('settings.audio.outputDevice', 'Output device')}</span>
        <select
          className={styles.select}
          value={settings.outputDeviceId}
          disabled={!supported}
          onChange={(e) => update({ outputDeviceId: e.currentTarget.value })}
          aria-label={t('settings.audio.outputDeviceAria', 'Audio output device')}
        >
          {devices.map((d) => (
            <option key={d.deviceId || 'default'} value={d.deviceId}>{d.label}</option>
          ))}
        </select>
      </div>
      {!supported && (
        <p className={styles.rowHint}>
          {t('settings.audio.noRouting', 'This build cannot route audio to a chosen device, so previews follow the system default.')}
        </p>
      )}
      {supported && unlabelled && (
        <p className={styles.rowHint}>
          {t('settings.audio.namesHidden', 'Device names appear once the app has microphone access. The outputs still work.')}
        </p>
      )}

      <div className={styles.row}>
        <span className={styles.rowLabel}>{t('settings.audio.latency', 'Latency')}</span>
        <select
          className={styles.select}
          value={String(Math.round(settings.latencySec * 1000))}
          onChange={(e) => update({ latencySec: Number(e.currentTarget.value) / 1000 })}
          aria-label={t('settings.audio.latencyAria', 'Audio latency')}
        >
          {latencies().map((l) => (
            <option key={l.ms} value={l.ms}>{l.label}</option>
          ))}
        </select>
      </div>
      <p className={styles.rowHint}>
        {t('settings.audio.latencyHint', 'Larger is steadier on a busy machine. Applies from the next playback.')}
      </p>

      <div className={styles.row}>
        <span className={styles.rowLabel}>{t('settings.audio.sampleRate', 'Sample rate')}</span>
        <span className={styles.rowValue}>
          {audioEngine.sampleRate() ? `${audioEngine.sampleRate()} Hz` : t('settings.audio.notStarted', 'Not started')}
        </span>
      </div>
      <p className={styles.rowHint}>
        {t('settings.audio.sampleRateHint', 'Set by the device. Affects monitoring only.')}
      </p>
    </div>
  );
}
