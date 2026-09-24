/**
 * ProcessEngineClient over a scripted bridge: the §8.2 revision rule (gap →
 * resync, duplicate → ignored), requests held while the engine restarts and
 * the log replayed first, and the fallback switch with its one notice.
 * (The real process is exercised in src/core/engine/process/__tests__.)
 */

import type { EventBatch, Request, Response } from './generated/types';
import { decodeEngineMessage, encodeEngineMessage } from './generated/codec';
import { ProcessEngineClient, type EngineBridge, type EngineHostState, type EngineRestartNotice, type ProcessEngineNotice } from './process';
import { EngineClientBase, type EventListener } from './client';

class FakeHost {
  revision = 0;
  requests: Request[] = [];
  state: EngineHostState = 'running';
  private events: Array<(b: Uint8Array) => void> = [];
  private states: Array<(s: EngineHostState) => void> = [];
  private restarted: Array<(i: EngineRestartNotice) => void> = [];
  private fallbacks: Array<(i: { reason: string; logTail: string[] }) => void> = [];
  /** Hold responses until released (to test ordering). */
  hold = false;
  private held: Array<() => void> = [];

  bridge: EngineBridge = {
    request: async (bytes) => {
      const msg = decodeEngineMessage(bytes);
      if (msg.kind !== 'request') throw new Error('not a request');
      const req = msg.value;
      if (this.state !== 'running') return { ok: false, reason: 'gone', message: 'engine is restarting' };
      this.requests.push(req);
      const res = this.answer(req);
      if (this.hold) await new Promise<void>((r) => this.held.push(r));
      return { ok: true, bytes: encodeEngineMessage({ kind: 'response', value: res }).slice() };
    },
    status: async () => ({ enabled: true, state: this.state }),
    onEvents: (h) => this.add(this.events, h),
    onState: (h) => this.add(this.states, h),
    onRestarted: (h) => this.add(this.restarted, h),
    onFallback: (h) => this.add(this.fallbacks, h),
  };

  private add<T>(list: T[], h: T): () => void {
    list.push(h);
    return () => list.splice(list.indexOf(h), 1);
  }

  answer(req: Request): Response {
    if (req.body.kind === 'query') return { seq: req.seq, revision: this.revision, outcome: { kind: 'query', value: { type: 'getHistory', entries: [], position: 0, canUndo: false, canRedo: false, gestureOpen: false, limit: 100 } } };
    // Every command is an edit that bumps the revision and emits one batch, events first.
    const from = this.revision;
    this.revision += 1;
    this.emit({ fromRevision: from, toRevision: this.revision, events: [{ type: 'layersRemoved', comp: 'C1', layers: [] }], causedBy: req.seq, origin: 'ui' });
    return { seq: req.seq, revision: this.revision, outcome: { kind: 'command', value: { type: 'renameLayer', repaired: 0, captured: 0, nameAlreadyInUse: false } } };
  }

