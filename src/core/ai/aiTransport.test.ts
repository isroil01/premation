/**
 * The local transport bridges push-style IPC events into a pull-style async
 * generator, and that seam is where a response silently truncates.
 *
 * Events arrive whether or not the consumer is currently awaiting. If the
 * generator only reads what is available at the moment it asks, every chunk that
 * lands between two `next()` calls is lost — and the failure mode is not an error,
 * it is an answer that stops mid-sentence. That is what most of this file is
 * about.
 */

import { setEdition } from '@core/config/edition';
import { streamProviderBytes, AiTransportError, localAiAvailable } from './aiTransport';
import type { AiStreamEvent } from '@app-types/motionEditor';

type Listener = (event: AiStreamEvent) => void;

/**
 * The event union minus `requestId`, written out rather than `Omit<…>`.
 *
 * `Omit` over a union is not distributive: it collapses to the keys every member
 * shares, so `Omit<AiStreamEvent, 'requestId'>` is `{ type }` and `text`/`code`
 * become excess properties.
 */
type EmittableEvent =
  | { type: 'chunk'; text: string }
  | { type: 'done' }
  | { type: 'error'; code: string; message: string };

interface Harness {
  emit: (event: EmittableEvent, requestId?: string) => void;
  cancelled: string[];
  streamCalls: unknown[];
  listenerCount: () => number;
}

/**
 * Attach a fake bridge to the EXISTING window rather than replacing it.
 *
 * `globalThis.window = {...}` is the obvious thing to write and it is unreliable —
 * under jsdom `window` is the global object itself, so replacing it does not
 * behave like replacing a plain property, and the result is a suite where the
 * bridge is visible in some tests and not others.
 */
function installShell(
  start: { ok: true; requestId: string } | { ok: false; code: string; message: string } = {
    ok: true,
    requestId: 'req-1',
  },
): Harness {
  const listeners = new Set<Listener>();
  const cancelled: string[] = [];
  const streamCalls: unknown[] = [];

  (globalThis.window as unknown as { motionEditor?: unknown }).motionEditor = {
    ai: {
      stream: async (request: unknown) => {
        streamCalls.push(request);
        return start;
      },
      cancel: async (id: string) => {
        cancelled.push(id);
        return true;
      },
      onStreamEvent: (handler: Listener) => {
        listeners.add(handler);
        return () => listeners.delete(handler);
      },
    },
  };

  return {
    emit: (event, requestId = 'req-1') => {
      for (const l of [...listeners]) l({ requestId, ...event } as AiStreamEvent);
    },
    cancelled,
    streamCalls,
    listenerCount: () => listeners.size,
  };
}

const removeShell = (): void => {
  delete (globalThis.window as unknown as { motionEditor?: unknown }).motionEditor;
};

const collect = async (stream: AsyncGenerator<string>): Promise<string> => {
  let out = '';
  for await (const chunk of stream) out += chunk;
  return out;
};

