/**
 * The active UI language: which one it is, where the choice is saved, and the
 * one place that loads a catalogue into `t()`.
 *
 * The choice is stored as `ui.locale` in the settings blob — or NOT stored,
 * which means "follow the system", re-evaluated every launch. That difference
 * matters: someone who never touched the setting and changes their OS language
 * should see the app follow; someone who picked English on a Chinese OS should
 * not be overruled.
 *
 * `initLocale` runs in `main.tsx` BEFORE the first render and is awaited, so a
 * Chinese user never sees one frame of English menus. It never rejects: a
 * catalogue that fails to load leaves the UI in English, which is a working
 * app, rather than a blank window.
 */

import { readPersisted, writePersisted, deletePersisted } from '@core/settings/persistedValue';
import { setCatalogue, subscribeCatalogue } from './t';
import { DEFAULT_LOCALE, PSEUDO_LOCALE, findLocale, resolveLocale, type LocaleCode } from './locales';
import { pseudoLocalize } from './pseudo';

export const LOCALE_SETTING_KEY = 'ui.locale';

export interface LocaleBoot {
  /** `import.meta.env.DEV` — whether dev-only locales are offered. */
  isDev: boolean;
  /** `navigator.languages`. */
  systemLocales: ReadonlyArray<string>;
}

let boot: LocaleBoot = { isDev: false, systemLocales: [] };
let active: LocaleCode = DEFAULT_LOCALE;
/** Guards against an older, slower load finishing after a newer choice. */
let loadToken = 0;

export function getLocale(): LocaleCode {
  return active;
}

/** The saved choice, or `null` when following the system. */
export function getLocalePreference(): LocaleCode | null {
  const saved = readPersisted<unknown>(LOCALE_SETTING_KEY, null);
  return typeof saved === 'string' ? saved : null;
}

export function getLocaleBoot(): LocaleBoot {
  return boot;
}

/** Re-render hook source; fires after the new catalogue is in place. */
export const subscribeLocale = subscribeCatalogue;

async function apply(code: LocaleCode): Promise<void> {
  const token = ++loadToken;
  const info = findLocale(code, boot.isDev);
  let catalogue = {};
  try {
    if (info?.load) catalogue = await info.load();
  } catch (err) {
    // English is a usable app; a thrown import is not a reason to lose it.
    console.warn(`[i18n] could not load the "${code}" catalogue; staying in English`, err);
    code = DEFAULT_LOCALE;
  }
  if (token !== loadToken) return; // a newer choice won the race
  active = info ? code : DEFAULT_LOCALE;
  if (typeof document !== 'undefined') {
    // Not cosmetic. Han characters are shared by Chinese and Japanese, and a
    // browser picks the fallback FONT (so the glyph shapes) from this
    // attribute — under lang="en" Chinese text often draws in a Japanese face.
    document.documentElement.lang = active;
  }
  setCatalogue(catalogue, active === PSEUDO_LOCALE ? { transform: pseudoLocalize } : {});
}

/** Resolve and load the language for this launch. Call once, before rendering. */
export async function initLocale(next: LocaleBoot): Promise<void> {
  boot = next;
  try {
    await apply(resolveLocale(getLocalePreference(), boot.systemLocales, boot.isDev));
  } catch {
    /* apply() already degrades to English; nothing here may block the first paint */
  }
}

/**
 * Switch language now and remember it. `null` forgets the choice and follows
 * the system again.
 */
export async function setLocalePreference(code: LocaleCode | null): Promise<void> {
  if (code === null) deletePersisted(LOCALE_SETTING_KEY);
  else writePersisted(LOCALE_SETTING_KEY, code);
  await apply(resolveLocale(code, boot.systemLocales, boot.isDev));
}
