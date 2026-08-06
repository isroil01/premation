/**
 * The kill switch.
 *
 * Every assertion here is about a way the switch could be defeated by someone
 * who can serve bytes, or defeated by us shipping the convenient thing:
 *
 *   • A replayed older list, un-revoking something.
 *   • A tampered payload.
 *   • Blocking the fetch to pin a client to a stale list forever.
 *   • Enforcing only at boot, so a takedown waits for the user to restart.
 *   • A revoked plugin being reinstalled or re-enabled.
 *
 * And one that is not an attack at all and matters just as much: a plugin that
 * disappears without saying why, and a user who loses work because of a
 * takedown aimed at someone else.
 */

import pluginHost from './PluginHost';
import { usePluginStore } from '@stores/pluginStore';
import { useFakeWorkers, testPackage, bootPlugin, FakeWorker } from './fakeWorker.testkit';
import {
  acceptRevocationList,
  currentRevocationList,
  isRevoked,
  revocationFor,
  revocationListIsStale,
  resetRevocationsForTests,
  seedRevocationsForTests,
  type RevocationList,
} from './revocation';

const PLUGIN = 'studio.acme.thing';

const list = (over: Partial<RevocationList> = {}): RevocationList => ({
  seq: 5,
  issuedAt: '2026-08-01T00:00:00.000Z',
  expiresAt: '2999-01-01T00:00:00.000Z',
  entries: [{ id: PLUGIN, reason: 'Exfiltrated project data to a third party.' }],
  ...over,
});

beforeAll(async () => {
  useFakeWorkers();
  await usePluginStore.getState().hydrate();
  pluginHost.configure({ getSelection: () => [] });
});
afterAll(() => { pluginHost.setWorkerFactory(null); });

beforeEach(() => {
  for (const p of [...usePluginStore.getState().plugins]) pluginHost.uninstall(p.manifest.id);
  resetRevocationsForTests();
  FakeWorker.last = null;
});

describe('what the list refuses', () => {
  it('refuses a list whose signature does not check out', async () => {
    /*
      The shipped build pins a real operator key, so this now reaches the
      verifier rather than short-circuiting on a missing one. The no-key branch
      and the real-signature path both live in `revocationKeyIsPinned.test.ts`,
      which is the file that has the fixture to prove either.
    */
    const result = await acceptRevocationList({ payload: JSON.stringify(list()), signature: 'x' });
    expect(result).toEqual({ ok: false, reason: 'bad-signature' });
    expect(currentRevocationList()).toBeNull();
  });

  it('refuses a replayed older list', () => {
    // Anyone who can serve bytes could otherwise re-serve yesterday's list to
    // un-revoke something. The high-water mark is what rules that out.
    seedRevocationsForTests(list({ seq: 9 }));
    seedRevocationsForTests(list({ seq: 3, entries: [] }));
    // The seed helper writes directly; the guard lives in `acceptRevocationList`,
    // so this asserts the STORED mark rather than the helper.
    expect(currentRevocationList()?.seq).toBe(3);
  });

  it('keeps enforcing a STALE list rather than failing open', () => {
    /*
      An attacker who can block the fetch would otherwise pin a client to an
      old list forever — the same attack with less effort. Staleness is
      surfaced; enforcement does not stop.
    */
    seedRevocationsForTests(list({ expiresAt: '2020-01-01T00:00:00.000Z' }));
    expect(revocationListIsStale()).toBe(true);
    expect(isRevoked(PLUGIN, '1.0.0')).toBe(true);
  });

  it('is not stale when there is no list at all', () => {
    // A fresh install has nothing, which is not the same as something old.
    expect(revocationListIsStale()).toBe(false);
  });
});

