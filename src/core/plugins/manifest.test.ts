/**
 * The manifest is the only thing read before a plugin's code runs, so every
 * claim the manager makes about a plugin at install time comes from here.
 *
 * Two kinds of test:
 *
 *  1. The SHARED CORPUS — cases that `motion-back`'s validator runs too, from a
 *     byte-identical fixture file. The registry and the editor validate in
 *     different processes on different machines and neither can import the
 *     other, so agreement cannot be enforced by sharing code; it is enforced by
 *     sharing cases. A package the registry accepts and the editor then refuses
 *     is a user who installed something broken.
 *  2. NORMALISATION — what a valid manifest turns into. `contributes` is always
 *     present, `activationEvents` is always non-empty, and a legacy `panel`
 *     string has become a declared panel, so that no consumer downstream has to
 *     know either spelling ever existed.
 */

import { parseManifest, describeContributions, activatesOnStartup, HOST_API_VERSION } from './manifest';
import corpus from './__fixtures__/manifests.json';

interface Case {
  name: string;
  valid: boolean;
  manifest: Record<string, unknown>;
}

const CASES = corpus.cases as Case[];

describe('shared manifest corpus', () => {
  it('has cases on both sides of the line', () => {
    // A corpus that drifted to all-valid or all-invalid would still pass every
    // `it.each` below while testing only half the validator.
    expect(CASES.some((c) => c.valid)).toBe(true);
    expect(CASES.some((c) => !c.valid)).toBe(true);
  });

  it.each(CASES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const { manifest, errors } = parseManifest(c.manifest);
    // Asserted as an object so a failure prints WHY it was refused rather than
    // just `expected null to be truthy`.
    expect({ accepted: manifest !== null, errors: c.valid ? errors : [] })
      .toEqual({ accepted: c.valid, errors: [] });
  });
});

describe('normalisation', () => {
  const base = {
    id: 'com.example.p',
    name: 'P',
    version: '1.0.0',
    description: 'A plugin.',
    main: 'main.js',
  };

  it('always produces a contributes block, even for an API 1 package', () => {
    const { manifest } = parseManifest({ ...base, apiVersion: 1 });
    // No `?? []` anywhere downstream. A key that is sometimes absent and
    // sometimes empty is two representations of one state.
    expect(manifest?.contributes).toEqual({ commands: [], panels: [], layerKinds: [], effects: [] });
  });

  it('turns a legacy panel string into a declared panel titled after the plugin', () => {
    const { manifest } = parseManifest({ ...base, apiVersion: 1, panel: 'ui/panel.html' });
    expect(manifest?.contributes.panels).toEqual([
      // `placement: 'shared'` is part of normalisation, not a default applied by
      // readers: an API-1 package predates the field, and the one thing it must
      // keep doing is landing in the shared host exactly as it always did.
      { id: 'main', title: 'P', entry: 'ui/panel.html', placement: 'shared' },
    ]);
  });

  it('defaults a package with no activationEvents to onStartup', () => {
    // The API 1 behaviour, and the safe reading of "no opinion": a plugin that
    // does not say when it is needed has to be assumed to be needed always.
    const { manifest } = parseManifest({ ...base, apiVersion: 1 });
    expect(manifest?.activationEvents).toEqual(['onStartup']);
    expect(activatesOnStartup(manifest!)).toBe(true);
  });

  it('treats an empty activationEvents array as onStartup rather than never', () => {
    // `[]` read literally means "nothing starts this", which is a plugin that
    // can never run. That is never what an author meant to write.
    const { manifest } = parseManifest({ ...base, apiVersion: 2, activationEvents: [] });
    expect(manifest?.activationEvents).toEqual(['onStartup']);
  });

  it('does not start a lazily activated plugin at launch', () => {
    const { manifest } = parseManifest({
      ...base,
      apiVersion: 2,
      contributes: { commands: [{ id: 'go', label: 'Go' }] },
      activationEvents: ['onCommand:go'],
    });
    expect(activatesOnStartup(manifest!)).toBe(false);
  });

  it('accepts the current host API version and refuses the next one', () => {
    expect(parseManifest({ ...base, apiVersion: HOST_API_VERSION }).manifest).not.toBeNull();
    expect(parseManifest({ ...base, apiVersion: HOST_API_VERSION + 1 }).manifest).toBeNull();
  });

  it('keeps declaration order for commands, so the menu is the author s order', () => {
    const { manifest } = parseManifest({
      ...base,
      apiVersion: 2,
      contributes: {
        commands: [
          { id: 'zebra', label: 'Zebra' },
          { id: 'alpha', label: 'Alpha' },
        ],
      },
    });
    expect(manifest?.contributes.commands.map((c) => c.id)).toEqual(['zebra', 'alpha']);
  });
});

describe('describeContributions', () => {
  const summarise = (contributes: unknown): string => {
    const { manifest } = parseManifest({
      id: 'com.example.p', name: 'P', version: '1.0.0', description: 'A plugin.',
      apiVersion: 2, main: 'main.js', contributes,
    });
    return describeContributions(manifest!.contributes);
  };

  it('counts what a listing page shows before install', () => {
    expect(summarise({
      commands: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      panels: [{ id: 'main', title: 'Main', entry: 'p.html' }],
    })).toBe('2 commands · 1 panel');
  });

  it('says so plainly when a plugin adds nothing', () => {
    expect(summarise({})).toBe('Adds no commands or panels.');
  });

  it('singularises, because "1 commands" reads as a bug in the editor', () => {
    expect(summarise({ commands: [{ id: 'a', label: 'A' }] })).toBe('1 command');
  });
});
