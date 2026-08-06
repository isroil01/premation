/**
 * Installing from the registry, from anywhere in the editor.
 *
 * There are three places a user can now press Install — the sidebar row, the
 * detail tab, and a deep link — and they must all do the SAME thing. Three
 * copies of this flow is three chances for one of them to skip a step, and the
 * steps are the security model:
 *
 *   1. Fetch the bytes.
 *   2. Verify the signature against the PINNED publisher key.
 *   3. Read the package with the same reader a local `.zip` goes through.
 *   4. Show the per-permission consent screen.
 *   5. Install with exactly what the user ticked.
 *
 * Coming from the registry is NOT a reason to skip step 4. A "trusted source"
 * path would make the registry a way around the one screen that tells a user
 * what they are agreeing to — and the registry cannot promise a publisher is
 * honest, only that a package came from the same key as last time.
 */

import { fetchRegistryPackage } from '@core/plugins/registry';
import { readPluginZip, type PluginPackage } from '@core/plugins/pluginPackage';
import { customAlert } from '@components/Modal/Dialogs';

/** Set by the consent host so any surface can raise it. */
let requestConsent: ((pkg: PluginPackage, publisherKey: string) => void) | null = null;

/** What a key-change prompt has to say. */
export interface KeyChangeRequest {
  pluginId: string;
  pluginName: string;
  version: string;
  /** The key this machine has trusted until now. */
  pinnedKey: string;
  /** The key the registry says signs this plugin now. */
  newKey: string;
}

/**
 * Set by the key-change host. Resolves true when the user accepts the change.
 *
 * A promise rather than a callback, because the update flow genuinely cannot
 * continue without the answer — and modelling that as "carry on and hope" is
 * how a security prompt becomes decorative.
 */
let requestKeyChange: ((req: KeyChangeRequest) => Promise<boolean>) | null = null;

export function setKeyChangeHost(
  fn: ((req: KeyChangeRequest) => Promise<boolean>) | null,
): void {
  requestKeyChange = fn;
}

/**
 * Register the consent screen.
 *
 * Injected rather than imported so this module stays free of React — it is
 * called from a store action, a menu handler and a deep-link handler, none of
 * which are components.
 */
export function setConsentHost(
  fn: ((pkg: PluginPackage, publisherKey: string) => void) | null,
): void {
  requestConsent = fn;
}

/**
 * Fetch, verify, parse, and hand to consent.
 *
 * Returns false when the flow stopped before consent — the user has already
 * been told why, so a caller should not report it a second time.
 */
export async function installFromRegistry(
  id: string,
  version: string,
  publisherKey: string,
): Promise<boolean> {
  try {
    // Signature checked inside `fetchRegistryPackage`, against `publisherKey`.
    // That key is the pin: for an update it is the key stored with the
    // installed copy, and for a first install it is the key from the listing
    // the user is looking at — which is the trust-on-first-use moment.
    const { bytes } = await fetchRegistryPackage(id, version, publisherKey);

    // The same reader a picked file goes through. A registry package gets no
    // shortcut past zip-bomb limits, path traversal checks or manifest
    // validation, because "we served it" is not a property of the bytes.
    const result = readPluginZip(bytes);
    if (!result.pkg) {
      void customAlert('That package is not readable', result.errors.join('\n'), { isDanger: true });
      return false;
    }

    if (!requestConsent) {
      void customAlert(
        'Cannot install right now',
        'The consent screen is not available. Open the Plugins panel and install from there.',
        { isDanger: true },
      );
      return false;
    }

    requestConsent(result.pkg, publisherKey);
    return true;
  } catch (err) {
    void customAlert('Install failed', (err as Error).message, { isDanger: true });
    return false;
  }
}

/**
 * Take an offered update, including the case where the signing key changed.
 *
 * ── Why this exists as a separate flow ───────────────────────────────────────
 *
 * An update verifies against the key stored with the INSTALLED copy, never one
 * the registry response nominated — a server that could hand over both the
 * package and the key to check it with is a server that can hand over anything.
 * That pin is what makes "an update came from the same author" mean something.
 *
 * Publishers do lose keys, though, and the old answer ("republish under a new
 * id") discarded the install base and every document referencing that id. So a
 * publisher can now authorise a replacement key in advance, and the registry
 * will rotate to it — see `plugins.service.ts`.
 *
 * That is exactly the move an attacker who took over a publisher's account
 * would want, so the client half is this: **the pin never changes without the
 * user saying so.** The rotation is announced, in plain language, with keeping
 * the current version as a first-class option. Declining is not an error — it
 * leaves a working plugin working.
 *
 * Three gates in total, and a stolen account clears only one: the registry
 * requires the password to authorise a key, requires a package signed with it
 * to rotate, and every installed copy requires its own user to accept.
 */
export async function updateFromRegistry(
  id: string,
  version: string,
  /** The key this machine trusts. Null for a plugin installed from disk. */
  pinnedKey: string | null,
  /** The key the registry currently lists for this plugin. */
  registryKey: string,
  pluginName: string,
): Promise<boolean> {
  if (!pinnedKey) {
    void customAlert(
      'No publisher key',
      `"${pluginName}" was installed from a local file, so there is no publisher key to check an `
      + 'update against. Install it from the registry to get verified updates.',
    );
    return false;
  }

  let keyToTrust = pinnedKey;

  if (registryKey && registryKey !== pinnedKey) {
    if (!requestKeyChange) {
      // Refused rather than silently accepted. A build where the prompt is
      // unavailable must not be the build that updates the pin without asking.
      void customAlert(
        'Cannot update right now',
        `The signing key for "${pluginName}" has changed, and this needs your confirmation. `
        + 'Open the Plugins panel and update from there.',
        { isDanger: true },
      );
      return false;
    }

    const accepted = await requestKeyChange({
      pluginId: id,
      pluginName,
      version,
      pinnedKey,
      newKey: registryKey,
    });
    // Declining is a legitimate outcome, not a failure: the installed version
    // keeps working, and nothing is said twice.
    if (!accepted) return false;

    keyToTrust = registryKey;
  }

  return installFromRegistry(id, version, keyToTrust);
}
