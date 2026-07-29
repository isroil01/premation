/**
 * One-time purge of plaintext provider keys that an earlier build mirrored into
 * `localStorage` (F2).
 *
 * `AiSettingsSection.save()` used to do
 * `localStorage.setItem('motion_editor_local_ai_key_' + id, key)` after handing
 * the key to the backend, and `refresh()` read them back and re-uploaded them.
 * That contradicted the documented posture in four separate files ("the editor
 * never holds a provider key") and meant a real key:
 *
 *   • survived sign-out — clearing the session left the secret behind;
 *   • was readable by **anything with renderer scope, including plugins**, which
 *     run in a Worker but are handed a bridge into the renderer;
 *   • sat unencrypted on disk in the Electron profile, backed up with it.
 *
 * The mirror is now gone. This purges what earlier builds already wrote.
 *
 * **This deliberately does not try to rescue a key that exists only locally.**
 * Uploading a secret at boot with no user action is its own surprise, and a key
 * is re-obtainable from the provider console in thirty seconds — a leaked one is
 * not re-securable at all. A user in that position re-enters it in Settings and
 * it goes straight to the encrypted server store.
 */

/** The exact prefix the old mirror used. */
const LEGACY_PREFIX = 'motion_editor_local_ai_key_';

/**
 * Anything secret-shaped, so a *different* legacy key name (or one added by a
 * plugin) is caught too rather than only the one we happen to remember.
 */
const SECRET_SHAPED = /(^|_)(api[_-]?key|key|token|secret|password)(_|$)/i;

export interface PurgeReport {
  /** Keys removed. Names only — never values, so this is safe to log. */
  removed: string[];
}

/**
 * Remove every plaintext-secret entry from `localStorage`.
 *
 * Idempotent, synchronous, and safe to call before anything else reads storage —
 * which is the point: it must run before a plugin or a stale code path can read
 * one back.
 */
export function purgeLegacyLocalAiKeys(): PurgeReport {
  const removed: string[] = [];
  try {
    // Snapshot the names first — removing during iteration reindexes the store.
    const names: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const name = localStorage.key(i);
      if (name) names.push(name);
    }
    for (const name of names) {
      if (name.startsWith(LEGACY_PREFIX) || SECRET_SHAPED.test(name)) {
        localStorage.removeItem(name);
        removed.push(name);
      }
    }
  } catch {
    // No localStorage (headless test, hardened context). Nothing to purge.
    return { removed };
  }
  if (removed.length) {
    // Names, not values. A console line carrying the secret would recreate the
    // leak this function exists to close.
    console.warn(
      `[security] Removed ${removed.length} plaintext credential(s) left in localStorage by an ` +
      `earlier build (${removed.join(', ')}). If the assistant now says a provider is not ` +
      `configured, re-enter that key in Settings — it will be stored encrypted server-side.`,
    );
  }
  return { removed };
}
