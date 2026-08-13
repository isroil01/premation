/**
 * The client half of publisher key rotation.
 *
 * The registry requires a password to authorise a new key and a package signed
 * with it to rotate. Neither of those protects a user whose editor simply
 * accepts whatever key the listing currently advertises — a server that could
 * hand over both the package and the key to check it with is a server that can
 * hand over anything.
 *
 * So the property asserted here is narrow and absolute: **the pinned key never
 * changes without the user saying so.** Everything else is arrangement.
 *
 * The failure this exists to prevent is not a crash. It is an update that goes
 * through quietly on a key nobody vouched for — which is exactly what an
 * account takeover needs, and which no test that only checks "did the update
 * install" would ever notice.
 */

import {
  updateFromRegistry,
  setKeyChangeHost,
  type KeyChangeRequest,
} from './installFromRegistry';
import { installFromRegistry } from './installFromRegistry';
import { usePluginStore } from '@stores/pluginStore';

jest.mock('@core/plugins/registry', () => ({ fetchRegistryPackage: jest.fn() }));
jest.mock('@core/plugins/pluginPackage', () => ({ readPluginZip: jest.fn() }));
jest.mock('@components/Modal/Dialogs', () => ({ customAlert: jest.fn() }));

import { fetchRegistryPackage } from '@core/plugins/registry';
import { readPluginZip } from '@core/plugins/pluginPackage';
import { customAlert } from '@components/Modal/Dialogs';

const fetchPkg = fetchRegistryPackage as jest.MockedFunction<typeof fetchRegistryPackage>;
const readZip = readPluginZip as jest.MockedFunction<typeof readPluginZip>;
const alert = customAlert as jest.MockedFunction<typeof customAlert>;

const OLD_KEY = 'PINNED_KEY_AAAA';
const NEW_KEY = 'ROTATED_KEY_BBBB';

/** Records which key `installFromRegistry` ended up verifying against. */
let verifiedWith: string | null = null;

beforeEach(() => {
  jest.clearAllMocks();
  verifiedWith = null;
  setKeyChangeHost(null);

  fetchPkg.mockImplementation(async (_id, _version, key) => {
    verifiedWith = key;
    return { bytes: new Uint8Array([1, 2, 3]) } as never;
  });
  // The package itself is beside the point here; the consent screen is stubbed
  // out by `installFromRegistry` reporting "consent unavailable".
  readZip.mockReturnValue({ pkg: null, errors: ['stub'] } as never);
});

afterEach(() => setKeyChangeHost(null));

describe('when the key has NOT changed', () => {
  it('updates without prompting anybody', async () => {
    // The steady state, and the control: a flow that prompted on every update
    // would train users to click through the one that matters.
    const prompt = jest.fn();
    setKeyChangeHost(prompt as unknown as (r: KeyChangeRequest) => Promise<boolean>);

    await updateFromRegistry('studio.acme.thing', '2.0.0', OLD_KEY, OLD_KEY, 'Thing');

    expect(prompt).not.toHaveBeenCalled();
    expect(verifiedWith).toBe(OLD_KEY);
  });
});

describe('★ when the key HAS changed', () => {
  it('asks before downloading anything', async () => {
    /*
      Order matters. Verifying the new package against the OLD pin fails
      correctly but indistinguishably from a corrupted download — so a user
      whose publisher legitimately rotated would be told their plugin is broken,
      and the whole feature would surface as a mysterious verification error.
    */
    const prompt = jest.fn().mockResolvedValue(false);
    setKeyChangeHost(prompt);

    await updateFromRegistry('studio.acme.thing', '2.0.0', OLD_KEY, NEW_KEY, 'Thing');

    expect(prompt).toHaveBeenCalled();
    expect(fetchPkg).not.toHaveBeenCalled();
  });

  it('tells the prompt both keys and which plugin', async () => {
    const prompt = jest.fn().mockResolvedValue(false);
    setKeyChangeHost(prompt);

    await updateFromRegistry('studio.acme.thing', '2.0.0', OLD_KEY, NEW_KEY, 'Thing');

    expect(prompt).toHaveBeenCalledWith({
      pluginId: 'studio.acme.thing',
      pluginName: 'Thing',
      version: '2.0.0',
      pinnedKey: OLD_KEY,
      newKey: NEW_KEY,
      authorisation: 'unknown',
    });
  });

  it('★ does NOTHING when the user declines', async () => {
    /*
      Declining leaves a working plugin working. It is not an error, nothing is
      downloaded, nothing is re-pinned, and the user is not told off — a
      security prompt whose safe answer is punished is one people stop reading.
    */
    setKeyChangeHost(jest.fn().mockResolvedValue(false));

    const result = await updateFromRegistry('studio.acme.thing', '2.0.0', OLD_KEY, NEW_KEY, 'Thing');

    expect(result).toBe(false);
    expect(fetchPkg).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });

  it('verifies against the NEW key once the user accepts', async () => {
    // And only then. Accepting is what makes the new key the one to check
    // against — until that point the old pin is still the only trusted thing.
    setKeyChangeHost(jest.fn().mockResolvedValue(true));

    await updateFromRegistry('studio.acme.thing', '2.0.0', OLD_KEY, NEW_KEY, 'Thing');

    expect(verifiedWith).toBe(NEW_KEY);
  });

  it('★ refuses rather than proceeding when no prompt is available', async () => {
    /*
      The dangerous default, stated explicitly. A build where the prompt failed
      to mount must not be the build that silently re-pins — "the UI was
      missing" is not consent, and falling back to the new key would make the
      whole control depend on a component rendering.
    */
    setKeyChangeHost(null);

    const result = await updateFromRegistry('studio.acme.thing', '2.0.0', OLD_KEY, NEW_KEY, 'Thing');

    expect(result).toBe(false);
    expect(fetchPkg).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalled();
  });
});

