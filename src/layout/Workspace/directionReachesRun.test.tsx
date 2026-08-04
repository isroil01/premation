/**
 * A direction the user pinned must reach the run that follows it.
 *
 * ## The defect
 *
 * `submit` is a `useCallback` with the deps `[busy, hasPendingTx, isManualMode,
 * persist]`, and it read `direction` and `projectId` — neither of which is in
 * that list. So the values it sent were whichever ones had been current the last
 * time one of those four deps happened to change.
 *
 * In practice that means: pick a look pack, press Enter, and the run is cast
 * with no direction at all. Pick a second one and the run gets the FIRST. The
 * composer's whole purpose is to override what the model would otherwise guess,
 * so the failure mode was "every piece looks the same whatever you select" —
 * indistinguishable from the model ignoring the instruction, which is where
 * anyone would have looked first.
 *
 * The same bug on `projectId` meant the backend's project and conversation
 * memory keyed on a stale id (or `undefined`) after a project switch.
 *
 * ## What this test pins
 *
 * Not the dep array — that would pass with a `useMemo` shuffled around it. It
 * pins the OBSERVABLE contract: the options object `runAgent` is actually
 * called with. Any refactor that reintroduces a stale read fails here.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import type { RunAgentOptions } from '@core/ai/AgentLoop';

/** Every `runAgent` call this test file has provoked, in order. */
const calls: RunAgentOptions[] = [];

jest.mock('@core/ai/AgentLoop', () => ({
  ...jest.requireActual('@core/ai/AgentLoop'),
  runAgent: jest.fn(async (_prompt: string, opts: RunAgentOptions) => {
    calls.push(opts);
    return { text: 'ok', messages: [], toolCallCount: 0, changes: [], tally: { compose: 0, primitive: 0, read: 0 } };
  }),
}));

// The panel's own dependencies, stubbed down to what `submit` touches. None of
// them is the subject here and all of them would otherwise reach the network.
jest.mock('@core/api/client', () => ({
  api: { listConversations: jest.fn(async () => ({ items: [] })), appendMessages: jest.fn(async () => undefined) },
  isAuthenticated: () => true,
}));
jest.mock('@core/ai/CasterRunner', () => ({
  casterPacks: () => [
    { id: 'luxury_film', displayName: 'Luxury Film', intent: 'restraint' },
    { id: 'cyberpunk_kinetic', displayName: 'Cyberpunk Kinetic', intent: 'neon' },
  ],
}));

import { useAiChat } from './useAiChat';
import { useAiProviderStore } from '@stores/aiProviderStore';
import { useCloudProjectStore } from '@stores/cloudProjectStore';

/** A provider that reports ready, so `submit` does not stop at the key gate. */
function connectProvider(): void {
  useAiProviderStore.setState({
    provider: 'anthropic',
    status: { anthropic: { present: true, hint: 'sk-…aaaa' } } as never,
    motion: null,
    verified: true,
  });
}

beforeEach(() => {
  calls.length = 0;
  connectProvider();
  useCloudProjectStore.setState({ projectId: 'proj_one' } as never);
});

describe('composer direction reaches the very next run', () => {
  it('sends a look pack chosen a moment ago, not the one before it', async () => {
    const { result } = renderHook(() => useAiChat());

    // Nothing pinned yet: the model decides, and no `direction` is sent at all.
    await act(async () => { await result.current.submit('a teaser'); });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.direction).toBeUndefined();

    // Pin a pack, then submit. This is the exact sequence that used to send
    // `undefined` — the state changed, `submit` did not, so it kept its old view.
    act(() => { result.current.setDirection({ lookPackId: 'luxury_film' }); });
    await act(async () => { await result.current.submit('a teaser'); });
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]!.direction?.lookPackId).toBe('luxury_film');

    // Change it again: the NEW one goes out, not the previous one. This is the
    // half that a naive "capture it once" fix would still get wrong.
    act(() => { result.current.setDirection({ lookPackId: 'cyberpunk_kinetic' }); });
    await act(async () => { await result.current.submit('a teaser'); });
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[2]!.direction?.lookPackId).toBe('cyberpunk_kinetic');
  });

  it('carries energy, accent and duration — every field the Shape chip sets', async () => {
    const { result } = renderHook(() => useAiChat());

    act(() => {
      result.current.setDirection({ energy: 0.2, accent: '#ff0066', totalDurationMs: 18_000 });
    });
    await act(async () => { await result.current.submit('a teaser'); });
    await waitFor(() => expect(calls).toHaveLength(1));

    expect(calls[0]!.direction).toEqual({
      energy: 0.2,
      accent: '#ff0066',
      totalDurationMs: 18_000,
    });
  });

  it('sends energy 0 — a falsy value that is a real choice', async () => {
    // `energy` is the one direction field whose valid range includes 0, and 0 is
    // the most deliberate setting on the slider: maximum restraint. A truthiness
    // test anywhere on this path silently turns it back into "you decide".
    const { result } = renderHook(() => useAiChat());
    act(() => { result.current.setDirection({ energy: 0 }); });
    await act(async () => { await result.current.submit('a teaser'); });
    await waitFor(() => expect(calls).toHaveLength(1));

    expect(calls[0]!.direction?.energy).toBe(0);
  });

  it('sends a variant count above one, and omits it at one', async () => {
    const { result } = renderHook(() => useAiChat());

    await act(async () => { await result.current.submit('a teaser'); });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.variants).toBeUndefined();

    act(() => { result.current.setDirection({ variants: 3 }); });
    await act(async () => { await result.current.submit('a teaser'); });
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]!.variants).toBe(3);
  });

  it('clearing a pack removes it from the payload rather than sending stale', async () => {
    const { result } = renderHook(() => useAiChat());

    act(() => { result.current.setDirection({ lookPackId: 'luxury_film' }); });
    act(() => { result.current.setDirection({ lookPackId: undefined }); });
    await act(async () => { await result.current.submit('a teaser'); });
    await waitFor(() => expect(calls).toHaveLength(1));

    expect(calls[0]!.direction).toBeUndefined();
  });

  it('binds the run to the project that is open NOW', async () => {
    const { result } = renderHook(() => useAiChat());

    await act(async () => { await result.current.submit('a teaser'); });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.projectId).toBe('proj_one');

    // Switching projects and prompting immediately used to send the old id, so
    // the backend assembled the previous project's memory for this run.
    act(() => { useCloudProjectStore.setState({ projectId: 'proj_two' } as never); });
    await act(async () => { await result.current.submit('a teaser'); });
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]!.projectId).toBe('proj_two');
  });
});