  emit(b: EventBatch): void {
    const bytes = encodeEngineMessage({ kind: 'events', value: b }).slice();
    for (const h of [...this.events]) h(bytes);
  }
  setState(s: EngineHostState): void {
    this.state = s;
    for (const h of [...this.states]) h(s);
  }
  restart(): void {
    this.revision = 0;
    this.setState('running');
    for (const h of [...this.restarted]) h({ attempt: 1, cause: 'crash', exitCode: 1, signal: null, logTail: [] });
  }
  fallback(reason: string): void {
    this.setState('fallback');
    for (const h of [...this.fallbacks]) h({ reason, logTail: [] });
  }
  releaseHeld(): void {
    for (const r of this.held.splice(0)) r();
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function setup(opts: { fallback?: EngineClientBase } = {}) {
  const host = new FakeHost();
  const notices: ProcessEngineNotice[] = [];
  const client = new ProcessEngineClient(host.bridge, { onNotice: (n) => notices.push(n), ...(opts.fallback ? { fallback: () => opts.fallback! } : {}) });
  const batches: EventBatch[] = [];
  client.subscribe((b) => batches.push(b));
  return { host, client, notices, batches };
}

describe('ProcessEngineClient', () => {
  it('relays requests and events, events before the awaited result', async () => {
    const { client, batches } = setup();
    await client.whenReady();
    const r = await client.execute({ type: 'renameLayer', layer: 'L1', name: 'x' });
    expect(r.ok).toBe(true);
    expect(r.revision).toBe(1);
    expect(batches.map((b) => [b.fromRevision, b.toRevision])).toEqual([[0, 1]]);
    expect(client.eventRevision).toBe(1);
  });

  it('§8.2: a gap drops the batch and resyncs with a documentReset; a duplicate is ignored', async () => {
    const { host, client, batches } = setup();
    await client.whenReady();
    await client.execute({ type: 'renameLayer', layer: 'L1', name: 'a' });
    // A lost batch: the engine is at 3, the mirror at 1.
    host.revision = 3;
    host.emit({ fromRevision: 2, toRevision: 3, events: [], origin: 'engine' });
    await flush();
    const last = batches[batches.length - 1]!;
    expect(last.events[0]).toMatchObject({ type: 'documentReset', reason: 'resync', revision: 3 });
    expect(client.eventRevision).toBe(3);
    const n = batches.length;
    host.emit({ fromRevision: 2, toRevision: 3, events: [{ type: 'layersRemoved', comp: 'C1', layers: [] }], origin: 'engine' });
    expect(batches).toHaveLength(n);
  });

  it('a response that overtakes its events does not make them look stale', async () => {
    const { host, client, batches } = setup();
    await client.whenReady();
    host.hold = true;
    const p = client.execute({ type: 'renameLayer', layer: 'L1', name: 'a' });
    await flush();
    host.releaseHeld();
    await p;
    expect(batches.filter((b) => b.fromRevision !== b.toRevision)).toHaveLength(1);
  });

  it('holds requests while the engine restarts, replays the log first, then resets the mirror once', async () => {
    const { host, client, batches, notices } = setup();
    await client.whenReady();
    await client.execute({ type: 'renameLayer', layer: 'L1', name: 'a' });
    await client.execute({ type: 'renameLayer', layer: 'L1', name: 'b' });
    await client.query({ type: 'getHistory' });  // queries are not logged
    expect(client.commandLog()).toHaveLength(2);
    host.setState('restarting');
    const during = client.execute({ type: 'renameLayer', layer: 'L1', name: 'c' });
    await flush();
    expect(host.requests.filter((r) => r.body.kind === 'command')).toHaveLength(2);  // held
    const before = host.requests.length;
    host.restart();
    const r = await during;
    expect(r.ok).toBe(true);
    const after = host.requests.slice(before).filter((q) => q.body.kind === 'command').map((q) => (q.body.value as { name: string }).name);
    expect(after).toEqual(['a', 'b', 'c']);  // replay, then the held request
    expect(r.revision).toBe(3);
    const resets = batches.filter((b) => b.events.some((e) => e.type === 'documentReset'));
    expect(resets).toHaveLength(1);
    expect(resets[0]!.events[0]).toMatchObject({ reason: 'engineRestarted', revision: 2 });
    expect(notices).toEqual([expect.objectContaining({ kind: 'restarted', replayed: 2, mismatches: 0 })]);
  });

  it('falls back to the TypeScript backend, forwards its events, and says so once', async () => {
    class Fallback extends EngineClientBase {
      private l = new Set<EventListener>();
      async request(req: Request): Promise<Response> {
        this.noteRevision(this.revision + 1);
        for (const f of this.l) f({ fromRevision: this.revision - 1, toRevision: this.revision, events: [], causedBy: req.seq, origin: 'ui' });
        return { seq: req.seq, revision: this.revision, outcome: { kind: 'command', value: { type: 'renameLayer', repaired: 0, captured: 0, nameAlreadyInUse: false } } };
      }
      subscribe(f: EventListener): () => void {
        this.l.add(f);
        return () => this.l.delete(f);
      }
      async close(): Promise<void> {}
    }
    const fb = new Fallback();
    const { host, client, notices, batches } = setup({ fallback: fb });
    await client.whenReady();
    host.fallback('crashed 3 times within 60 s');
    host.fallback('again');
    expect(client.backend).toBe('fallback');
    const r = await client.execute({ type: 'renameLayer', layer: 'layer_1', name: 'z' });
    expect(r.ok).toBe(true);
    expect(host.requests.filter((q) => q.body.kind === 'command')).toHaveLength(0);
    expect(notices).toEqual([{ kind: 'fallback', reason: 'crashed 3 times within 60 s' }]);
    expect(batches.some((b) => b.events.some((e) => e.type === 'documentReset'))).toBe(true);
    expect(batches[batches.length - 1]!.toRevision).toBe(1);
  });

  it('switched off → falls back at once', async () => {
    const host = new FakeHost();
    host.bridge.status = async () => ({ enabled: false, state: 'disabled' });
    const notices: ProcessEngineNotice[] = [];
    const client = new ProcessEngineClient(host.bridge, { onNotice: (n) => notices.push(n) });
    await client.whenReady();
    expect(client.backend).toBe('fallback');
    const r = await client.execute({ type: 'undo' });
    expect(r.ok).toBe(false);
    expect(notices).toHaveLength(1);
  });
});
