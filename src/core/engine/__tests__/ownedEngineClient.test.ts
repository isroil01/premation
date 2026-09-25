/**
 * D5 / F2: the owner client — every request answered by the owner (the C++
 * engine's process client), document-changing ones also replayed into the
 * page's replica, differences counted and never shown to the caller.
 */

import { EngineClientBase, type EventListener, type Request, type Response } from '@motion/engine-api';
import { OwnedEngineClient, replicates, type OwnerClient } from '../ownedEngineClient';

class FakeClient extends EngineClientBase {
  readonly seen: Request[] = [];
  answer: (req: Request) => Response['outcome'] = (req) =>
    req.body.kind === 'command' ? { kind: 'command', value: { type: req.body.value.type } as never } : { kind: 'query', value: { type: 'getHistory' } as never };
  rev = 0;
  async request(req: Request): Promise<Response> {
    this.seen.push(req);
    if (req.body.kind !== 'query') this.rev += 1;
    return { seq: req.seq, revision: this.rev, outcome: this.answer(req) };
  }
  subscribe(_l: EventListener): () => void {
    return () => undefined;
  }
  async close(): Promise<void> {}
}

class FakeOwner extends FakeClient implements OwnerClient {
  backend: OwnerClient['backend'] = 'process';
}

const types = (c: FakeClient): string[] => c.seen.map((r) => (r.body.kind === 'command' ? r.body.value.type : r.body.kind));

function setup(): { owner: FakeOwner; replica: FakeClient; client: OwnedEngineClient } {
  const owner = new FakeOwner();
  const replica = new FakeClient();
  return { owner, replica, client: new OwnedEngineClient(owner, () => replica) };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('OwnedEngineClient', () => {
  it('answers from the owner and replays edits, batches, lifecycle and history into the replica', async () => {
    const { owner, replica, client } = setup();
    await client.execute({ type: 'newProject' });
    await client.execute({ type: 'renameLayer', layer: 'l1', name: 'A' });
    await client.batch('Two', [{ type: 'renameLayer', layer: 'l1', name: 'B' }]);
    await client.execute({ type: 'undo' });
    await client.execute({ type: 'beginGesture', label: 'Drag' });
    await client.execute({ type: 'openProject', path: 'C:/p.motion' });
    await flush();
    expect(types(owner)).toEqual(['newProject', 'renameLayer', 'batch', 'undo', 'beginGesture', 'openProject']);
    expect(types(replica)).toEqual(types(owner));
    expect(client.replicaStats).toMatchObject({ forwarded: 6, mismatches: 0 });
  });

  it('keeps queries, saves, transport, viewport and job results with the owner alone', async () => {
    const { owner, replica, client } = setup();
    await client.query({ type: 'getHistory' });
    await client.execute({ type: 'saveProject', path: 'C:/p.motion', copy: false });
    await client.execute({ type: 'play', rate: 1, range: 'all', audio: true, cacheFirst: false });
    await client.execute({ type: 'seek', time: 0, mode: 'exact' });
    await client.execute({ type: 'setActiveComposition', comp: 'c1' });
    await client.execute({ type: 'setViewport', viewport: 1, width: 10, height: 10, devicePixelRatio: 1, zoom: 1, pan: { x: 0, y: 0 }, channel: 'rgb', exposure: 0, transparencyGrid: false, displayTransform: '', layerRenderEffects: true });
    await flush();
    expect(owner.seen).toHaveLength(6);
    expect(replica.seen).toHaveLength(0);
    expect(replicates({ seq: 1, origin: 'ui', body: { kind: 'command', value: { type: 'applyJobResult', job: 'j' } as never } })).toBe(false);
  });

  it('never gives the replica the owner\'s baseRevision (its revisions are its own)', async () => {
    const { replica, client } = setup();
    await client.execute({ type: 'renameLayer', layer: 'l1', name: 'A' }, { baseRevision: 42 });
    await flush();
    expect(replica.seen[0]!.baseRevision).toBeUndefined();
  });

  it('counts a difference and still returns the owner\'s answer', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { replica, client } = setup();
    replica.answer = () => ({ kind: 'error', value: { code: 'notFound', message: 'no layer' } });
    const r = await client.execute({ type: 'renameLayer', layer: 'l1', name: 'A' });
    await flush();
    expect(r.ok).toBe(true);
    expect(client.replicaStats.mismatches).toBe(1);
    expect(client.replicaStats.last[0]).toContain('renameLayer');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('maps the owner\'s gesture id to the replica\'s for endGesture', async () => {
    const { owner, replica, client } = setup();
    owner.answer = (req) => ({ kind: 'command', value: { type: (req.body as { value: { type: string } }).value.type, gesture: 7 } as never });
    replica.answer = (req) => ({ kind: 'command', value: { type: (req.body as { value: { type: string } }).value.type, gesture: 3 } as never });
    const g = await client.execute({ type: 'beginGesture', label: 'Drag' });
    await flush();
    expect(g.ok && (g.value as { gesture: number }).gesture).toBe(7);
    await client.execute({ type: 'endGesture', gesture: 7, commit: true });
    await flush();
    const end = replica.seen[1]!;
    expect(end.body.kind === 'command' && end.body.value.type === 'endGesture' && end.body.value.gesture).toBe(3);
    expect(client.replicaStats.mismatches).toBe(0);
  });

  it('stops replaying once the owner has fallen back (it then answers from the replica itself)', async () => {
    const { owner, replica, client } = setup();
    owner.backend = 'fallback';
    await client.execute({ type: 'renameLayer', layer: 'l1', name: 'A' });
    await flush();
    expect(owner.seen).toHaveLength(1);
    expect(replica.seen).toHaveLength(0);
  });
});
