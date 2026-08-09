/**
 * What this host can do, as a set of names a plugin can ask about.
 *
 * ── Why one integer was not enough ───────────────────────────────────────────
 *
 * `apiVersion` used to carry four unrelated jobs at once: the manifest grammar,
 * the shape of `contributes`, the host method surface, and effect semantics. It
 * worked while those moved together, and it stops working the moment they do
 * not — which is immediately. Adding a 34th host method requires no version
 * bump, because nothing about the manifest changed. So a plugin calling that
 * method has no way to SAY it needs it: it installs happily on an older host
 * and fails at the call site, in front of a user, with an error the author
 * never saw.
 *
 * A version number can only express "newer than". A capability set expresses
 * "has this particular thing", which is the question a plugin is actually
 * asking, and it survives a host that gains features in a different order than
 * the one they were written in.
 *
 * ── The rules, which are not negotiable ──────────────────────────────────────
 *
 * Capability strings are **additive and permanent**. Never renamed, never
 * removed, never repurposed. A published plugin's `requires` list is frozen in
 * bytes that were signed — there is no migration path for a string that changes
 * meaning, and the failure mode is a plugin that installs and then does
 * something other than what its author declared.
 *
 * That makes adding one cheap and changing one impossible, which is the correct
 * asymmetry: the cost of a badly-named capability is one redundant string in
 * this list forever, and the cost of renaming one is a plugin that lies.
 */

/**
 * Capabilities every build of this host has.
 *
 * Frozen, and deliberately not derived from anything. Deriving it — from the
 * method table, say — would make the set change silently when an unrelated
 * refactor split a method in two, and this list is a PROMISE to third-party
 * code rather than a description of the current implementation.
 */
export const STATIC_CAPABILITIES = Object.freeze([
  'scene.read',
  'scene.write',
  'scene.proxy',
  'scene.batch',
  'animation.read',
  'animation.write',
  'assets.read',
  'assets.write',
  'timeline',
  'net.fetch',
  'storage.global',
  'storage.project',
  'effects.single',
  'effects.multipass',
  'layerkinds',
  'panels',
  'wasm',
] as const);

/**
 * Capabilities that depend on the machine, not the build.
 *
 * `webgpu` is the only one so far and it is the reason this concept exists at
 * all. A plugin effect is WGSL; on the WebGL2 tier it renders its input
 * unchanged, so an effect plugin installed there is not degraded, it is inert.
 * Listing `webgpu` in `requires` is how an author says "there is no point
 * installing me here", and it is a far better answer than a plugin that appears
 * to work and quietly does nothing.
 *
 * Resolved per call rather than captured, because the renderer tier is decided
 * during boot — after this module is first imported.
 */
export const RUNTIME_CAPABILITIES = Object.freeze(['webgpu'] as const);

export type HostCapability =
  | (typeof STATIC_CAPABILITIES)[number]
  | (typeof RUNTIME_CAPABILITIES)[number];

/**
 * Whether the renderer can run a plugin effect at all.
 *
 * Injected rather than imported so this module stays free of the render stack —
 * it is read during manifest validation, which must work in a test with no GPU
 * and no backend. Defaults to TRUE: an unconfigured host is the hosted product
 * on WebGPU, and defaulting the other way would refuse every effect plugin on
 * every machine until something remembered to set it.
 */
let webgpuAvailable = true;

export function setWebgpuAvailable(available: boolean): void {
  webgpuAvailable = available;
}

/** Every capability this host has RIGHT NOW, including runtime ones. */
export function hostCapabilities(): ReadonlySet<HostCapability> {
  const out = new Set<HostCapability>(STATIC_CAPABILITIES);
  if (webgpuAvailable) out.add('webgpu');
  return out;
}

/** Is this string a capability this host has? */
export function hasCapability(name: string): boolean {
  return hostCapabilities().has(name as HostCapability);
}

/**
 * Every capability name this host has ever known, present or not.
 *
 * The distinction that makes an install refusal legible. "This plugin needs
 * `webgpu`, which this machine does not have" and "this plugin needs
 * `scene.telepathy`, which no version of Premation has" are different problems
 * with different answers — upgrade your hardware versus the manifest has a
 * typo — and a single "unknown capability" message answers neither.
 */
