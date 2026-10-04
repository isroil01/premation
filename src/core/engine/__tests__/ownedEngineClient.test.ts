/**
 * D5 / F2: the owner client — every request answered by the owner (the C++
 * engine's process client); the page keeps no replica.
 */

import { EngineClientBase, type EventListener, type Request, type Response } from '@motion/engine-api';
import { OwnedEngineClient, type OwnerClient } from '../ownedEngineClient';

class FakeOwner extends EngineClientBase implements OwnerClient {
  backend: OwnerClient['backend'] = 'process';
  readonly seen: Request[] = [];
  readonly listeners = new Set<EventListener>();
  rev = 0;
  async request(req: Request): Promise<Response> {
    this.seen.push(req);
    if (req.body.kind !== 'query') this.rev += 1;
    const outcome: Response['outcome'] = req.body.kind === 'command'
      ? { kind: 'command', value: { type: req.body.value.type } as never }
      : { kind: 'query', value: { type: 'getHistory' } as never };
    return { seq: req.seq, revision: this.rev, outcome };
  }
  subscribe(l: EventListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  closed = false;
  async close(): Promise<void> {
    this.closed = true;
  }
}

describe('OwnedEngineClient', () => {
  it('sends every request to the owner and tracks its revision', async () => {
    const owner = new FakeOwner();
    const client = new OwnedEngineClient(owner);
    expect((await client.execute({ type: 'setLayerName', layer: 'a', name: 'A' } as never)).ok).toBe(true);
    expect((await client.query({ type: 'getItems', items: [] })).ok).toBe(true);
    expect(owner.seen.map((r) => (r.body.kind === 'command' ? r.body.value.type : r.body.kind))).toEqual(['setLayerName', 'query']);
    expect(client.revision).toBe(1);
  });

  it('subscribes and closes through the owner', async () => {
    const owner = new FakeOwner();
    const client = new OwnedEngineClient(owner);
    const off = client.subscribe(() => undefined);
    expect(owner.listeners.size).toBe(1);
    off();
    expect(owner.listeners.size).toBe(0);
    await client.close();
    expect(owner.closed).toBe(true);
  });
});
