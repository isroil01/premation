/**
 * The director pipeline is a SERVER-edition feature, and must refuse as one.
 *
 * WHY THIS EXISTS. `runBackendDirector` opens with:
 *
 *     if (!aiEnabled()) throw new AiError('coming_soon', '…local edition.');
 *     const token = getToken();
 *     if (!token) throw new AiError('auth', 'Sign in to run the AI director…');
 *
 * `aiEnabled()` used to be `isServerEdition()`. It then became `() => true` —
 * both editions ran the assistant, differing only in WHERE the key lived — and
 * that silently neutered this guard: the local edition stopped hitting the
 * honest "not available here" refusal and fell through to the token check,
 * asking a user with no accounts system to sign in.
 *
 * `aiEnabled()` is `isServerEdition()` once again, so reading it here would now
 * work BY COINCIDENCE. Which is precisely why this test still earns its place:
 * the two predicates have agreed, disagreed, and agreed again, and this guard
 * has to track the requirement it actually has — a backend — rather than
 * whichever predicate happens to share its value this month.
 *
 * MEASURED, not assumed: the AgentLoop catch around the call
 * (`recordPathFailure('backend-director', …)`) means this never reached the
 * user as an error — the run degrades to the direct tool loop. So the impact is
 * a pointless round trip and a misleading console failure on every generative
 * prompt in the local edition, not a broken assistant. That is the same shape
 * the AgentLoop comment warns about: "every generative prompt paid its latency,
 * failed, and quietly degraded".
 *
 * The fix reads the capability that actually describes the requirement —
 * `aiRunsThroughBackend()` — instead of `aiEnabled()`, which no longer
 * discriminates anything.
 */

import { setEdition } from '@core/config/edition';

const ORIGINAL_EDITION = 'server' as const;

/** Minimal stand-ins: the refusal must happen before any of these are touched. */
const NOOP_CTX = {} as never;
const NOOP_REGISTRY = {} as never;

describe('director pipeline edition gate', () => {
  afterEach(() => {
    setEdition(ORIGINAL_EDITION);
    jest.resetModules();
  });

  async function runInEdition(edition: 'local' | 'server'): Promise<Error> {
    jest.resetModules();
    const { setEdition: setIt } = await import('@core/config/edition');
    setIt(edition);
    const { runBackendDirector } = await import('./DirectorRunner');
    try {
      await runBackendDirector(
        {
          provider: 'openai' as never,
          model: 'gpt-4',
          prompt: 'make something',
          signal: new AbortController().signal,
        },
        NOOP_CTX,
        NOOP_REGISTRY,
        new Set<string>(),
      );
    } catch (err) {
      return err as Error;
    }
    throw new Error('expected the director run to refuse, but it resolved');
  }

  it('refuses in the local edition as UNAVAILABLE, not as a sign-in problem', async () => {
    const err = await runInEdition('local');
    // The distinction that matters: an edition with no accounts must never be
    // told to sign in. Before the fix this was code 'auth'.
    expect((err as { code?: string }).code).toBe('coming_soon');
    expect(err.message).not.toMatch(/sign in/i);
  });

  it('still asks a signed-out SERVER-edition user to sign in', async () => {
    const err = await runInEdition('server');
    // No token in this environment, so the server edition should reach the
    // token check — proving the local branch above is edition-specific and not
    // just "it always says coming_soon now".
    expect((err as { code?: string }).code).toBe('auth');
    expect(err.message).toMatch(/sign in/i);
  });
});
