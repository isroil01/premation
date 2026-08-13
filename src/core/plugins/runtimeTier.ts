/**
 * Two ways a plugin can run, and who is allowed the dangerous one.
 *
 * ── Why there are two ────────────────────────────────────────────────────────
 *
 * The Worker sandbox is what makes a plugin safe to install from a stranger. It
 * is also a hard ceiling: a plugin cannot run code in the frame loop, cannot
 * hold a synchronous handle to the scene graph, and cannot add a render pass —
 * because every one of those means crossing `postMessage` at a point where the
 * renderer has to be synchronous. That ceiling is exactly what stops a
 * Premation plugin being as capable as an After Effects one.
 *
 * AE's answer is to have no ceiling and no sandbox: plugins are native code in
 * the host process, and a bad one takes the application with it. That is a
 * coherent trade for a tool whose plugins arrive as vendor installers a
 * professional deliberately bought. It is the wrong trade for a one-click
 * marketplace install.
 *
 * So: both. A manifest declares which it wants.
 *
 *   sandboxed  Worker, lockdown, permission gate. The default, and what a
 *              marketplace install gets. Unchanged.
 *   native     The plugin's module is imported into the RENDERER REALM. It
 *              gets synchronous handles, can run per frame, and is subject to
 *              no permission gate — because there is no boundary left to gate.
 *
 * ── What `native` actually costs ─────────────────────────────────────────────
 *
 * Stated plainly here because it is the one thing a reader of this file must
 * not have to infer:
 *
 *   • It can hang the editor. There is no heartbeat, because there is no
 *     separate thread to fail to answer one.
 *   • It can crash the renderer.
 *   • It can corrupt or destroy the user's project.
 *   • It can read anything the page can.
 *
 * Two protections survive, by accident of how the desktop app is built rather
 * than by anything this file does: the session token and the user's AI provider
 * keys live in the MAIN process behind a write-only vault, so the renderer holds
 * neither; and the renderer's CSP still refuses connections to hosts we did not
 * name, so exfiltration over the network is not free. Neither is a substitute
 * for the sandbox, and neither should be described as one.
 *
 * Signature verification and the revocation list still apply. Those govern
 * WHOSE code runs, which is orthogonal to what it may do once it runs — and
 * with the sandbox gone they are doing much more of the work.
 *
 * ── The rule that matters most ───────────────────────────────────────────────
 *
 * A plugin that was sandboxed and becomes native on update MUST re-ask. That
 * is the attack this file exists to make impossible to write by accident:
 * publish something harmless, collect installs, then flip one manifest field
 * and inherit full access on every machine that had it. Trust is recorded with
 * the tier it was granted for, and `needsNativeConsent` compares against that.
 */

/** What a manifest may declare. Absent means `sandboxed`. */
export const RUNTIME_TIERS = ['sandboxed', 'native'] as const;
export type RuntimeTier = (typeof RUNTIME_TIERS)[number];

export const DEFAULT_RUNTIME_TIER: RuntimeTier = 'sandboxed';

/**
 * How a plugin came to be on this machine. Decides how trust may be obtained.
 *
 * `folder` is the author's own working copy, picked from their own disk. They
 * wrote it; asking them to vouch for it is theatre, but a single confirmation
 * still happens so that "I opened a folder" can never silently become "I gave
 * something unrestricted access".
 */
export type InstallOriginKind = 'folder' | 'registry' | 'file';

/** A recorded decision to let one plugin run unsandboxed. */
export interface NativeTrust {
  /** Epoch ms. Shown to the user; also what makes the record auditable. */
  at: number;
  /** The version that was on disk when trust was given. */
  version: string;
  /**
   * The tier the plugin declared when trust was given.
   *
   * Always `'native'` today — a sandboxed plugin is never asked. Stored
   * explicitly anyway, because the check that matters is "was this trusted AS
   * a native plugin", and inferring that from the presence of a record would
   * make a future third tier silently inherit the answer.
   */
  tier: RuntimeTier;
  origin: InstallOriginKind;
}

