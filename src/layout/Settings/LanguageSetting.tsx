/**
 * Settings ▸ Appearance ▸ Language.
 *
 * Renders nothing while English is the only language this build offers — a
 * picker with one choice is a control that does nothing, and a release build
 * today has exactly one. It appears the day a second `LOCALES` entry lands
 * (and in development, where the `en-XA` pseudo-locale is always offered).
 *
 * "Match system" is a real, separate choice rather than a synonym for whatever
 * the system happens to be today: it stores nothing, so the app follows an OS
 * language change on the next launch. Picking a language explicitly pins it.
 */

import { useState } from 'react';
import { Button } from '@components/Button';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { Icon } from '@components/Icon';
import {
  availableLocales,
  findLocale,
  getLocaleBoot,
  getLocalePreference,
  matchSystemLocale,
  setLocalePreference,
  t,
  type LocaleCode,
} from '@core/i18n';
import { useLocale } from '@hooks/useLocale';
import styles from './CustomizeDialog.module.css';

export function LanguageSetting(): JSX.Element | null {
  // Redraws this row — its own strings included — the moment the switch lands.
  useLocale();
  const { isDev, systemLocales } = getLocaleBoot();
  const offered = availableLocales(isDev);
  // Local state: `getLocalePreference` reads storage, which is not reactive.
  const [preference, setPreference] = useState<LocaleCode | null>(() => getLocalePreference());

  if (offered.length < 2) return null;

  const systemName = findLocale(matchSystemLocale(systemLocales, isDev), isDev)?.nativeName ?? 'English';
  const choose = (code: LocaleCode | null): void => {
    setPreference(code);
    void setLocalePreference(code);
  };

  const systemLabel = t('settings.language.system', 'Match system ({language})', { language: systemName });
  const current = preference === null ? systemLabel : findLocale(preference, isDev)?.nativeName ?? systemLabel;

  const items: DropdownItem[] = [
    { type: 'checkbox', id: 'system', label: systemLabel, checked: preference === null, onChange: () => choose(null) },
    { type: 'separator' },
    ...offered.map<DropdownItem>((l) => ({
      type: 'checkbox',
      id: l.code,
      // Always in its own language: someone who switched by mistake still
      // has to be able to find their way back.
      label: <span lang={l.code}>{l.nativeName}</span>,
      checked: preference === l.code,
      onChange: () => choose(l.code),
    })),
  ];

  return (
    <div className={styles.sectionGroup}>
      <div className={styles.sectionHeading}>
        <span className={styles.sectionTitle}>{t('settings.language.title', 'Language')}</span>
        <span className={styles.hint}>
          {t('settings.language.hint', 'Menus are translated first; more of the interface follows as translations land. Anything not yet translated stays in English.')}
        </span>
      </div>
      <div className={styles.settingCard}>
        <div className={styles.settingRow}>
          <div className={styles.settingInfo}>
            <span className={styles.settingTitle}>{t('settings.language.label', 'Interface Language')}</span>
            <span className={styles.settingDesc}>{t('settings.language.desc', 'Applies immediately. Project content, expressions and effect names are never translated.')}</span>
          </div>
          <Dropdown
            placement="bottom-end"
            items={items}
            trigger={
              <Button size="sm" aria-haspopup="menu" rightIcon={<Icon name="chevron-down" size="sm" />}>
                {current}
              </Button>
            }
          />
        </div>
      </div>
    </div>
  );
}
