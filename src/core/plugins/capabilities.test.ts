/**
 * Capability negotiation: what a plugin may ask for, and what happens if it is
 * not here.
 *
 * ── Why the version number had to be split ──────────────────────────────────
 *
 * `apiVersion` carried four jobs at once — manifest grammar, `contributes`
 * shape, host method surface, effect semantics — and it worked only while those
 * moved together. Adding a host method needs no grammar bump, so a plugin
 * calling a new method had no way to SAY it needed one: it installed happily on
 * an older host and failed at the call site, in front of a user, with an error
 * its author never saw.
 *
 * A version can only express "newer than". A capability expresses "has this
 * particular thing", which is the question actually being asked, and it
 * survives a host that gains features in a different order than the one the
 * plugin was written against.
 *
 * ── The two properties everything else rests on ─────────────────────────────
 *
 *   1. Every manifest already published installs unchanged. There are signed
 *      bytes in the world with no `requires`, and they mean "whatever
 *      apiVersion 4 implied" — not "nothing".
 *   2. A missing capability is refused at INSTALL, never discovered at the
 *      first call.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CAPABILITIES_BY_API_VERSION,
  RUNTIME_CAPABILITIES,
  STATIC_CAPABILITIES,
  checkCapabilities,
  hasCapability,
  hostCapabilities,
  impliedCapabilities,
  isKnownCapability,
  setWebgpuAvailable,
} from './capabilities';
import { HOST_API_VERSION, MANIFEST_VERSION, parseManifest } from './manifest';

afterEach(() => setWebgpuAvailable(true));

const manifest = (extra: Record<string, unknown> = {}) => parseManifest({
  id: 'studio.acme.caps',
  name: 'Caps',
  version: '1.0.0',
  description: 'A plugin used by the capability tests.',
  apiVersion: 4,
  main: 'main.js',
  permissions: [],
  ...extra,
});

describe('the vocabulary', () => {
  it('is additive and permanent, which is what makes it safe to declare', () => {
    /*
      Not a slogan — an assertion about a specific list. A published plugin's
      `requires` is frozen in bytes that were signed, so there is no migration
      for a string that changes meaning: the plugin would install and then do
      something other than what its author declared.

      This test does not stop a rename. Nothing can. It records the names so a
      rename shows up in a diff as what it is, rather than as a tidy-up.
    */
    expect([...STATIC_CAPABILITIES]).toEqual([
      'scene.read', 'scene.write', 'scene.proxy', 'scene.batch', 'scene.structured',
      'animation.read', 'animation.write',
      'assets.read', 'assets.write',
      'timeline', 'composition.manage', 'audio.analyse', 'net.fetch',
      'storage.global', 'storage.project',
      'effects.single', 'effects.multipass',
      'layerkinds', 'exporters', 'importers', 'presets', 'panels', 'wasm',
    ]);
    expect([...RUNTIME_CAPABILITIES]).toEqual(['webgpu']);
  });

  it('has no duplicate between the static and runtime halves', () => {
    // A name in both would resolve differently depending on which list was
    // consulted, and `hostCapabilities` consults both.
    for (const name of RUNTIME_CAPABILITIES) {
      expect(STATIC_CAPABILITIES as readonly string[]).not.toContain(name);
    }
  });

  it('distinguishes "not on this machine" from "never existed"', () => {
    /*
      Two different problems with two different answers — upgrade your hardware
      versus your manifest has a typo — and a single "unknown capability"
      message answers neither.
    */
    setWebgpuAvailable(false);
    expect(isKnownCapability('webgpu')).toBe(true);
    expect(hasCapability('webgpu')).toBe(false);
    expect(isKnownCapability('scene.telepathy')).toBe(false);
  });
});

describe('the two version numbers', () => {
  it('★ have actually diverged — the split stopped being theoretical', () => {
    /*
      They were both 5, and the point of separating them was that one day one
      would move alone. That day was `contributes.exporters`: a new manifest KEY,
      so the grammar went to 6, while the host method surface did not change at
      all — a plugin asks whether it can register an exporter through the
      `exporters` CAPABILITY, not by comparing a version.

      Still asserted as two literals rather than as an inequality: "they differ"
      would pass forever and say nothing the day they move again.
    */
    expect(HOST_API_VERSION).toBe(5);
    expect(MANIFEST_VERSION).toBe(6);
  });

  it('refuses a manifest whose GRAMMAR is newer than this host reads', () => {
    const { manifest: m, errors } = manifest({ apiVersion: MANIFEST_VERSION + 1 });
    expect(m).toBeNull();
    expect(errors.join(' ')).toMatch(/manifest is written for format/i);
  });

  it('accepts one written in the current grammar', () => {
    expect(manifest({ apiVersion: MANIFEST_VERSION }).manifest).not.toBeNull();
  });
});