/** The subset of an installed plugin this module reasons about. */
export interface NativeTrustSubject {
  tier: RuntimeTier;
  version: string;
  origin: InstallOriginKind;
  trust?: NativeTrust;
}

/**
 * Does this plugin need the user to agree before it may run unsandboxed?
 *
 * `false` for anything sandboxed — there is nothing to agree to. The permission
 * screen covers that tier and this one has no opinion about it.
 */
export function needsNativeConsent(p: NativeTrustSubject): boolean {
  if (p.tier !== 'native') return false;
  if (!p.trust) return true;
  /*
    Re-ask when the plugin CHANGED tier.

    A record written for a sandboxed install cannot authorise a native one.
    This is the sandboxed-becomes-native escalation, and it is checked here
    rather than at the call site because every call site would have to
    remember it.
  */
  if (p.trust.tier !== 'native') return true;
  return false;
}

/**
 * May this plugin run unsandboxed right now?
 *
 * The inverse of `needsNativeConsent` for the native tier, and trivially true
 * for the sandboxed one — a sandboxed plugin always runs, in its sandbox.
 */
export function mayRunNative(p: NativeTrustSubject): boolean {
  return p.tier === 'native' && !needsNativeConsent(p);
}

/**
 * Trust does NOT survive an update, and this is the deliberate part.
 *
 * ── The argument for keeping it across versions ──────────────────────────────
 *
 * Every version is signed by the same pinned key, so an update is provably the
 * same author. Re-prompting on each release trains people to click through —
 * and a prompt everyone dismisses protects nobody.
 *
 * ── Why it is not kept anyway ────────────────────────────────────────────────
 *
 * Because the thing being authorised is unbounded. For a permission the answer
 * is "the same author may keep doing the same bounded thing", which is fine.
 * Here the answer would be "the same author may do ANYTHING, forever, on every
 * machine, without being asked again" — and the author is one stolen laptop or
 * one compromised CI token away from not being the author any more. Key
 * rotation is announced; a signing key used by someone who should not have it
 * is not.
 *
 * The compromise: a MINOR or PATCH release keeps trust, a MAJOR does not. A
 * major version is the author themselves saying the plugin changed
 * substantially, which is exactly when a fresh look is worth the interruption,
 * and it is rare enough not to become noise.
 */
export function trustSurvivesUpdate(granted: string, incoming: string): boolean {
  const major = (v: string): number => Number.parseInt(v.split('.')[0] ?? '', 10);
  const a = major(granted);
  const b = major(incoming);
  // An unparseable version is not a match. Failing closed here costs one
  // prompt; failing open grants unrestricted access on a version string
  // nobody could read.
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return a === b;
}

/** Whether an update to `version` needs consent again. */
export function needsNativeConsentForUpdate(
  p: NativeTrustSubject,
  incomingVersion: string,
): boolean {
  if (p.tier !== 'native') return false;
  if (!p.trust || p.trust.tier !== 'native') return true;
  return !trustSurvivesUpdate(p.trust.version, incomingVersion);
}

/**
 * One line, for the surface that has to ask.
 *
 * Deliberately not a list of capabilities. A permission screen enumerates
 * because the set is bounded and each line is a real choice; there is no
 * bounded set here, and a list would read as "these six things" when the truth
 * is "everything". The sentence has to say that.
 */
export function nativeConsentSummary(name: string, origin: InstallOriginKind): string {
  const provenance =
    origin === 'folder'
      ? 'You picked this folder yourself, so this is your own code'
      : origin === 'file'
        ? 'This came from a file on your machine'
        : 'This came from the marketplace';
  return (
    `${name} runs without the sandbox. It can do anything this application can do — `
    + `read and change any project, reach the filesystem through the app, and it can `
    + `crash or freeze the editor. Nothing limits it once you agree. ${provenance}.`
  );
}
