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
 * The assistant — the whole surface, not just the transport.
 *
 * Off in the local edition. This has now been all three values it can be, so it
 * is worth writing down why it is this one.
 *
 * It began as `isServerEdition()` because the backend gateway held the key. Then
 * the local edition grew a key path of its own — the OS keystore in the main
 * process, spent by `electron/aiProxy.ts` — and this became `() => true`, on the
 * reasoning that the assistant needs a KEY, not a backend, and "coming soon" made
 * the OSS headline a false statement.
 *
 * It is `isServerEdition()` again, and NOT because that path stopped working: the
 * vault, the proxy, the provider adapters, the tools and the runners are all
 * untouched and all still correct. The local edition simply does not ship the
 * assistant as a product surface. That is a distribution decision, not an
 * engineering one, which is why the code below it stays exactly where it is —
 * this predicate is the only thing standing between the two states, and flipping
 * it back is a one-line change.
 *
 * ── This gate is load-bearing, which it never used to be ────────────────────
 *
 * Read this carefully before adding a call site. Until now `aiEnabled()` was
 * `() => true` with NO runtime callers at all — every branch that once read it
 * had been rewritten to read `aiRunsThroughBackend()` instead. So this predicate
 * did not hide anything, and turning it false on its own would have hidden
 * nothing either. The surfaces are gated individually (panel registry, panel
 * renderers, the Customize dialog's AI tab, the AI-focus workspace) and in the
 * main process (`electron/edition.ts`, which gates the IPC registration).
 *
 * `editionAiSurface.test.ts` is what keeps that list honest. If you add an AI
 * entry point, it fails until the entry point is gated.
 */
export const aiEnabled = (): boolean => isServerEdition();

/**
 * Does the assistant run through the backend, or through the desktop shell?
 *
 * Read this rather than the edition when the question is "where does the key
 * live", because that is the only thing that actually differs. The server edition
 * proxies through motion-back (which encrypts keys at rest with AI_KEY_SECRET);
 * the local edition uses the OS keystore and the main process.
 */
export const aiRunsThroughBackend = (): boolean => isServerEdition();

/**
 * Plugins — the whole feature, not just the registry.
 *
 * Off in the local edition, and this is the predicate to read. It is newer than
 * `pluginRegistryEnabled` below and strictly wider: that one asks "may this
 * build talk to the marketplace", which was the only question while the local
 * edition still ran plugins from disk. It no longer does. A plugin is a hosted
 * product feature: the registry, the review queue, the signed revocation list
 * and the takedown path are the things that make running third-party code in
 * someone's editor defensible, and a build with none of them should not be
 * offering the sandbox either.
 *
 * ── This gate is load-bearing, and a predicate alone would hide nothing ─────
 *
 * The same shape `aiEnabled` was in. Every plugin surface is gated
 * individually — the panel registry, the Plugins menu group, the layer-creation
 * entries, the effects browser folder, the command palette, and the host's own
 * boot in `Providers` — and `editionPluginSurface.test.ts` is what keeps that
 * list honest. If you add a plugin entry point, it fails until it is gated.
 *
 * What is deliberately NOT gated: everything that reads plugin content out of a
 * DOCUMENT. A project containing a custom layer kind, a plugin effect or a
 * proxy subtree opens, renders and re-saves byte-identically in a build with no
 * plugin support, exactly as it does after an uninstall in a hosted build.
 * `uninstalledDocumentRoundTrip.test.ts` is that property.
 */
export const pluginsEnabled = (): boolean => isServerEdition();

/**
 * The hosted plugin registry (browse / download / update checks).
 *
 * Narrower than `pluginsEnabled` and kept separate on purpose: this is the
 * question "may this code make a network request to the marketplace", and it is
 * asked deep inside `registry.ts`, where the answer must hold whatever the UI
 * above it did. A local build making one request to our backend on boot is a
 * telemetry problem regardless of which surface is hidden, so the network gate
 * lives at the network, not at the button.
 */
export const pluginRegistryEnabled = (): boolean => isServerEdition();