describe('a plugin with no pinned key', () => {
  it('says so instead of trusting whatever the registry offers', async () => {
    // Installed from disk. There is no pin, so there is nothing to compare —
    // and treating "no pin" as "any key is fine" would make a folder install a
    // way to get an unverified registry update.
    const prompt = jest.fn();
    setKeyChangeHost(prompt as unknown as (r: KeyChangeRequest) => Promise<boolean>);

    const result = await updateFromRegistry('studio.acme.thing', '2.0.0', null, NEW_KEY, 'Thing');

    expect(result).toBe(false);
    expect(prompt).not.toHaveBeenCalled();
    expect(fetchPkg).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalled();
  });
});

describe('the install path is shared', () => {
  it('goes through the same verify-then-consent flow', async () => {
    /*
      `updateFromRegistry` delegates to `installFromRegistry` rather than
      re-implementing the fetch. Three copies of that flow is three chances for
      one of them to skip a step, and the steps ARE the security model.
    */
    setKeyChangeHost(jest.fn().mockResolvedValue(true));

    await updateFromRegistry('studio.acme.thing', '2.0.0', OLD_KEY, NEW_KEY, 'Thing', 'abc123');

    // The digest is threaded through to the fetch, which is the only place it
    // can be checked. It came from the update OFFER — a different response from
    // the one carrying the bytes, which is the whole reason it is worth
    // checking at all.
    expect(fetchPkg).toHaveBeenCalledWith('studio.acme.thing', '2.0.0', NEW_KEY, 'abc123');
    // It reached the reader, which is what `installFromRegistry` does next.
    expect(readZip).toHaveBeenCalled();
  });

  it('is the same function the direct install uses', () => {
    // Guards against `updateFromRegistry` quietly growing its own copy.
    expect(typeof installFromRegistry).toBe('function');
  });
});

/**
 * ── Three rotation paths, because they are three different claims ────────────
 *
 * Every rotation used to produce the same modal. That is the defect: a prompt
 * shown for the safe case and the dangerous case alike is one people learn to
 * click through, and the dangerous case is precisely the one an attacker with a
 * stolen publisher account wants displayed.
 *
 * What separates them is what THIS MACHINE recorded before the rotation
 * happened — the successor key the registry advertised at install time. A key
 * first mentioned in the response that asks you to trust it is no evidence at
 * all; a key recorded months earlier is.
 */
