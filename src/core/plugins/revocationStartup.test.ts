/**
 * The kill switch has to have a floor.
 *
 * Everything else in the trust chain is checked at a moment the user chose: a
 * signature at install, a key change at update, permissions at consent. A
 * revocation is the one control that has to reach a machine whose owner is
 * doing nothing in particular — they installed something months ago, it turned
 * out to be stealing projects, and nothing they will do on their own initiative
 * is going to stop it.
 *
 * So the properties asserted here are the ones that decide whether that floor
 * exists at all:
 *
 *   1. a cold start reports a revocation with the manager never opened;
 *   2. a start that could not reach the registry tries again before the first
 *      plugin runs, rather than waiting for the next restart;
 *   3. a client that IS reaching the registry is not permanently reported as
 *      stale merely because 304s carry no new expiry;
 *   4. a client that is not reaching it says so;
 *   5. the request says nothing about what is installed.
 */

import pluginHost from './PluginHost';
import { usePluginStore } from '@stores/pluginStore';
import { useFakeWorkers, testPackage, FakeWorker } from './fakeWorker.testkit';
import {
  MAX_CONFIRMATION_AGE_MS,
  currentRevocationList,
  refreshRevocations,
  resetRevocationsForTests,
  revocationListIsStale,
  revocationsConfirmedAt,
  seedRevocationsForTests,
  storedRevocationEtag,
  type RevocationFetchResult,
  type RevocationList,
} from './revocation';

const PLUGIN = 'studio.acme.thing';

const list = (over: Partial<RevocationList> = {}): RevocationList => ({
  seq: 5,
  issuedAt: '2026-08-01T00:00:00.000Z',
  expiresAt: '2026-08-02T00:00:00.000Z',
  entries: [{ id: PLUGIN, reason: 'Exfiltrated project data to a third party.' }],
  ...over,
});

beforeAll(async () => {
  useFakeWorkers();
  await usePluginStore.getState().hydrate();
});
afterAll(() => { pluginHost.setWorkerFactory(null); });

beforeEach(() => {
  for (const p of [...usePluginStore.getState().plugins]) pluginHost.uninstall(p.manifest.id);
  resetRevocationsForTests();
  FakeWorker.last = null;
});

describe('the conditional request', () => {
  it('offers nothing on the first fetch, and the validator afterwards', async () => {
    const offered: Array<string | null> = [];
    const fetcher = (etag: string | null): Promise<RevocationFetchResult> => {
      offered.push(etag);
      return Promise.resolve({ kind: 'unchanged' });
    };

    await refreshRevocations(fetcher, () => {});
    expect(offered).toEqual([null]);

    seedRevocationsForTests(list(), { etag: '"abc"' });
    await refreshRevocations(fetcher, () => {});
    expect(offered).toEqual([null, '"abc"']);
  });

  it('stores the validator only for a list it accepted', async () => {
    /*
      A validator kept for a REFUSED list would be offered on the next request,
      the server would answer 304, and the client would be pinned to the state
      it refused — a bad list made permanent by a cache header.
    */
    await refreshRevocations(
      () => Promise.resolve({
        kind: 'list',
        signed: { payload: '{"seq":1}', signature: 'not-a-signature' },
        etag: '"poison"',
      }),
      () => {},
    );
    expect(storedRevocationEtag()).toBeNull();
    expect(currentRevocationList()).toBeNull();
  });
});

describe('what counts as the server answering', () => {
  it('reports a fetch that produced a verified list', async () => {
    // Exercised through the 304 path, which needs no signature: the point under
    // test is the return value, not the crypto (`revocation.test.ts` covers it).
    seedRevocationsForTests(list());
    expect(await refreshRevocations(() => Promise.resolve({ kind: 'unchanged' }), () => {}))
      .toBe(true);
  });

  it('reports a network failure as no answer', async () => {
    expect(await refreshRevocations(() => Promise.resolve(null), () => {})).toBe(false);
    expect(await refreshRevocations(() => Promise.reject(new Error('offline')), () => {}))
      .toBe(false);
  });

  it('reports a REFUSED list as no answer', async () => {
    /*
      The server spoke, but with something unusable. Counted as no answer on
      purpose: the caller uses this to decide whether to try again, and a client
      that stopped trying after one bad response would be silenced for the
      session by an attacker serving garbage.
    */
    expect(await refreshRevocations(
      () => Promise.resolve({
        kind: 'list',
        signed: { payload: '{"seq":1}', signature: 'bogus' },
        etag: null,
      }),
      () => {},
    )).toBe(false);
  });
});

