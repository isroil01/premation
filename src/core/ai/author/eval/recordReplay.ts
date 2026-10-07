/**
 * Record / replay for the eval harness's model calls.
 *
 * RECORD (`AI_EVAL_RECORD=1`, needs `ANTHROPIC_API_KEY`): every request goes
 * to the Anthropic API for real, and its raw SSE text is kept in order.
 * REPLAY (default): the recorded answers are served back in order, so a run
 * can be repeated — after a compiler or prompt change that does not change
 * the requests, or on a machine with no key — at no cost.
 *
 * Answers are matched in ORDER, checked by a key over the request's TEXT
 * (system + user, images excluded). Images are left out of the key on
 * purpose: they are renders, and a renderer change must not invalidate every
 * fixture. A key mismatch means the requests changed; strict replay fails,
 * lenient replay warns and serves the next answer anyway.
 *
 * Pure apart from the network call in `recordingTransport`; the fixture
 * shape and matching are unit-tested in evalKit.test.ts.
 */

import { createHash } from 'node:crypto';
import type { TransportOverride, TransportRequest } from '../../aiTransport';

export interface FixtureEntry {
  /** `sha1(system \n user)` of the request, images excluded. */
  key: string;
  /** The first 80 characters of the user text, for a human reading the file. */
  hint: string;
  /** The provider's raw SSE text, in the chunks it arrived in. */
  chunks: string[];
}

export interface Fixture {
  version: 1;
  provider: string;
  model: string;
  entries: FixtureEntry[];
}

/** The request's text parts — what the key is computed over. */
export function requestText(req: TransportRequest): { system: string; user: string } {
  const body = (req.body ?? {}) as { system?: string; messages?: Array<{ role: string; content: unknown }> };
  const user = (body.messages ?? [])
    .map((m) => {
      if (typeof m.content === 'string') return `${m.role}: ${m.content}`;
      if (Array.isArray(m.content)) {
        return `${m.role}: ${(m.content as Array<{ type?: string; text?: string }>).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')}`;
      }
      return `${m.role}:`;
    })
    .join('\n');
  return { system: body.system ?? '', user };
}

export function requestKey(req: TransportRequest): string {
  const { system, user } = requestText(req);
  return createHash('sha1').update(system).update('\n').update(user).digest('hex');
}

function hintOf(req: TransportRequest): string {
  return requestText(req).user.replace(/\s+/g, ' ').slice(0, 80);
}

/**
 * A transport that serves `fixture` in order. `strict` throws on a key
 * mismatch or a request past the end; lenient warns on a mismatch.
 */
export function replayTransport(fixture: Fixture, strict: boolean): { transport: TransportOverride; served: () => number; mismatches: string[] } {
  let i = 0;
  const mismatches: string[] = [];
  const transport: TransportOverride = (req) => {
    const at = i++;
    const entry = fixture.entries[at];
    const key = requestKey(req);
    if (!entry) {
      const msg = `replay: request ${at} ("${hintOf(req)}") is past the end of the fixture (${fixture.entries.length} recorded) — re-record with AI_EVAL_RECORD=1`;
      // eslint-disable-next-line require-yield
      return (async function* () { throw new Error(msg); })();
    }
    if (entry.key !== key) {
      const msg = `replay: request ${at} changed since it was recorded ("${hintOf(req)}" vs recorded "${entry.hint}")`;
      mismatches.push(msg);
      // eslint-disable-next-line require-yield
      if (strict) return (async function* () { throw new Error(msg); })();
    }
    return (async function* () {
      for (const c of entry.chunks) yield c;
    })();
  };
  return { transport, served: () => i, mismatches };
}

/** Where a recording transport sends a request: injectable so the recorder is testable. */
export type SendFn = (req: TransportRequest, signal: AbortSignal) => AsyncGenerator<string, void, undefined>;

/** A transport that sends through `send` and appends every exchange to `fixture`. */
export function recordingTransport(fixture: Fixture, send: SendFn): TransportOverride {
  return (req, signal) => {
    const entry: FixtureEntry = { key: requestKey(req), hint: hintOf(req), chunks: [] };
    fixture.entries.push(entry);
    return (async function* () {
      for await (const c of send(req, signal)) {
        entry.chunks.push(c);
        yield c;
      }
    })();
  };
}

/**
 * Send one request to the Anthropic Messages API and stream its SSE text.
 * Node's `https` rather than `fetch`: the jsdom test environment has no
 * fetch, and the eval suite needs jsdom for the rest of the app.
 */
export function anthropicSend(apiKey: string): SendFn {
  return async function* (req, signal) {
    const https = await import('node:https');
    const body = JSON.stringify(req.body);
    const queue: string[] = [];
    let done = false;
    let failure: Error | null = null;
    let wake: (() => void) | null = null;
    const notify = () => { wake?.(); wake = null; };
    const request = https.request(
      {
        method: 'POST',
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const decoder = new TextDecoder();
        if ((res.statusCode ?? 500) >= 400) {
          let text = '';
          res.on('data', (d: Buffer) => { text += decoder.decode(d, { stream: true }); });
          res.on('end', () => { failure = new Error(`anthropic ${res.statusCode}: ${text.slice(0, 400)}`); done = true; notify(); });
          return;
        }
        res.on('data', (d: Buffer) => { queue.push(decoder.decode(d, { stream: true })); notify(); });
        res.on('end', () => { const tail = decoder.decode(); if (tail) queue.push(tail); done = true; notify(); });
        res.on('error', (e) => { failure = e; done = true; notify(); });
      },
    );
    request.on('error', (e) => { failure = e; done = true; notify(); });
    signal.addEventListener('abort', () => { request.destroy(new Error('aborted')); });
    request.end(body);
    while (true) {
      if (queue.length) { yield queue.shift()!; continue; }
      if (failure) throw failure;
      if (done) return;
      await new Promise<void>((r) => { wake = r; });
    }
  };
}

export function emptyFixture(provider: string, model: string): Fixture {
  return { version: 1, provider, model, entries: [] };
}
