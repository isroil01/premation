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
import { usePluginStore } from '@stores/pluginStore';

/** Set by the consent host so any surface can raise it. */
/**
 * What a package arrived WITH, beyond its own bytes.
 *
 * The successor key travels with the install rather than being fetched later,
 * because the whole value of recording it is that this machine knew it BEFORE
 * any rotation used it. Learning it at rotation time would be learning it from
 * the response being questioned.
 */
export interface InstallOrigin {
  publisherKey: string;
  nextPublisherKey?: string | null;
  nextPublisherKeyMethod?: 'backup' | 'dashboard' | null;
}

let requestConsent: ((pkg: PluginPackage, origin: InstallOrigin) => void) | null = null;

/** What a key-change prompt has to say. */
export interface KeyChangeRequest {
  pluginId: string;
  pluginName: string;
  version: string;
  /** The key this machine has trusted until now. */
  pinnedKey: string;
  /** The key the registry says signs this plugin now. */
  newKey: string;
  /**
   * What this machine knew about the new key BEFORE this rotation.
   *
   * `dashboard` — recorded as authorised, but from the publisher's account
   * after the plugin was already published. A thief holding that account could
   * have done exactly this, and the copy says so.
   * `unknown` — never recorded here at all. Strongest warning, and the prompt
   * defaults to refusing.
   *
   * There is deliberately no `backup` value. A key registered at first publish,
   * before there was an install base to endanger, is accepted with no prompt
   * and written to the security log instead — and having a case for it here
   * would invite someone to render a reassuring dialog for the one path that
   * needs no dialog at all.
   */
  authorisation: 'dashboard' | 'unknown';
}

/**
 * Append to a plugin's on-machine security log.
 *
 * Fire-and-forget by design. This is a record, and failing to write one must
 * not abort a rotation the user already accepted — still less abort the SILENT
 * path and leave the plugin unupdated for a reason nobody can see.
 */
function recordSecurityEvent(id: string, text: string): void {
  try {
    usePluginStore.getState().noteSecurityEvent(id, text);
  } catch {
    // A full storage quota. The rotation still happened and is still correct.
  }
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
  fn: ((pkg: PluginPackage, origin: InstallOrigin) => void) | null,
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
  /**
   * Digest the LISTING gave for this version, if the caller had one.
   *
   * Optional because not every path has metadata to hand, and because a
   * registry older than this field simply will not send one. Absent, the
   * install falls back to exactly the guarantee it had before: the signature,
   * which is the real boundary and always runs. Present, it also answers
   * "are these the bytes that listing described" — the question that starts
   * mattering the moment bytes and metadata come from different origins.
   */
  expectedDigest?: string,
  /** The successor the LISTING advertised, recorded so a later rotation can be
   *  checked against something this machine already knew. */
  successor?: { nextPublisherKey?: string | null; nextPublisherKeyMethod?: 'backup' | 'dashboard' | null },
): Promise<boolean> {
  try {
    // Signature checked inside `fetchRegistryPackage`, against `publisherKey`.
    // That key is the pin: for an update it is the key stored with the
    // installed copy, and for a first install it is the key from the listing
    // the user is looking at — which is the trust-on-first-use moment.
    const { bytes } = await fetchRegistryPackage(id, version, publisherKey, expectedDigest);

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

    requestConsent(result.pkg, { publisherKey, ...(successor ?? {}) });
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
  /** Digest the UPDATE OFFER gave for this version, if the caller had one. */
  expectedDigest?: string,
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
    /*
      Three paths, not one — and the difference is what this machine already
      knew BEFORE the rotation happened.

      An installed copy records the successor key the registry advertised, at
      install and on every update since. So a rotation arrives in one of three
      genuinely different situations, and treating them alike was the defect:
      each produced the same modal, including the one a thief with a stolen
      publisher account most wants displayed. A prompt that looks the same for
      the safe case and the dangerous case is a prompt people click through.

        1. The new key is the recorded one, authorised as `backup` — chosen at
           first publish, before there was an install base to endanger. There is
           nothing to ask: the evidence was recorded before the event. Accepted
           silently, and WRITTEN DOWN, because a change nobody was asked about
           and nobody can find afterwards is indistinguishable from no change.
        2. The recorded one, authorised from the `dashboard` — chosen later,
           behind the account password, by whoever held the account then. Which
           is exactly what a thief holds. Prompted, and the copy says so.
        3. Not a key this machine ever recorded. Strongest warning, and the
           prompt defaults to refusing.

      Never accepted on the strength of the same response that uses it: a
      successor that first appears alongside the package needing it is an
      assertion by the server being questioned.
    */
    const known = usePluginStore.getState().get(id);
    const preauthorised = !!known?.nextPublisherKey && known.nextPublisherKey === registryKey;
    const method = preauthorised ? known?.nextPublisherKeyMethod : undefined;

    if (preauthorised && method === 'backup') {
      recordSecurityEvent(
        id,
        'Signing key rotated to a key registered as a backup when this plugin was first '
        + 'published, before anyone had installed it. Accepted automatically.',
      );
      return installFromRegistry(id, version, registryKey, expectedDigest);
    }

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
      // Which of the two remaining stories to tell. `dashboard` is the weaker
      // reassurance and must not be dressed as the stronger one.
      authorisation: preauthorised && method === 'dashboard' ? 'dashboard' : 'unknown',
    });
    // Declining is a legitimate outcome, not a failure: the installed version
    // keeps working, and nothing is said twice.
    if (!accepted) return false;

    recordSecurityEvent(
      id,
      preauthorised
        ? 'Signing key rotated to a key authorised from the publisher\'s account after this '
          + 'plugin was published. You accepted it.'
        : 'Signing key rotated to a key this copy had never seen authorised. You accepted it.',
    );
    keyToTrust = registryKey;
  }

  return installFromRegistry(id, version, keyToTrust, expectedDigest);
}