describe('★ the three rotation paths', () => {
  /** Install a record with a known successor, the way a real install does. */
  function installed(next?: { key: string; method: 'backup' | 'dashboard' }): void {
    usePluginStore.setState({
      plugins: [{
        manifest: {
          id: 'studio.acme.thing', name: 'Thing', version: '1.0.0', description: 'x',
          apiVersion: 5, main: 'main.js', permissions: [],
          contributes: { commands: [], panels: [], layerKinds: [], effects: [], net: null },
          activationEvents: ['onStartup'],
        },
        granted: [], enabled: true, files: {}, binaries: {}, installedAt: 0,
        publisherKey: OLD_KEY,
        ...(next ? { nextPublisherKey: next.key, nextPublisherKeyMethod: next.method } : {}),
      }] as never,
    });
  }

  afterEach(() => usePluginStore.setState({ plugins: [] }));

  it('accepts a BACKUP key silently, and writes it down', async () => {
    /*
      A backup key was registered at first publish — before anyone had installed
      the plugin, so before there was an install base the choice could endanger.
      There is nothing to ask a user: they already have the evidence, recorded
      before the event, and a prompt here would be theatre that costs attention
      the `unknown` case needs.

      Silent is only acceptable BECAUSE it is recorded. A change nobody was
      asked about and nobody can find afterwards is indistinguishable from no
      change at all.
    */
    installed({ key: NEW_KEY, method: 'backup' });
    const prompt = jest.fn();
    setKeyChangeHost(prompt as unknown as (r: KeyChangeRequest) => Promise<boolean>);

    await updateFromRegistry('studio.acme.thing', '2.0.0', OLD_KEY, NEW_KEY, 'Thing');

    expect(prompt).not.toHaveBeenCalled();
    expect(verifiedWith).toBe(NEW_KEY);

    const events = usePluginStore.getState().get('studio.acme.thing')?.securityEvents ?? [];
    expect(events).toHaveLength(1);
    expect(events[0]!.text).toMatch(/backup.*first published/i);
  });

  it('PROMPTS for a dashboard key, and says the account could have been taken', async () => {
    // Recorded as authorised, but from the account, after publication — which
    // is exactly what a thief holds. Real evidence, weak evidence, and the
    // prompt has to say which.
    installed({ key: NEW_KEY, method: 'dashboard' });
    const prompt = jest.fn().mockResolvedValue(true);
    setKeyChangeHost(prompt as unknown as (r: KeyChangeRequest) => Promise<boolean>);

    await updateFromRegistry('studio.acme.thing', '2.0.0', OLD_KEY, NEW_KEY, 'Thing');

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt.mock.calls[0]![0]).toMatchObject({ authorisation: 'dashboard' });
    expect(verifiedWith).toBe(NEW_KEY);
  });

  it('PROMPTS hardest for a key it never recorded', async () => {
    installed({ key: 'SOME_OTHER_KEY', method: 'backup' });
    const prompt = jest.fn().mockResolvedValue(true);
    setKeyChangeHost(prompt as unknown as (r: KeyChangeRequest) => Promise<boolean>);

    await updateFromRegistry('studio.acme.thing', '2.0.0', OLD_KEY, NEW_KEY, 'Thing');

    /*
      A recorded successor that does not MATCH is worth nothing — it must not
      soften the warning. This is the case where a compromised registry rotates
      to a key of its own choosing, and the copy for `dashboard` would read as
      reassurance it has not earned.
    */
    expect(prompt.mock.calls[0]![0]).toMatchObject({ authorisation: 'unknown' });
  });

  it('prompts when nothing was ever recorded', async () => {
    // Every plugin installed before this shipped. The absence of a successor is
    // not evidence of one, so it lands in the strongest case.
    installed();
    const prompt = jest.fn().mockResolvedValue(true);
    setKeyChangeHost(prompt as unknown as (r: KeyChangeRequest) => Promise<boolean>);

    await updateFromRegistry('studio.acme.thing', '2.0.0', OLD_KEY, NEW_KEY, 'Thing');

    expect(prompt.mock.calls[0]![0]).toMatchObject({ authorisation: 'unknown' });
  });

  it('never rotates on a successor supplied by the same response', async () => {
    /*
      The property the whole design rests on, stated as a test.

      `updateFromRegistry` is given the registry's CURRENT key and nothing else.
      There is no argument through which a response could also supply the
      successor that justifies it — the successor comes from the store, written
      at a previous install. A compromised registry can therefore claim a new
      key, but cannot claim it was pre-authorised.
    */
    installed();
    const prompt = jest.fn().mockResolvedValue(false);
    setKeyChangeHost(prompt as unknown as (r: KeyChangeRequest) => Promise<boolean>);

    await updateFromRegistry('studio.acme.thing', '2.0.0', OLD_KEY, NEW_KEY, 'Thing');

    // Declined, so nothing was fetched against the new key at all.
    expect(verifiedWith).toBeNull();
    expect(usePluginStore.getState().get('studio.acme.thing')?.publisherKey).toBe(OLD_KEY);
  });

  it('records an accepted prompt too, not only the silent path', async () => {
    // The log is the plugin's security history, not a log of surprises.
    installed({ key: NEW_KEY, method: 'dashboard' });
    setKeyChangeHost((() => Promise.resolve(true)) as unknown as (r: KeyChangeRequest) => Promise<boolean>);

    await updateFromRegistry('studio.acme.thing', '2.0.0', OLD_KEY, NEW_KEY, 'Thing');

    const events = usePluginStore.getState().get('studio.acme.thing')?.securityEvents ?? [];
    expect(events[0]!.text).toMatch(/You accepted it/);
  });
});
