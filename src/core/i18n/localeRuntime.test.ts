import { t, setCatalogue, subscribeCatalogue } from './t';
import {
  LOCALE_SETTING_KEY,
  getLocale,
  getLocalePreference,
  initLocale,
  setLocalePreference,
} from './localeRuntime';

const BLOB = 'motion-editor.settings';
const saved = (): unknown => JSON.parse(localStorage.getItem(BLOB) ?? '{}')[LOCALE_SETTING_KEY];

beforeEach(() => {
  localStorage.clear();
  setCatalogue({});
  document.documentElement.lang = 'en';
});

describe('localeRuntime', () => {
  it('follows the system when nothing is saved', async () => {
    await initLocale({ isDev: true, systemLocales: ['en-GB'] });
    expect(getLocale()).toBe('en');
    expect(getLocalePreference()).toBeNull();
  });

  it('restores a saved choice at boot', async () => {
    localStorage.setItem(BLOB, JSON.stringify({ [LOCALE_SETTING_KEY]: 'en-XA' }));
    await initLocale({ isDev: true, systemLocales: ['en-US'] });
    expect(getLocale()).toBe('en-XA');
    expect(t('menu.file', 'File')).toMatch(/^\[Ƒîļé ·+\]$/);
  });

  it('switches, persists, sets <html lang> and notifies subscribers', async () => {
    await initLocale({ isDev: true, systemLocales: ['en-US'] });
    const fired = jest.fn();
    const off = subscribeCatalogue(fired);
    await setLocalePreference('en-XA');
    off();
    expect(getLocale()).toBe('en-XA');
    expect(saved()).toBe('en-XA');
    expect(document.documentElement.lang).toBe('en-XA');
    expect(fired).toHaveBeenCalled();
  });

  it('forgets the choice and follows the system again on null', async () => {
    await initLocale({ isDev: true, systemLocales: ['en-US'] });
    await setLocalePreference('en-XA');
    await setLocalePreference(null);
    expect(saved()).toBeUndefined();
    expect(getLocale()).toBe('en');
    expect(t('menu.file', 'File')).toBe('File');
  });

  it('ignores a dev-only choice in a release build', async () => {
    localStorage.setItem(BLOB, JSON.stringify({ [LOCALE_SETTING_KEY]: 'en-XA' }));
    await initLocale({ isDev: false, systemLocales: ['en-US'] });
    expect(getLocale()).toBe('en');
    expect(t('menu.file', 'File')).toBe('File');
  });
});