/** Let queued microtasks drain, so an in-flight `invoke` resolves. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  setEdition('local');
});

afterEach(() => {
  setEdition('server');
  removeShell();
});

describe('local transport', () => {
  it('yields chunks in order and ends on done', async () => {
    const shell = installShell();
    const stream = streamProviderBytes({ provider: 'openai', model: 'gpt-4o', body: {} }, new AbortController().signal);

    const collected = collect(stream);
    await tick();
    shell.emit({ type: 'chunk', text: 'Hel' });
    shell.emit({ type: 'chunk', text: 'lo' });
    shell.emit({ type: 'done' });

    expect(await collected).toBe('Hello');
  });

  it('does not drop chunks that arrive before the consumer asks', async () => {
    // The whole reason there is a queue. All three land in one synchronous burst
    // while the generator is between reads; a "read what is available now"
    // implementation would deliver one and lose two.
    const shell = installShell();
    const stream = streamProviderBytes({ provider: 'openai', model: 'gpt-4o', body: {} }, new AbortController().signal);

    const collected = collect(stream);
    await tick();
    shell.emit({ type: 'chunk', text: 'a' });
    shell.emit({ type: 'chunk', text: 'b' });
    shell.emit({ type: 'chunk', text: 'c' });
    shell.emit({ type: 'done' });

    expect(await collected).toBe('abc');
  });

  it('drains what is queued before reporting the error', async () => {
    // A provider that streams half an answer and then drops should not lose the
    // half it delivered — the user can see where it got to.
    const shell = installShell();
    const stream = streamProviderBytes({ provider: 'openai', model: 'gpt-4o', body: {} }, new AbortController().signal);

    const chunks: string[] = [];
    const run = (async () => {
      for await (const c of stream) chunks.push(c);
    })();

    await tick();
    shell.emit({ type: 'chunk', text: 'partial' });
    shell.emit({ type: 'error', code: 'rate_limit', message: 'slow down' });

    await expect(run).rejects.toMatchObject({ code: 'rate_limit' });
    expect(chunks).toEqual(['partial']);
  });

  it('surfaces a start failure with its code, before any event', async () => {
    installShell({ ok: false, code: 'no_key', message: 'No openai API key is connected.' });
    const stream = streamProviderBytes({ provider: 'openai', model: 'gpt-4o', body: {} }, new AbortController().signal);

    await expect(collect(stream)).rejects.toBeInstanceOf(AiTransportError);
    await expect(
      collect(streamProviderBytes({ provider: 'openai', model: 'gpt-4o', body: {} }, new AbortController().signal)),
    ).rejects.toMatchObject({ code: 'no_key' });
  });

  it('cancels the provider call when the signal aborts', async () => {
    const shell = installShell();
    const controller = new AbortController();
    const stream = streamProviderBytes({ provider: 'openai', model: 'gpt-4o', body: {} }, controller.signal);

    const run = collect(stream);
    await tick();
    shell.emit({ type: 'chunk', text: 'start' });
    controller.abort();

    await expect(run).rejects.toMatchObject({ code: 'cancelled' });
    // Cancel has to reach main, or the provider keeps streaming tokens the user
    // is paying for into a queue nobody reads.
    expect(shell.cancelled).toEqual(['req-1']);
  });

  it('cancels when the signal aborts while the stream is still starting', async () => {
    // The race: abort fires before `ai.stream` resolves, so the abort handler has
    // no requestId yet and nothing has been cancelled.
    const shell = installShell();
    const controller = new AbortController();
    const stream = streamProviderBytes({ provider: 'openai', model: 'gpt-4o', body: {} }, controller.signal);
    const run = collect(stream);
    controller.abort();

    await expect(run).rejects.toMatchObject({ code: 'cancelled' });
    await tick();
    expect(shell.cancelled).toEqual(['req-1']);
  });

  it('cancels when the consumer stops reading early', async () => {
    const shell = installShell();
    const stream = streamProviderBytes({ provider: 'openai', model: 'gpt-4o', body: {} }, new AbortController().signal);

    const run = (async () => {
      for await (const _c of stream) break; // eslint-disable-line @typescript-eslint/no-unused-vars
    })();

    await tick();
    shell.emit({ type: 'chunk', text: 'first' });
    await run;

    expect(shell.cancelled).toEqual(['req-1']);
  });

  it('removes its listener on every exit path', async () => {
    const shell = installShell();
    const stream = streamProviderBytes({ provider: 'openai', model: 'gpt-4o', body: {} }, new AbortController().signal);

    const collected = collect(stream);
    await tick();
    expect(shell.listenerCount()).toBe(1);
    shell.emit({ type: 'done' });
    await collected;

    // A leaked listener per prompt is a slow leak that only shows in a long session.
    expect(shell.listenerCount()).toBe(0);
  });

  it('ignores events belonging to another in-flight stream', async () => {
    const shell = installShell();
    const stream = streamProviderBytes({ provider: 'openai', model: 'gpt-4o', body: {} }, new AbortController().signal);

    const collected = collect(stream);
    await tick();
    // One channel serves every request, so filtering by id is what keeps two
    // concurrent prompts from interleaving into each other's answers.
    shell.emit({ type: 'chunk', text: 'mine' });
    shell.emit({ type: 'chunk', text: 'THEIRS' }, 'req-other');
    shell.emit({ type: 'done' }, 'req-other');
    shell.emit({ type: 'done' });

    expect(await collected).toBe('mine');
  });

  it('passes the provider and model straight through', async () => {
    const shell = installShell();
    const stream = streamProviderBytes(
      { provider: 'anthropic', model: 'claude-sonnet-5', body: { messages: [] } },
      new AbortController().signal,
    );
    const collected = collect(stream);
    await tick();
    shell.emit({ type: 'done' });
    await collected;

    expect(shell.streamCalls[0]).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5' });
  });
});

describe('transport selection', () => {
  it('refuses clearly in a local build with no Electron bridge', async () => {
    // A browser build of the local edition. "Coming soon" would be wrong — the
    // desktop app IS the local edition, and that is the actionable thing to say.
    removeShell();
    const stream = streamProviderBytes({ provider: 'openai', model: 'gpt-4o', body: {} }, new AbortController().signal);

    await expect(collect(stream)).rejects.toMatchObject({ code: 'unsupported' });
    expect(localAiAvailable()).toBe(false);
  });

  it('detects the bridge when it is present', () => {
    installShell();
    expect(localAiAvailable()).toBe(true);
  });
});
