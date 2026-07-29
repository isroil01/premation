/**
 * Persisted settings that do NOT require the editor core to be booted.
 *
 * `getSettingsManager()` throws until `Application.boot()` has run, and boot only
 * happens inside `Providers`, which only mounts on the (lazily loaded) editor
 * route. Any zustand store that reads its persisted state at MODULE EVALUATION
 * time therefore runs before the core exists — the `getSettingsManager()` call
 * throws, the `catch` hands back the hardcoded fallback, and the user's saved
 * choice is silently discarded on every launch. That is exactly what happened to
 * the AI provider choice: it was written correctly and never read back once.
 *
 * These helpers read and write the SAME `motion-editor.settings` blob the
 * SettingsManager owns, so there is still one file of settings:
 *
 *   • booted  → go through the manager, so its in-memory cache stays the
 *     authority and a later flush cannot clobber the write;
 *   • not yet → read/write the blob directly. The manager reads the blob in its
 *     constructor, so anything written before boot is picked up by it.
 *
 * Storage is `localStorage`, which in the Electron build is the renderer's
 * profile on disk — persistent across launches, per-installation, and never
 * synced anywhere. Do not put secrets here (see `core/api/purgeLocalKeys.ts`).
 */

import { tryCoreServices } from '@core/services/coreServices';

/** Must match `createLocalStorageBackend`'s default in SettingsManager.ts. */
const BLOB_KEY = 'motion-editor.settings';

function readBlob(): Record<string, unknown> {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(BLOB_KEY) : null;
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    // Unavailable (hardened context, headless test) or corrupt. A settings blob
    // that will not parse is not worth failing a boot over.
    return {};
  }
}

function writeBlob(all: Record<string, unknown>): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(BLOB_KEY, JSON.stringify(all));
  } catch {
    /* quota / serialization — the in-memory choice still applies this session */
  }
}

/** Read a persisted setting whether or not the core has booted. */
export function readPersisted<T>(key: string, fallback: T): T {
  const settings = tryCoreServices()?.settings;
  if (settings) return settings.get<T>(key, fallback);
  const blob = readBlob();
  return key in blob ? (blob[key] as T) : fallback;
}

/** Write a persisted setting whether or not the core has booted. */
export function writePersisted<T>(key: string, value: T): void {
  const settings = tryCoreServices()?.settings;
  if (settings) {
    settings.set<T>(key, value);
    return;
  }
  const blob = readBlob();
  blob[key] = value;
  writeBlob(blob);
}

/** Remove a persisted setting whether or not the core has booted. */
export function deletePersisted(key: string): void {
  const settings = tryCoreServices()?.settings;
  if (settings) {
    settings.delete(key);
    return;
  }
  const blob = readBlob();
  if (!(key in blob)) return;
  delete blob[key];
  writeBlob(blob);
}