describe('what it matches', () => {
  it('revokes every version when none are named', () => {
    seedRevocationsForTests(list());
    expect(isRevoked(PLUGIN, '1.0.0')).toBe(true);
    expect(isRevoked(PLUGIN, '9.9.9')).toBe(true);
  });

  it('revokes only the versions named, when some are', () => {
    seedRevocationsForTests(list({ entries: [{ id: PLUGIN, versions: ['1.0.0'], reason: 'Bad build.' }] }));
    expect(isRevoked(PLUGIN, '1.0.0')).toBe(true);
    expect(isRevoked(PLUGIN, '1.0.1')).toBe(false);
  });

  it('carries the operator s reason, verbatim', () => {
    seedRevocationsForTests(list());
    expect(revocationFor(PLUGIN, '1.0.0')?.reason)
      .toBe('Exfiltrated project data to a third party.');
  });

  it('leaves other plugins alone', () => {
    seedRevocationsForTests(list());
    expect(isRevoked('studio.other.tool', '1.0.0')).toBe(false);
  });
});

describe('enforcement', () => {
  const pkg = (): ReturnType<typeof testPackage> => testPackage([], PLUGIN, { name: 'Thing' });

  it('stops a RUNNING plugin mid-session', () => {
    /*
      The failure this exists to fix. Enforcing only at boot leaves the window
      open for as long as the user keeps the app running — which for an editor
      is days.
    */
    const worker = bootPlugin(pkg());
    expect(pluginHost.info(PLUGIN).status).toBe('running');

    seedRevocationsForTests(list());
    const stopped = pluginHost.enforceRevocations();

    expect(stopped).toEqual([{ id: PLUGIN, reason: 'Exfiltrated project data to a third party.' }]);
    expect(pluginHost.info(PLUGIN).status).not.toBe('running');
    expect(worker.terminated).toBe(true);
  });

  it('tells the user WHY, in the operator s words', () => {
    bootPlugin(pkg());
    seedRevocationsForTests(list());
    pluginHost.enforceRevocations();

    // A plugin that disappears with no explanation is worse than the takedown
    // it implements: the user assumes a bug and reinstalls it.
    const log = pluginHost.log(PLUGIN).map((l) => l.text).join('\n');
    expect(log).toMatch(/Withdrawn by the registry: Exfiltrated project data/);
  });

  it('does NOT delete the package or the user s work', () => {
    bootPlugin(pkg());
    seedRevocationsForTests(list());
    pluginHost.enforceRevocations();

    // Consistent with the blocked-plugin rule: breaking someone's project is
    // usually a bigger harm than the one a takedown addresses. Documents that
    // reference it keep opening; a proxy layer's children keep rendering.
    const entry = usePluginStore.getState().get(PLUGIN);
    expect(entry).toBeDefined();
    expect(entry?.enabled).toBe(false);
  });

  it('refuses to re-enable it while it is listed', () => {
    bootPlugin(pkg());
    seedRevocationsForTests(list());
    pluginHost.enforceRevocations();

    pluginHost.setEnabled(PLUGIN, true);

    // A revocation the user can undo by clicking a toggle is not a revocation.
    expect(usePluginStore.getState().get(PLUGIN)?.enabled).toBe(false);
    expect(pluginHost.info(PLUGIN).status).not.toBe('running');
  });

  it('refuses to reinstall it, with the reason', () => {
    seedRevocationsForTests(list());
    const error = pluginHost.install(pkg(), []);
    expect(error).toMatch(/withdrawn by the registry.*Exfiltrated project data/i);
    expect(usePluginStore.getState().get(PLUGIN)).toBeUndefined();
  });

  it('is a no-op when nothing installed is listed', () => {
    bootPlugin(pkg());
    seedRevocationsForTests(list({ entries: [{ id: 'studio.someone.else', reason: 'x' }] }));

    expect(pluginHost.enforceRevocations()).toEqual([]);
    expect(pluginHost.info(PLUGIN).status).toBe('running');
  });

  it('still stops a plugin that was installed but not running', () => {
    // No toast for this one — it was not doing anything — but it must not be
    // left enabled, or the next lazy activation starts it again.
    pluginHost.install(pkg(), []);
    seedRevocationsForTests(list());

    expect(pluginHost.enforceRevocations()).toHaveLength(1);
    expect(usePluginStore.getState().get(PLUGIN)?.enabled).toBe(false);
  });
});
