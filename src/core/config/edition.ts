/**
 * Which edition of the app this build is.
 *
 * There are two, and the difference is entirely about whether motion-back
 * exists:
 *
 *  • `'server'` — the hosted product. Accounts, cloud projects, billing, the
 *    encrypted sync vault and the AI gateway all work exactly as they always
 *    have. This is the DEFAULT, so a build that says nothing gets today's
 *    behaviour byte for byte.
 *
 *  • `'local'` — the open-source desktop edition. There is no backend to talk
 *    to, so every surface that only makes sense with one is absent rather than
 *    broken: no sign-in, no dashboard, no billing, no sync, and the assistant
 *    reads "coming soon" instead of failing with an auth error. Projects,
 *    assets, version history and export are all local (see `isLocalFirst`,
 *    which this edition implies).
 *
 * The value is a module-level variable set once at boot by `setEdition`, not
 * read from `import.meta.env` here — `import.meta` trips Jest under this repo's
 * CJS transform, so the env read lives in the app entry (`main.tsx`), which
 * tests never import, and tests set the edition directly. This mirrors
 * `./flags`, deliberately: one pattern for build-time switches, not two.
 *
 * Call sites should prefer the capability predicates below over asking which
 * edition it is. `billingEnabled()` says WHY the code is gated; `isLocalEdition()`
 * only says where it happens to be true today — and the day a third edition or
 * a self-hosted backend appears, the capability reads still mean what they say.
 */

export type Edition = 'server' | 'local';

/** Default 'server': an unconfigured build behaves exactly as it did before. */
let edition: Edition = 'server';

/** Parse an env string into an edition. Anything unrecognised means 'server'. */
export function parseEdition(raw: string | undefined | null): Edition {
  const v = (raw ?? '').trim().toLowerCase();
  return v === 'local' || v === 'oss' ? 'local' : 'server';
}

export function getEdition(): Edition {
  return edition;
}

/** Set at boot from the build env; also the test seam. */
export function setEdition(next: Edition): void {
  edition = next;
}

export function isLocalEdition(): boolean {
  return edition === 'local';
}

export function isServerEdition(): boolean {
  return edition === 'server';
}

// ── Capabilities ────────────────────────────────────────────────────────────
// Each one answers "can this build do X", and every one of them is true in the
// server edition. Read these, not the edition.

/**
 * Accounts: sign-in, registration, OAuth, sessions, password reset.
 *
 * Off in the local edition, which is what removes the auth routes entirely —
 * `RequireAuth` cannot gate what has no credential to check.
 */
export const cloudAccountsEnabled = (): boolean => isServerEdition();

/**
 * Cloud project storage: the dashboard, cloud autosave, cloud thumbnails, the
 * server-side version history, and the cloud asset library.
 *
 * Off in the local edition — the `.motion` bundle on disk is the project.
 */
export const cloudProjectsEnabled = (): boolean => isServerEdition();

/** Plans, credits and checkout. */
export const billingEnabled = (): boolean => isServerEdition();

/** The opt-in, client-encrypted, paid project-sync vault. */
export const cloudSyncEnabled = (): boolean => isServerEdition();

/**
 * The assistant.
 *
 * Off in the local edition: every model call goes through the backend gateway,
 * which holds the key. Rather than let the UI fail with "sign in to use the
 * assistant" — an instruction nobody in this edition can follow — the panel
 * says "coming soon" and the composer is disabled. Local BYOK is the intended
 * successor; until it exists, saying so is the honest state.
 */
export const aiEnabled = (): boolean => isServerEdition();

/**
 * The hosted plugin registry (browse / download / update checks).
 *
 * Off in the local edition. Installing a plugin from a local file is unaffected
 * — that path never touched the network.
 */
export const pluginRegistryEnabled = (): boolean => isServerEdition();
