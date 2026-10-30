/**
 * Preferences ▸ Files — the autosave settings.
 *
 * Autosave has run every 60 seconds since the recovery snapshot existed, with
 * no way to see it or tune it: someone on a slow disk could not slow it down,
 * someone nervous could not speed it up, and nobody could tell whether it had
 * fired. This tab is those four numbers — interval, how many snapshots are
 * kept, an optional folder for a JSON copy, and when the last one landed —
 * plus "Autosave now" for the person who wants proof.
 *
 * The values are preferences (`autosaveIntervalSec`, `autosaveKeep`,
 * `autosaveLocation`); the controller re-arms itself when the interval
 * changes and `recovery.ts` reads the other two at write time, so nothing
 * here talks to the timer directly.
 */

import { useEffect, useState } from 'react';
import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { Input } from '@components/Input';
import { Segmented } from '@components/Segmented';
import { usePreferenceStore } from '@stores/preferenceStore';
import { useUIStore } from '@stores/uiStore';
import {
  AUTOSAVE_MAX_SEC,
  AUTOSAVE_MIN_SEC,
} from '@core/persistence/AutosaveController';
import { getProjectManager } from '@core/services/coreServices';
import { AUTOSAVE_KEEP_MAX, AUTOSAVE_KEEP_MIN } from '@core/persistence/recovery';
import { t } from '@core/i18n';
import styles from './CustomizeDialog.module.css';

type IntervalChoice = '30' | '60' | '120' | '300';

const INTERVALS: ReadonlyArray<{ value: IntervalChoice; label: string }> = [
  { value: '30', label: '30 s' },
  { value: '60', label: '1 min' },
  { value: '120', label: '2 min' },
  { value: '300', label: '5 min' },
];

/** "2 minutes ago", "just now" — relative, because the absolute time is in the title. */
export function formatAgo(at: number, now: number): string {
  const sec = Math.max(0, Math.round((now - at) / 1000));
  if (sec < 10) return t('settings.files.justNow', 'just now');
  if (sec < 60) return t('settings.files.secondsAgo', '{n} s ago', { n: sec });
  const min = Math.round(sec / 60);
  if (min < 60) return t('settings.files.minutesAgo', '{n} min ago', { n: min });
  const hr = Math.round(min / 60);
  return t('settings.files.hoursAgo', '{n} h ago', { n: hr });
}

function pickerAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.motionEditor?.shell?.pickFolder === 'function';
}

