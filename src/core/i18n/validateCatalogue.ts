/**
 * Checks a translated catalogue against the English source (`locales/en.json`).
 *
 * What it rejects, and why each would ship a visible bug:
 *
 *   • a key the source does not have — a typo, or a string that was removed or
 *     renamed; the translation will never be shown, and nobody will notice;
 *   • a `{placeholder}` missing, added or renamed — `t()` leaves an unknown one
 *     as written, so the user reads "保存到 {num}" instead of "保存到 1";
 *   • an empty or non-string value — renders as a blank menu item.
 *
 * What it allows: a MISSING key. `t()` falls back to English per string, so a
 * half-finished language is a working, partly English UI — which is how every
 * translation grows. `coverage` reports how far along it is.
 */

import type { Catalogue } from './t';

export interface CatalogueReport {
  errors: string[];
  /** Translated keys / source keys, 0–1. */
  coverage: number;
  missing: string[];
}

const PLACEHOLDER = /\{([a-zA-Z0-9_]+)\}/g;

function placeholders(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((m) => m[1] ?? '').sort();
}

export function validateCatalogue(source: Catalogue, translated: Readonly<Record<string, unknown>>): CatalogueReport {
  const errors: string[] = [];
  for (const [key, value] of Object.entries(translated)) {
    if (!(key in source)) {
      errors.push(`unknown key "${key}" (not in en.json — renamed or removed?)`);
      continue;
    }
    if (typeof value !== 'string' || value.trim() === '') {
      errors.push(`"${key}" is empty or not a string`);
      continue;
    }
    const want = placeholders(source[key] ?? '').join(',');
    const got = placeholders(value).join(',');
    if (want !== got) errors.push(`"${key}" placeholders {${got}} ≠ English {${want}}`);
  }
  const sourceKeys = Object.keys(source);
  const missing = sourceKeys.filter((k) => !(k in translated));
  const coverage = sourceKeys.length === 0 ? 1 : (sourceKeys.length - missing.length) / sourceKeys.length;
  return { errors, coverage, missing };
}
