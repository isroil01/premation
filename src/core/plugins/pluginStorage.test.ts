/**
 * Somewhere for a plugin to keep things, and the two scopes it can choose.
 *
 * ── The ceiling this removes ─────────────────────────────────────────────────
 *
 * Nothing in the host API persisted plugin state. Layer-kind props were the only
 * channel, and they are scoped to layers of the plugin's own kind — so a plugin
 * with no layer kind had nowhere at all to put a preference, and one with a
 * layer kind could only remember things ABOUT a layer. An importer could not
 * remember its last folder; a rig tool could not remember which bones it named.
 *
 * ── The property that decides whether the scopes are worth having ────────────
 *
 * `global` survives a restart and does NOT travel. `project` travels with the
 * file and is retained even on a machine where the plugin is not installed.
 * Getting either backwards is felt rather than fatal: machine settings in
 * `project` arrive as a colleague's preferences, and document state in `global`
 * is gone the moment the file moves.
 */

import {
  MAX_VALUE_BYTES,
  PluginStorageQuotaError,
  QUOTA_BYTES,
  assertScope,
  captureProjectStorage,
  forgetProjectStorage,
  projectStorageOwners,
  resetStorageForTests,
  restoreProjectStorage,
  storageDelete,
  storageGet,
  storageList,
  storageSet,
  storageUsage,
} from './pluginStorage';

const A = 'studio.acme.one';
const B = 'studio.other.two';

beforeEach(() => resetStorageForTests());

describe.each(['global', 'project'] as const)('%s scope', (scope) => {
  it('reads back what it wrote', () => {
    storageSet(scope, A, 'lastFolder', '/Users/x/projects');
    expect(storageGet(scope, A, 'lastFolder')).toBe('/Users/x/projects');
  });

  it('round-trips structure, not just strings', () => {
    const value = { planes: 3, names: ['a', 'b'], nested: { on: true }, missing: null };
    storageSet(scope, A, 'config', value);
    expect(storageGet(scope, A, 'config')).toEqual(value);
  });

  it('answers null for a key that was never written', () => {
    // `null`, not `undefined` — the value crosses `postMessage`, where
    // `undefined` on an object property is indistinguishable from absence.
    expect(storageGet(scope, A, 'nope')).toBeNull();
  });

  it('deletes', () => {
    storageSet(scope, A, 'k', 1);
    storageDelete(scope, A, 'k');
    expect(storageGet(scope, A, 'k')).toBeNull();
    expect(storageList(scope, A)).toEqual([]);
  });

  it('lists keys, sorted, and filters by prefix', () => {
    // Sorted, so a plugin iterating twice sees the same order. Insertion order
    // would hold in practice and is not something a store that round-trips
    // through JSON should promise.
    storageSet(scope, A, 'ui.theme', 'dark');
    storageSet(scope, A, 'net.host', 'x');
    storageSet(scope, A, 'ui.collapsed', true);
    expect(storageList(scope, A)).toEqual(['net.host', 'ui.collapsed', 'ui.theme']);
    expect(storageList(scope, A, 'ui.')).toEqual(['ui.collapsed', 'ui.theme']);
  });

  it('keeps one plugin out of another s bag', () => {
    /*
      The isolation the whole design rests on. The plugin id is supplied by the
      HOST from the manifest, never by the caller — the scope and key cross a
      `postMessage` from third-party code and the identity does not.
    */
    storageSet(scope, A, 'secret', 'mine');
    expect(storageGet(scope, B, 'secret')).toBeNull();
    expect(storageList(scope, B)).toEqual([]);
  });
});

describe('what a key may be', () => {
  it.each([
    ['with a space', 'my key'],
    ['with a newline', 'a\nb'],
    ['with a slash', 'a/b'],
    ['with a backslash', 'a\\b'],
    ['with a quote', 'a"b'],
    ['with an apostrophe', "a'b"],
    ['empty', ''],
    ['too long', 'x'.repeat(201)],
    ['not a string', 42],
  ])('refuses one %s', (_label, key) => {
    /*
      Narrower than storage needs, deliberately. Keys end up in error messages,
      in log lines, and — for `project` — in a JSON document a human may open. A
      key containing a newline turns one log line into two; one containing a
      quote turns a message into something that reads as truncated.
    */
    expect(() => storageSet('global', A, key, 1)).toThrow(/not a usable storage key/);
  });

  it('accepts the shapes an author actually uses', () => {
    for (const key of ['theme', 'ui.panel.collapsed', 'cache:v2', 'a-b_c', 'x'.repeat(200)]) {
      expect(() => storageSet('global', A, key, 1)).not.toThrow();
    }
  });
});

describe('what a value may be', () => {
  it('refuses undefined, and points at delete', () => {
    // `JSON.stringify(undefined)` is `undefined`, not `"undefined"`. Storing it
    // would make `get` indistinguishable from a missing key.
    expect(() => storageSet('global', A, 'k', undefined)).toThrow(/storage\.delete/);
  });

  it('refuses a cycle, at the write rather than the read', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => storageSet('global', A, 'k', cyclic)).toThrow(/cannot be stored/);
  });

  it('refuses one value past the per-value cap', () => {
    expect(() => storageSet('global', A, 'k', 'x'.repeat(MAX_VALUE_BYTES + 1)))
      .toThrow(/limited to 64 KB/);
  });
});