describe('a cold start, with the manager never opened', () => {
  it('stops a plugin revoked server-side', async () => {
    const pkg = testPackage([], PLUGIN);
    const err = pluginHost.install(pkg, [], { source: 'registry' });
    expect(err).toBeNull();
    expect(usePluginStore.getState().get(PLUGIN)?.enabled).toBe(true);

    /*
      The path `configure()` takes at boot. Nothing here opens the Plugins
      panel, and nothing needs to — that was the defect. A user who never clicks
      that menu used to run a revoked plugin indefinitely, and since the package
      is blocked rather than deleted, nothing else on the machine would ever
      have stopped it.

      The list is the CACHED one and the server answers 304, which is the
      overwhelmingly common shape of a cold start and the one that used to slip
      through: `refreshRevocations` only enforces when it obtains a new list, so
      a boot that relied on it alone left a revoked plugin running until the
      registry happened to send something different.
    */
    seedRevocationsForTests(list());
    pluginHost.enforceRevocations();
    expect(usePluginStore.getState().get(PLUGIN)?.enabled).toBe(false);

    await refreshRevocations(
      () => Promise.resolve({ kind: 'unchanged' }),
      () => pluginHost.enforceRevocations(),
    );
    expect(usePluginStore.getState().get(PLUGIN)?.enabled).toBe(false);
  });

  it('never starts a plugin the cached list already names', async () => {
    /*
      The stronger property, and the reason enforcement runs BEFORE
      `bringUpEnabled` rather than after it. Enforcing afterwards would stop a
      revoked plugin, but only once its `activate()` had already run — and a
      plugin taken down for stealing data does its stealing in `activate()`.
    */
    seedRevocationsForTests(list());
    pluginHost.install(testPackage([], PLUGIN), [], { source: 'registry' });

    // `install` refuses outright while it is on the list, which is the first
    // line of the same defence.
    expect(usePluginStore.getState().get(PLUGIN)).toBeUndefined();
  });

  it('tells the user, and keeps telling them, for a MALICIOUS takedown', () => {
    pluginHost.install(testPackage([], PLUGIN), [], { source: 'registry' });
    seedRevocationsForTests(list({
      entries: [{
        id: PLUGIN,
        category: 'malicious',
        reason: 'Exfiltrated project data to a third party.',
      }],
    }));

    pluginHost.enforceRevocations();

    /*
      A toast is a moment. This one is a reason to go and check what that plugin
      had access to, and a notice that expires while the user is looking at the
      canvas is one they never received — so it stays on the row until they
      acknowledge it.
    */
    expect(pluginHost.hasUnacknowledgedTakedown(PLUGIN)).toBe(true);
    pluginHost.acknowledgeTakedown(PLUGIN);
    expect(pluginHost.hasUnacknowledgedTakedown(PLUGIN)).toBe(false);
  });

  it('does not mark an ordinary takedown as unacknowledged', () => {
    // Most takedowns are mild. A product that shouts about all of them teaches
    // people to dismiss the shouting, which costs the one case that matters.
    pluginHost.install(testPackage([], PLUGIN), [], { source: 'registry' });
    seedRevocationsForTests(list({
      entries: [{ id: PLUGIN, category: 'broken', reason: 'Crashes on 2.4.' }],
    }));

    pluginHost.enforceRevocations();
    expect(usePluginStore.getState().get(PLUGIN)?.enabled).toBe(false);
    expect(pluginHost.hasUnacknowledgedTakedown(PLUGIN)).toBe(false);
  });

  it('treats a takedown with no category as ordinary', () => {
    // Every list written before the registry carried the field. Inferring
    // severity from the reason text would be a classifier deciding how alarmed
    // to make someone.
    pluginHost.install(testPackage([], PLUGIN), [], { source: 'registry' });
    seedRevocationsForTests(list());
    pluginHost.enforceRevocations();
    expect(pluginHost.hasUnacknowledgedTakedown(PLUGIN)).toBe(false);
  });
});

describe('staleness', () => {
  const HOUR = 3600_000;
  const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

  it('is false while the server keeps confirming, even long past expiresAt', () => {
    /*
      The case that would otherwise light the warning permanently for the
      clients doing everything right.

      The registry's validator covers `seq` and the entries but not `issuedAt`,
      so a list unchanged since March answers 304 forever and the stored
      `expiresAt` recedes into the past. Reading that as staleness would mean a
      client revalidating daily reports itself out of date — and a warning that
      is always on is off.
    */
    seedRevocationsForTests(
      list({ issuedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-02T00:00:00.000Z' }),
      { fetchedAt: ago(HOUR) },
    );
    expect(revocationListIsStale()).toBe(false);
  });

  it('is true once the declared window has elapsed since the last confirmation', () => {
    // A 24-hour list, last confirmed 30 hours ago.
    seedRevocationsForTests(list(), { fetchedAt: ago(30 * HOUR) });
    expect(revocationListIsStale()).toBe(true);
  });

  it('is true past the hard ceiling however long the declared window was', () => {
    // A server that declared a year-long window must not be able to switch the
    // staleness warning off for a client it has stopped answering.
    seedRevocationsForTests(
      list({ issuedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z' }),
      { fetchedAt: ago(MAX_CONFIRMATION_AGE_MS + HOUR) },
    );
    expect(revocationListIsStale()).toBe(true);
  });

  it('keeps ENFORCING a stale list', () => {
    // Reported, never acted on by failing open. A client that stopped enforcing
    // a stale list would make "block the fetch" the entire exploit.
    seedRevocationsForTests(list(), { fetchedAt: ago(MAX_CONFIRMATION_AGE_MS * 2) });
    expect(revocationListIsStale()).toBe(true);
    expect(currentRevocationList()?.entries[0]?.id).toBe(PLUGIN);
  });

  it('is false with no list at all', () => {
    // A fresh install has nothing, which is not the same as something old.
    expect(revocationListIsStale()).toBe(false);
  });

  it('records the confirmation time on a 304, not just on a full fetch', async () => {
    seedRevocationsForTests(list(), { fetchedAt: ago(30 * HOUR) });
    expect(revocationListIsStale()).toBe(true);

    await refreshRevocations(() => Promise.resolve({ kind: 'unchanged' }), () => {});

    expect(revocationListIsStale()).toBe(false);
    expect(Date.parse(revocationsConfirmedAt()!)).toBeGreaterThan(Date.now() - 5000);
  });

  it('does not move the clock when the fetch learned nothing', async () => {
    // Offline is not confirmation. Treating it as one would mean an unreachable
    // registry keeps the client looking healthy forever.
    const before = ago(30 * HOUR);
    seedRevocationsForTests(list(), { fetchedAt: before });
    await refreshRevocations(() => Promise.resolve(null), () => {});
    expect(revocationsConfirmedAt()).toBe(before);
  });
});
