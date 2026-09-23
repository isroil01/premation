/** EngineClientBase: the helpers are thin, transport-agnostic wrappers over request(). */

import { EngineClientBase, unwrap, EngineRequestError, commandKind, isCoalescable, type EventListener } from './client';
import type { Request, Response } from './generated/types';

class Echo extends EngineClientBase {
  sent: Request[] = [];
  async request(req: Request): Promise<Response> {
    this.sent.push(req);
    if (req.body.kind === 'command' && req.body.value.type === 'renameLayer') {
      return { seq: req.seq, revision: 7, outcome: { kind: 'error', value: { code: 'notFound', message: 'no layer' } } };
    }
    if (req.body.kind === 'command') return { seq: req.seq, revision: 3, outcome: { kind: 'command', value: { type: 'beginGesture', gesture: 1 } } };
    if (req.body.kind === 'batch') return { seq: req.seq, revision: 4, outcome: { kind: 'batch', value: { results: [] } } };
    return { seq: req.seq, revision: 4, outcome: { kind: 'query', value: { type: 'getHistory', entries: [], position: 0, canUndo: false, canRedo: false, gestureOpen: false, limit: 1 } } };
  }
  subscribe(_l: EventListener): () => void {
    return () => undefined;
  }
  async close(): Promise<void> {}
}

test('execute / batch / query map outcomes to results and track the revision', async () => {
  const c = new Echo();
  const g = await c.beginGesture('Move', { origin: 'ai' });
  expect(unwrap(g)).toEqual({ gesture: 1 });
  expect(c.sent[0]!.origin).toBe('ai');
  expect(c.sent[0]!.seq).toBe(1);
  const b = await c.batch('x', []);
  expect(b.ok).toBe(true);
  const q = await c.query({ type: 'getHistory' });
  expect(unwrap(q).limit).toBe(1);
  const e = await c.execute({ type: 'renameLayer', layer: 'a', name: 'b' });
  expect(e.ok).toBe(false);
  expect(() => unwrap(e)).toThrow(EngineRequestError);
  expect(c.revision).toBe(7);
  await c.execute({ type: 'renameLayer', layer: 'a', name: 'b' }, { baseRevision: 7 });
  expect(c.sent.at(-1)!.baseRevision).toBe(7);
});

test('schema metadata helpers', () => {
  expect(commandKind('setProperty')).toBe('edit');
  expect(commandKind('seek')).toBe('control');
  expect(commandKind('saveProject')).toBe('io');
  expect(isCoalescable('setProperty')).toBe(true);
  expect(isCoalescable('deleteLayers')).toBe(false);
});