describe('what a manifest with no requires means', () => {
  it('is what its apiVersion implied, not "nothing"', () => {
    /*
      The back-compat property, and the whole reason the table is pinned rather
      than computed from `STATIC_CAPABILITIES`. An API-4 author could see the
      whole surface of API 4 and reasonably assumed all of it — but that list
      will grow, and an API-4 plugin must not retroactively be treated as having
      asked for things that did not exist when it was signed.
    */
    expect(impliedCapabilities(4, undefined)).toEqual(CAPABILITIES_BY_API_VERSION[4]);
    expect(impliedCapabilities(4, undefined)).not.toContain('storage.global');
    expect(impliedCapabilities(4, undefined)).not.toContain('scene.batch');
    expect(impliedCapabilities(4, undefined)).not.toContain('effects.multipass');
  });

  it('grows with the version, and never shrinks', () => {
    // A later apiVersion could see everything an earlier one could. A gap here
    // would mean upgrading a manifest's version silently took something away.
    for (const v of [2, 3, 4]) {
      const older = new Set(CAPABILITIES_BY_API_VERSION[v - 1]);
      for (const cap of older) {
        expect(CAPABILITIES_BY_API_VERSION[v]).toContain(cap);
      }
    }
  });

  it('names only capabilities that exist', () => {
    // A typo here would grant nothing and be invisible: the implied set is
    // checked against the host, and an unknown name would refuse every legacy
    // plugin at install with a message about a capability nobody wrote.
    for (const [version, caps] of Object.entries(CAPABILITIES_BY_API_VERSION)) {
      for (const cap of caps) {
        expect({ version, cap, known: isKnownCapability(cap) })
          .toEqual({ version, cap, known: true });
      }
    }
  });

  it('is overridden outright by an explicit list', () => {
    // An author who wrote `requires` is saying exactly what they need. Adding
    // the implied set on top would make a refusal mention something they never
    // asked for.
    expect(impliedCapabilities(4, ['storage.global'])).toEqual(['storage.global']);
  });
});

describe('the install check', () => {
  it('passes an apiVersion 4 manifest with no requires', () => {
    // The case that must never break: every plugin currently published.
    expect(checkCapabilities(4, undefined).ok).toBe(true);
  });

  it('passes a manifest requiring things this host has', () => {
    expect(checkCapabilities(5, ['scene.read', 'storage.project']).ok).toBe(true);
  });

  it('refuses an unknown capability, and says the manifest may be wrong', () => {
    const result = checkCapabilities(5, ['scene.telepathy']);
    expect(result.ok).toBe(false);
    expect(result.unrecognised).toEqual(['scene.telepathy']);
    expect(result.message).toMatch(/no version of Premation provides/i);
    expect(result.message).toMatch(/typo/i);
  });

  it('refuses a known capability this machine lacks, and blames the machine', () => {
    /*
      The distinction that decides whether the message is useful. "Your manifest
      has a typo" is wrong and insulting when the plugin is fine and the laptop
      has no WebGPU; "update the app" is wrong when no version has the feature.
    */
    setWebgpuAvailable(false);
    const result = checkCapabilities(5, ['webgpu']);
    expect(result.ok).toBe(false);
    expect(result.unavailable).toEqual(['webgpu']);
    expect(result.message).toMatch(/WebGL2 fallback/i);
    expect(result.message).not.toMatch(/typo/i);
  });

  it('refuses an apiVersion 4 manifest on WebGL2, because 4 implied webgpu', () => {
    /*
      Deliberate, and the sharpest consequence of the back-compat table. API 4
      is the version that introduced effects, so a plugin written against it
      could assume a GPU that runs them. On the WebGL2 tier such a plugin's
      effects render their input unchanged — it is not degraded, it is inert,
      and installing it would leave the user with something that looks installed
      and does nothing.
    */
    setWebgpuAvailable(false);
    expect(checkCapabilities(4, undefined).ok).toBe(false);
    // An API-3 plugin has no effects and is unaffected.
    expect(checkCapabilities(3, undefined).ok).toBe(true);
  });

  it('reports both kinds of problem at once', () => {
    setWebgpuAvailable(false);
    const result = checkCapabilities(5, ['webgpu', 'scene.telepathy']);
    expect(result.unavailable).toEqual(['webgpu']);
    expect(result.unrecognised).toEqual(['scene.telepathy']);
  });
});

