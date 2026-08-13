/**
 * Who may create a layer kind, and when it stops being creatable.
 *
 * Own-kinds-only is a permission-class boundary, not a tidiness rule. A plugin
 * that could write another plugin's layers could rewrite the authored interface
 * of software the user chose to trust differently; one that could observe them
 * would see a document it was never meaningfully granted access to. So the
 * cross-plugin attempt is tested explicitly, and the refusal has to NAME the
 * problem — all three failure shapes present to an author as "my createLayer
 * does nothing" otherwise.
 */

import {
  allLayerKinds,
  checkOwnership,
  findKindFor,
  findLayerKind,
  isCreatableKind,
  layerKindRevision,
  registerLayerKinds,
  resetLayerKindsForTests,
  subscribeToLayerKinds,
  unregisterLayerKinds,
} from './layerKindRegistry';
import type { LayerKindContribution } from './layerKindSchema';

const KIND = (id: string, label = id): LayerKindContribution => ({
  id,
  label,
  render: 'proxy',
  schemaVersion: 1,
  props: { focal: { type: 'number', default: 50, min: 0, max: 100, animatable: true } },
});

const ACME = 'studio.acme.lab';
const OTHER = 'studio.other.tools';

beforeEach(() => resetLayerKindsForTests());

describe('registration', () => {
  it('makes a declared kind creatable', () => {
    registerLayerKinds(ACME, 'Acme Lab', [KIND('depthImage', 'Depth Image')]);
    expect(isCreatableKind('studio.acme.lab.depthImage')).toBe(true);
    expect(findKindFor(ACME, 'depthImage')?.label).toBe('Depth Image');
    expect(findLayerKind('studio.acme.lab.depthImage')?.pluginName).toBe('Acme Lab');
  });

  it('unregisters everything a stopped plugin declared', () => {
    registerLayerKinds(ACME, 'Acme Lab', [KIND('a'), KIND('b')]);
    registerLayerKinds(OTHER, 'Other', [KIND('c')]);

    unregisterLayerKinds(ACME);

    // A menu that still offers to create a layer nothing can drive, and a
    // document that gains a reference to a plugin the user turned off.
    expect(isCreatableKind('studio.acme.lab.a')).toBe(false);
    expect(isCreatableKind('studio.acme.lab.b')).toBe(false);
    // And it took only its own with it.
    expect(isCreatableKind('studio.other.tools.c')).toBe(true);
  });

  it('replaces rather than accumulates when a plugin re-registers', () => {
    // A reload during development, or a version that dropped a kind. Leaving
    // the old one registered offers a layer the new code cannot drive.
    registerLayerKinds(ACME, 'Acme Lab', [KIND('a'), KIND('b')]);
    registerLayerKinds(ACME, 'Acme Lab', [KIND('a')]);
    expect(isCreatableKind('studio.acme.lab.a')).toBe(true);
    expect(isCreatableKind('studio.acme.lab.b')).toBe(false);
  });

  it('lists kinds in a stable order, so a menu does not reshuffle', () => {
    registerLayerKinds(OTHER, 'Zeta Tools', [KIND('z', 'Zed')]);
    registerLayerKinds(ACME, 'Acme Lab', [KIND('b', 'Beta'), KIND('a', 'Alpha')]);
    expect(allLayerKinds().map((k) => k.kind.label)).toEqual(['Alpha', 'Beta', 'Zed']);
  });

  it('notifies subscribers, so menus and the layer tree can follow', () => {
    let calls = 0;
    const stop = subscribeToLayerKinds(() => { calls += 1; });
    registerLayerKinds(ACME, 'Acme Lab', [KIND('a')]);
    unregisterLayerKinds(ACME);
    stop();
    registerLayerKinds(ACME, 'Acme Lab', [KIND('a')]);

    expect(calls).toBe(2);
    expect(layerKindRevision()).toBeGreaterThan(0);
  });

  it('does not notify for unregistering a plugin that had nothing', () => {
    let calls = 0;
    subscribeToLayerKinds(() => { calls += 1; });
    unregisterLayerKinds('studio.nobody.here');
    expect(calls).toBe(0);
  });
});

describe('a plugin may only touch its own kinds', () => {
  beforeEach(() => {
    registerLayerKinds(ACME, 'Acme Lab', [KIND('depthImage')]);
    registerLayerKinds(OTHER, 'Other Tools', [KIND('gizmo')]);
  });

  it('allows its own', () => {
    const check = checkOwnership(ACME, 'studio.acme.lab.depthImage');
    expect(check.ok).toBe(true);
  });

  it("REFUSES another plugin's, naming the owner", () => {
    const check = checkOwnership(ACME, 'studio.other.tools.gizmo');
    expect(check.ok).toBe(false);
    // Named, not silent. The author has to be able to tell this from a typo.
    expect((check as { message: string }).message)
      .toMatch(/belongs to "studio\.other\.tools".*only create, change or observe its own/s);
  });

  it('distinguishes "you never declared this" from "that plugin is not running"', () => {
    // Same symptom, different fixes: fix your manifest, versus install a plugin.
    expect((checkOwnership(ACME, 'studio.acme.lab.nope') as { message: string }).message)
      .toMatch(/does not declare a layer kind "nope"/);
    expect((checkOwnership(ACME, 'studio.ghost.app.thing') as { message: string }).message)
      .toMatch(/may not be installed or enabled/);
  });

  it('refuses a bare native kind, so `shape` cannot be claimed', () => {
    const check = checkOwnership(ACME, 'shape');
    expect(check.ok).toBe(false);
    expect((check as { message: string }).message).toMatch(/not a plugin layer kind/);
  });

  it('refuses anything that is not a string, because this crossed postMessage', () => {
    for (const bad of [undefined, null, 42, {}, ['x']]) {
      expect(checkOwnership(ACME, bad).ok).toBe(false);
    }
  });

  it('stops allowing its own kinds once the plugin is unregistered', () => {
    // The ownership check and the creatability check are the same lookup, so a
    // stopped plugin cannot create its own layers either.
    unregisterLayerKinds(ACME);
    expect(checkOwnership(ACME, 'studio.acme.lab.depthImage').ok).toBe(false);
  });
});