export function isKnownCapability(name: string): boolean {
  return (STATIC_CAPABILITIES as readonly string[]).includes(name)
    || (RUNTIME_CAPABILITIES as readonly string[]).includes(name);
}

/**
 * What an `apiVersion` implied before capabilities existed.
 *
 * A manifest written against API 4 declared no capabilities, because there were
 * none to declare — but it was written by an author who could see the whole
 * surface of API 4 and reasonably assumed all of it. Granting that set is what
 * makes every published plugin keep working, and pinning it in a table rather
 * than computing it from `STATIC_CAPABILITIES` is what keeps it true: the list
 * above will grow, and an API-4 plugin must not retroactively be treated as
 * having asked for things that did not exist when it was signed.
 *
 * Asserted against `__fixtures__/capabilityBackCompat.json`, which both repos
 * hold, so the registry and the editor cannot disagree about what an old
 * manifest meant.
 */
export const CAPABILITIES_BY_API_VERSION: Readonly<Record<number, readonly HostCapability[]>> = {
  1: ['scene.read', 'scene.write', 'animation.read', 'animation.write', 'timeline', 'panels'],
  2: ['scene.read', 'scene.write', 'animation.read', 'animation.write', 'timeline', 'panels'],
  3: [
    'scene.read', 'scene.write', 'scene.proxy', 'animation.read', 'animation.write',
    'assets.read', 'assets.write', 'timeline', 'panels', 'layerkinds',
  ],
  4: [
    'scene.read', 'scene.write', 'scene.proxy', 'animation.read', 'animation.write',
    'assets.read', 'assets.write', 'timeline', 'net.fetch', 'panels', 'layerkinds',
    'effects.single', 'webgpu',
  ],
};

/**
 * The capabilities a manifest is treated as requiring.
 *
 * An explicit `requires` list wins outright — an author who wrote one is saying
 * exactly what they need, and quietly adding to it would make the install
 * refusal mention something they never asked for.
 */
export function impliedCapabilities(
  apiVersion: number,
  requires: readonly string[] | undefined,
): readonly string[] {
  if (requires && requires.length > 0) return requires;
  return CAPABILITIES_BY_API_VERSION[apiVersion] ?? [];
}

export interface CapabilityCheck {
  ok: boolean;
  /** Named in the manifest, known to this host, absent on this machine. */
  unavailable: string[];
  /** Named in the manifest and unknown to every version of this host. */
  unrecognised: string[];
  /** One sentence for a user, empty when `ok`. */
  message: string;
}

/**
 * Can this manifest run here?
 *
 * Answered at INSTALL time, not at first call. A plugin that installs and then
 * fails is worse than one that never installs: the user has already agreed to
 * its permissions, it sits in their list looking healthy, and the failure
 * arrives later attached to whatever they were doing at the time.
 */
export function checkCapabilities(
  apiVersion: number,
  requires: readonly string[] | undefined,
): CapabilityCheck {
  const needed = impliedCapabilities(apiVersion, requires);
  const present = hostCapabilities();

  const unrecognised = needed.filter((c) => !isKnownCapability(c));
  const unavailable = needed.filter((c) => isKnownCapability(c) && !present.has(c as HostCapability));

  if (unrecognised.length === 0 && unavailable.length === 0) {
    return { ok: true, unavailable: [], unrecognised: [], message: '' };
  }

  const parts: string[] = [];
  if (unavailable.length > 0) {
    parts.push(
      unavailable.includes('webgpu')
        // Named specifically, because it is the one a user can do nothing about
        // and the one they will otherwise read as "the app is broken".
        ? 'It needs a graphics backend this machine does not provide (WebGPU). '
          + 'Premation is running on the WebGL2 fallback here.'
        : `It needs ${list(unavailable)}, which this build does not provide.`,
    );
  }
  if (unrecognised.length > 0) {
    parts.push(
      `It needs ${list(unrecognised)}, which no version of Premation provides — `
      + 'either the plugin is written for a newer release, or its manifest has a typo.',
    );
  }

  return { ok: false, unavailable, unrecognised, message: parts.join(' ') };
}

function list(items: readonly string[]): string {
  const quoted = items.map((i) => `"${i}"`);
  if (quoted.length === 1) return quoted[0]!;
  return `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}