describe('the manifest fields', () => {
  it('parses requires and optional', () => {
    const { manifest: m } = manifest({
      apiVersion: 5,
      requires: ['storage.project'],
      optional: ['webgpu'],
    });
    expect(m?.requires).toEqual(['storage.project']);
    expect(m?.optional).toEqual(['webgpu']);
  });

  it('omits them when empty rather than storing []', () => {
    // Absent means "whatever apiVersion implied", which is a different
    // statement from "needs nothing" — and every already-published manifest
    // means the first one.
    const { manifest: m } = manifest();
    expect(m).not.toHaveProperty('requires');
    expect(m).not.toHaveProperty('optional');
  });

  it('accepts a capability name this host does not have', () => {
    /*
      Shape validation only. Refusing `webgpu` here would make the plugin
      UNREADABLE on a WebGL2 machine rather than merely uninstallable, and would
      stop the registry — which has no GPU at all — from validating it on
      publish. Whether a capability is present is an install-time question.
    */
    setWebgpuAvailable(false);
    expect(manifest({ apiVersion: 5, requires: ['webgpu'] }).manifest?.requires)
      .toEqual(['webgpu']);
  });

  it('refuses a malformed name', () => {
    const { errors } = manifest({ apiVersion: 5, requires: ['Scene.Read', 42] });
    expect(errors.join(' ')).toMatch(/not a capability name/);
  });

  it('deduplicates', () => {
    expect(manifest({ apiVersion: 5, requires: ['wasm', 'wasm'] }).manifest?.requires)
      .toEqual(['wasm']);
  });
});

describe('the fixture the registry holds too', () => {
  const fixture = JSON.parse(
    readFileSync(join(__dirname, '__fixtures__', 'capabilityBackCompat.json'), 'utf8'),
  ) as {
    staticCapabilities: string[];
    runtimeCapabilities: string[];
    capabilitiesByApiVersion: Record<string, string[]>;
  };

  it('matches the vocabulary this host declares', () => {
    /*
      The registry validates a manifest on publish; the editor gates the
      install. If the two disagree about the vocabulary, a plugin publishes in
      one and refuses to install in the other — with no error on the side that
      could have caught it. Byte-identical fixtures plus a check on each side is
      the only mechanism keeping them in step; `scripts/fixtures-hash.mjs` makes
      a one-sided edit red in both.
    */
    expect(fixture.staticCapabilities).toEqual([...STATIC_CAPABILITIES]);
    expect(fixture.runtimeCapabilities).toEqual([...RUNTIME_CAPABILITIES]);
  });

  it('matches the back-compat table', () => {
    // The most important half. This is what an already-published manifest is
    // taken to mean, and a disagreement here silently changes what a signed
    // plugin asked for.
    const ours = Object.fromEntries(
      Object.entries(CAPABILITIES_BY_API_VERSION).map(([v, caps]) => [v, [...caps]]),
    );
    expect(ours).toEqual(fixture.capabilitiesByApiVersion);
  });
});

describe('what the host reports at boot', () => {
  it('includes webgpu on the WebGPU tier and not on WebGL2', () => {
    expect(hostCapabilities().has('webgpu')).toBe(true);
    setWebgpuAvailable(false);
    expect(hostCapabilities().has('webgpu')).toBe(false);
    // The static half is unaffected either way.
    expect(hostCapabilities().has('scene.read')).toBe(true);
  });

  it('is resolved per call, never captured at module load', () => {
    // The renderer tier is decided during boot, after this module is first
    // imported through the app graph. A snapshot would freeze the default.
    setWebgpuAvailable(false);
    expect(hasCapability('webgpu')).toBe(false);
    setWebgpuAvailable(true);
    expect(hasCapability('webgpu')).toBe(true);
  });
});
