/**
 * `t()` — the translation seam.
 *
 * README
 * ------
 * The app has no locale catalogue yet; every string is English and lives at
 * its call site. This function exists so that NEW code stops adding to that
 * debt: wrap a user-visible string in `t('scope.key', 'English fallback')` and
 * it renders the fallback today, exactly as a bare literal would — and the day
 * a catalogue lands, the key is already there to look up.
 *
 *   t('export.start', 'Start export')
 *   t('assets.count', '{n} assets', { n: 12 })          →  "12 assets"
 *   t('rename.prompt', 'Rename "{name}"?', { name })
 *
 * Rules for new code:
 *   • Keys are dotted, lower-case, scoped by feature: `timeline.addMarker`.
 *   • ALWAYS pass the English fallback. A key with no fallback renders the key
 *     itself, which is what you will see in the UI if you forget.
 *   • Interpolate with `{var}`; never concatenate translated fragments — word
 *     order is not universal.
 *   • Do not `t()` identifiers, file names, or values the user typed.
 *
 * Existing strings are NOT migrated by this change; do that per feature, when
 * you are in the file anyway.
 *
 * WHO FILLS THE CATALOGUE. `localeRuntime.ts` — the user's language choice
 * loads a `locales/<code>.json` and hands it to `setCatalogue`. Nothing else
 * should call it outside tests. A `t()` result is a plain string, so UI that
 * must redraw on a language switch subscribes (`subscribeCatalogue`, or the
 * `useLocale` hook built on it).
 */

export type TranslationVars = Record<string, string | number>;

export type Catalogue = Readonly<Record<string, string>>;

export interface CatalogueOptions {
  /**
   * Applied to every resolved template (catalogue hit OR fallback) before
   * interpolation. Exists for the development pseudo-locale, which must reach
   * strings that have no catalogue entry — that is the point of it: anything
   * still plain English on screen is a string `t()` never saw.
   */
  transform?: (template: string) => string;
}

/**
 * A catalogue is a flat map from key to translated template. There is exactly
 * one, and `setCatalogue` is the only way to fill it — kept module-private so
 * the seam has one entry point.
 */
let catalogue: Catalogue = {};
let transform: ((template: string) => string) | undefined;
let revision = 0;
const listeners = new Set<() => void>();

/** Replace the active catalogue and notify subscribers. For `localeRuntime` and tests. */
export function setCatalogue(next: Catalogue, options: CatalogueOptions = {}): void {
  catalogue = next;
  transform = options.transform;
  revision += 1;
  for (const l of listeners) {
    try { l(); } catch { /* one bad subscriber must not stop the rest redrawing */ }
  }
}

/** Bumped by every `setCatalogue`. A `useSyncExternalStore` snapshot. */
export function getCatalogueRevision(): number {
  return revision;
}

/** Called after every `setCatalogue`. Returns an unsubscribe fn. */
export function subscribeCatalogue(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** `{name}` → vars.name; unknown names are left as written so a typo is visible. */
function interpolate(template: string, vars?: TranslationVars): string {
  if (!vars) return template;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
  );
}

/**
 * Translate `key`, falling back to `fallback` (then to the key itself) and
 * interpolating `{var}` placeholders from `vars`.
 */
export function t(key: string, fallback?: string, vars?: TranslationVars): string {
  const template = catalogue[key] ?? fallback ?? key;
  return interpolate(transform ? transform(template) : template, vars);
}