describe('the quota', () => {
  it('throws a catchable error, not a truncation', () => {
    /*
      A named class, and the reason is what a plugin does next. One that wants
      to degrade — drop its cache, keep its settings — has to be able to catch
      exactly this, and `err.message.includes('quota')` is the check that breaks
      the day someone improves the wording. Silent truncation would be worse
      still: the plugin believes it stored something.
    */
    let thrown: unknown;
    try {
      for (let i = 0; i < 500; i++) storageSet('project', A, `k${i}`, 'x'.repeat(60 * 1024));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PluginStorageQuotaError);
    expect((thrown as PluginStorageQuotaError).code).toBe('storage-quota-exceeded');
    expect((thrown as PluginStorageQuotaError).scope).toBe('project');
  });

  it('is smaller for project than for global', () => {
    // Every byte of `project` rides in something the user emails, syncs and
    // versions — a plugin that quietly quadrupled a document's size would be
    // blamed on the editor.
    expect(QUOTA_BYTES.project).toBeLessThan(QUOTA_BYTES.global);
  });

  it('lets a plugin at its limit OVERWRITE with something smaller', () => {
    /*
      The case a naive check gets wrong. Charging the new value without
      discounting the key it replaces means a plugin at its limit cannot shrink
      a value — which is the exact moment it is trying to behave.
    */
    const big = 'x'.repeat(60 * 1024);
    for (let i = 0; i < 4; i++) storageSet('project', A, `k${i}`, big);
    expect(() => storageSet('project', A, 'k0', 'small')).not.toThrow();
    expect(storageGet('project', A, 'k0')).toBe('small');
  });

  it('is per plugin, not shared', () => {
    storageSet('project', A, 'k', 'x'.repeat(60 * 1024));
    const before = storageUsage('project', B).used;
    expect(before).toBe(0);
  });

  it('reports usage against the limit', () => {
    storageSet('global', A, 'k', 'hello');
    const { used, limit } = storageUsage('global', A);
    expect(used).toBeGreaterThan(0);
    expect(limit).toBe(QUOTA_BYTES.global);
  });
});

describe('the project scope in a document', () => {
  it('is absent from a document that has none', () => {
    // Absent rather than `{}`, so every document written before this reads back
    // byte-identical and needs no migration.
    expect(captureProjectStorage()).toBeUndefined();
  });

  it('round-trips through capture and restore', () => {
    storageSet('project', A, 'spine', 'layer_7');
    const captured = captureProjectStorage();

    resetStorageForTests();
    expect(storageGet('project', A, 'spine')).toBeNull();

    restoreProjectStorage(captured);
    expect(storageGet('project', A, 'spine')).toBe('layer_7');
  });

  it('does not carry one document s state into the next', () => {
    // Assigned unconditionally on restore. A project opened after one that had
    // plugin state must not inherit it — that would be a plugin reading a
    // colleague's answers as its own.
    storageSet('project', A, 'spine', 'layer_7');
    restoreProjectStorage(undefined);
    expect(storageGet('project', A, 'spine')).toBeNull();
    expect(captureProjectStorage()).toBeUndefined();
  });

  it('RETAINS state for a plugin that is not installed', () => {
    /*
      The property that makes `project` scope safe to use at all. Opening a file
      on a machine that lacks the plugin and saving it must not destroy state
      that machine cannot even see — the user would have no way to know it
      happened, and the colleague who does have the plugin would find their work
      gone with no event to point at.
    */
    restoreProjectStorage({ 'studio.absent.plugin': { rig: '"spine"' } });
    expect(captureProjectStorage()).toEqual({ 'studio.absent.plugin': { rig: '"spine"' } });
    expect(projectStorageOwners()).toEqual(['studio.absent.plugin']);
  });

  it('is forgotten only when something explicitly asks', () => {
    // Garbage collection is a user action, never a side effect of opening.
    restoreProjectStorage({ [A]: { k: '1' } });
    forgetProjectStorage(A);
    expect(captureProjectStorage()).toBeUndefined();
  });

  it('ignores a malformed block rather than throwing on open', () => {
    // Hand-edited, or written by a build that stored something else. A document
    // that fails to open is worse than one that opens without a plugin's notes.
    for (const bad of [null, 42, [1, 2], { a: 'not-a-bag' }, { a: { k: 5 } }]) {
      restoreProjectStorage(bad);
      expect(captureProjectStorage()).toBeUndefined();
    }
  });

  it('drops a plugin whose bag emptied, so an empty bag is not carried forever', () => {
    restoreProjectStorage({ [A]: { k: '1' } });
    storageDelete('project', A, 'k');
    expect(captureProjectStorage()).toBeUndefined();
  });
});

describe('the scope argument', () => {
  it('accepts the two real ones', () => {
    expect(assertScope('global')).toBe('global');
    expect(assertScope('project')).toBe('project');
  });

  it('refuses anything else, since it crossed postMessage', () => {
    for (const bad of ['Global', 'local', '', null, 1, {}]) {
      expect(() => assertScope(bad)).toThrow(/is not a storage scope/);
    }
  });
});