export function FilesTab(): JSX.Element {
  const intervalSec = usePreferenceStore((s) => s.autosaveIntervalSec);
  const keep = usePreferenceStore((s) => s.autosaveKeep);
  const location = usePreferenceStore((s) => s.autosaveLocation);
  const setPref = usePreferenceStore((s) => s.set);
  const lastAutosaveAt = useUIStore((s) => s.lastAutosaveAt);

  // The "ago" line ticks, so a dialog left open does not say "just now" for an hour.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);

  const intervalChoice = (INTERVALS.find((i) => Number(i.value) === intervalSec)?.value ?? null);
  const [customInterval, setCustomInterval] = useState<string>(String(intervalSec));
  useEffect(() => setCustomInterval(String(intervalSec)), [intervalSec]);

  const commitInterval = (raw: string): void => {
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return;
    setPref('autosaveIntervalSec', Math.min(AUTOSAVE_MAX_SEC, Math.max(AUTOSAVE_MIN_SEC, n)));
  };

  const chooseFolder = async (): Promise<void> => {
    const pick = window.motionEditor?.shell?.pickFolder;
    if (!pick) return;
    const dir = await pick().catch(() => null);
    if (dir) setPref('autosaveLocation', dir);
  };

  return (
    <div className={styles.section} data-testid="files-tab">
      <h3 className={styles.sectionTitle}>{t('settings.files.autosave', 'Autosave')}</h3>
      <p className={styles.hint}>
        {t('settings.files.autosaveHint', 'A recovery snapshot of the open project, written while it has unsaved edits. It never replaces Save.')}
      </p>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <span className={styles.settingTitle}>{t('settings.files.interval', 'Interval')}</span>
          <span className={styles.settingDesc}>{t('settings.files.intervalDesc', 'How often a snapshot is written.')}</span>
        </div>
        <div className={styles.settingRight}>
          <Segmented<IntervalChoice>
            aria-label={t('settings.files.intervalAria', 'Autosave interval')}
            options={INTERVALS}
            value={(intervalChoice ?? '60') as IntervalChoice}
            onChange={(v) => setPref('autosaveIntervalSec', Number(v))}
          />
          <Input
            size="sm"
            type="number"
            min={AUTOSAVE_MIN_SEC}
            max={AUTOSAVE_MAX_SEC}
            step={5}
            value={customInterval}
            onChange={(e) => setCustomInterval(e.currentTarget.value)}
            onBlur={(e) => commitInterval(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') commitInterval(e.currentTarget.value); }}
            suffix="s"
            aria-label={t('settings.files.intervalSecondsAria', 'Autosave interval in seconds')}
            data-enter-safe=""
          />
        </div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <span className={styles.settingTitle}>{t('settings.files.keep', 'Keep')}</span>
          <span className={styles.settingDesc}>
            {t('settings.files.keepDesc', 'The newest is offered after a crash.')}
          </span>
        </div>
        <div className={styles.settingRight}>
          <Input
            size="sm"
            type="number"
            min={AUTOSAVE_KEEP_MIN}
            max={AUTOSAVE_KEEP_MAX}
            step={1}
            value={String(keep)}
            onChange={(e) => {
              const n = Number.parseInt(e.currentTarget.value, 10);
              if (Number.isFinite(n)) setPref('autosaveKeep', Math.min(AUTOSAVE_KEEP_MAX, Math.max(AUTOSAVE_KEEP_MIN, n)));
            }}
            suffix={t('settings.files.snapshotsSuffix', 'snapshots')}
            aria-label={t('settings.files.keepAria', 'Snapshots to keep')}
            data-enter-safe=""
          />
        </div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <span className={styles.settingTitle}>{t('settings.files.location', 'Location')}</span>
          <span className={styles.settingDesc}>
            {location
              ? t('settings.files.locationSet', 'Each snapshot is also copied here.')
              : pickerAvailable()
                ? t('settings.files.locationPick', 'Optionally keep a copy of each snapshot in a folder.')
                : t('settings.files.locationNoPicker', 'A folder copy needs the desktop app.')}
          </span>
          {location ? <code className={styles.kbd} title={location}>{location}</code> : null}
        </div>
        <div className={styles.settingRight}>
          {pickerAvailable() ? (
            <Button variant="secondary" size="sm" onClick={() => void chooseFolder()}>
              <Icon name="folder-open" size="sm" />
              <span>{location ? t('settings.files.change', 'Change…') : t('settings.files.chooseFolder', 'Choose folder…')}</span>
            </Button>
          ) : null}
          {location ? (
            <Button variant="ghost" size="sm" onClick={() => setPref('autosaveLocation', null)}>
              {t('settings.files.clear', 'Clear')}
            </Button>
          ) : null}
        </div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <span className={styles.settingTitle}>{t('settings.files.lastAutosave', 'Last autosave')}</span>
          <span
            className={styles.settingDesc}
            title={lastAutosaveAt ? new Date(lastAutosaveAt).toLocaleString() : undefined}
            data-testid="last-autosave"
          >
            {lastAutosaveAt ? formatAgo(lastAutosaveAt, now) : t('settings.files.notYet', 'Not yet this session.')}
          </span>
        </div>
        <div className={styles.settingRight}>
          <Button
            variant="secondary"
            size="sm"
            onClick={async () => {
              const at = await getProjectManager().autosaveNow();
              if (at !== null) {
                useUIStore.getState().setLastAutosaveAt(at);
                setNow(Date.now());
              }
              else {
                useUIStore.getState().notify({
                  level: 'warning',
                  message: t('settings.files.nothingToAutosave', 'Nothing to autosave — open a project first.'),
                  durationMs: 3000,
                });
              }
            }}
          >
            <Icon name="clock" size="sm" />
            <span>{t('settings.files.autosaveNow', 'Autosave now')}</span>
          </Button>
        </div>
      </div>
    </div>
  );
}
