/**
 * The languages the UI can be shown in, and how a user's system language maps
 * onto one of them.
 *
 * ADDING A LANGUAGE
 * -----------------
 *   1. Copy `locales/en.json` to `locales/<code>.json` and translate the values.
 *      Keep every `{placeholder}` exactly as written; `localeCatalogues.test.ts`
 *      fails on a missing or renamed one, and on any key `en.json` does not have.
 *   2. Add one entry to `LOCALES` below: its code, its name IN ITSELF (a
 *      Chinese reader looks for 简体中文, not "Chinese (Simplified)"), the
 *      system locales it should be chosen for, and its loader.
 *
 * That is all. The Settings ▸ Appearance picker lists whatever is here, and
 * hides itself while English is the only entry.
 *
 * `en` has no catalogue on purpose: English is every `t()` call's fallback, so
 * loading it would only duplicate strings the call sites already carry.
 * `locales/en.json` is the SOURCE file for translators, generated from the
 * menu model and kept in step by a test — it is never loaded at runtime.
 */

import type { Catalogue } from './t';

export type LocaleCode = string;

export interface LocaleInfo {
  code: LocaleCode;
  /** The language's name in that language. */
  nativeName: string;
  /**
   * System-locale prefixes (BCP 47, case-insensitive) this locale is chosen for
   * when the user has not picked one. Matched on subtag boundaries, so `zh`
   * matches `zh-Hans-CN` and not `zhx`. List the narrow forms a sibling locale
   * must NOT take: Simplified Chinese claims `zh-CN`/`zh-SG`/`zh-Hans`, never a
   * bare `zh`, or a Taiwanese system would be handed the wrong script.
   */
  systemMatches: ReadonlyArray<string>;
  /** Absent for English — see the file header. */
  load?: () => Promise<Catalogue>;
  /** Development builds only. */
  devOnly?: boolean;
}

export const DEFAULT_LOCALE: LocaleCode = 'en';

/** The pseudo-locale's code. BCP 47 reserves `en-XA` for exactly this. */
export const PSEUDO_LOCALE: LocaleCode = 'en-XA';

export const LOCALES: ReadonlyArray<LocaleInfo> = [
  { code: 'en', nativeName: 'English', systemMatches: ['en'] },
  /*
    Pseudo-localisation: every string that went through `t()` is accented,
    bracketed and ~35% longer — "[Ñéŵ Ƥŕöĵéçţ ···]". Two things become visible
    at a glance: strings that did NOT go through `t()` (still plain English),
    and layouts that break when a translation runs long. Never in a release.
  */
  { code: PSEUDO_LOCALE, nativeName: 'Pseudo (en-XA)', systemMatches: [], devOnly: true },
];

/** The locales this build offers. */
export function availableLocales(isDev: boolean): ReadonlyArray<LocaleInfo> {
  return LOCALES.filter((l) => isDev || !l.devOnly);
}

export function findLocale(code: string | null | undefined, isDev: boolean): LocaleInfo | undefined {
  if (!code) return undefined;
  return availableLocales(isDev).find((l) => l.code === code);
}

function subtagPrefix(tag: string, prefix: string): boolean {
  const t = tag.toLowerCase();
  const p = prefix.toLowerCase();
  return t === p || t.startsWith(`${p}-`);
}

/**
 * The locale to use for a user who has not chosen one: the first system
 * language (in the OS's preference order) that some locale claims, else
 * English. `systemLocales` is `navigator.languages`.
 */
export function matchSystemLocale(systemLocales: ReadonlyArray<string>, isDev: boolean): LocaleCode {
  const offered = availableLocales(isDev);
  for (const sys of systemLocales) {
    // Longest claim wins, so `zh-TW` beats a hypothetical bare `zh` elsewhere.
    let best: { code: LocaleCode; len: number } | undefined;
    for (const l of offered) {
      for (const m of l.systemMatches) {
        if (subtagPrefix(sys, m) && (!best || m.length > best.len)) best = { code: l.code, len: m.length };
      }
    }
    if (best) return best.code;
  }
  return DEFAULT_LOCALE;
}

/**
 * The saved choice if this build still offers it, else the system match.
 * A saved code this build does not offer (a dev-only locale in a release, a
 * language that was removed) falls through rather than sticking the UI on
 * English with no explanation.
 */
export function resolveLocale(
  saved: string | null | undefined,
  systemLocales: ReadonlyArray<string>,
  isDev: boolean,
): LocaleCode {
  return findLocale(saved, isDev)?.code ?? matchSystemLocale(systemLocales, isDev);
}
