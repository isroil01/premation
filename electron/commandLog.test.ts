/**
 * `premation render --commands`: the recorded log becomes wire requests the
 * engine replays — the start document first (restoreDocument), commands and
 * batches in order, queries skipped; byte arrays revived from `$bytes`.
 */

import { decodeEngineMessage } from './generated/engineCodec';
import { commandLogRequests } from './commandLog';

const decode = (b64: string) => decodeEngineMessage(new Uint8Array(Buffer.from(b64, 'base64')));

describe('command logs for the engine', () => {
  const header = JSON.stringify({ header: { document: { version: 3, scene: { nodes: [] } }, ids: {}, revision: 0 } });
  const cmd = (seq: number, command: object) => JSON.stringify({ request: { seq, body: { kind: 'command', value: command }, origin: 'ui' }, revisionAfter: seq, documentHash: 0 });
  const query = JSON.stringify({ request: { seq: 9, body: { kind: 'query', value: { type: 'getHistory' } }, origin: 'ui' }, revisionAfter: 1, documentHash: 0 });

  it('restores the start document, then the commands in order; queries skipped', () => {
    const log = [header, cmd(1, { type: 'renameLayer', layer: 'l1', name: 'A' }), query, cmd(2, { type: 'undo' })].join('\n');
    const out = commandLogRequests(log);
    expect(out.skipped).toBe(1);
    expect(out.requests).toHaveLength(3);
    const msgs = out.requests.map(decode);
    expect(msgs.every((m) => m.kind === 'request')).toBe(true);
    const bodies = msgs.map((m) => (m.kind === 'request' ? m.value.body : null));
    expect(bodies[0]).toMatchObject({ kind: 'command', value: { type: 'restoreDocument' } });
    const doc = bodies[0]?.kind === 'command' && bodies[0].value.type === 'restoreDocument' ? bodies[0].value.document : null;
    expect(JSON.parse(new TextDecoder().decode(doc!))).toEqual({ version: 3, scene: { nodes: [] } });
    expect(bodies[1]).toEqual({ kind: 'command', value: { type: 'renameLayer', layer: 'l1', name: 'A' } });
    expect(bodies[2]).toEqual({ kind: 'command', value: { type: 'undo' } });
    expect(msgs.map((m) => (m.kind === 'request' ? m.value.seq : 0))).toEqual([1, 2, 3]);
  });

  it('revives $bytes arrays', () => {
    const withBytes = cmd(1, { type: 'restoreDocument', document: { $bytes: [123, 125] } });
    const out = commandLogRequests([header, withBytes].join('\n'));
    const m = decode(out.requests[1]!);
    const body = m.kind === 'request' ? m.value.body : null;
    expect(body?.kind === 'command' && body.value.type === 'restoreDocument' ? Array.from(body.value.document) : null).toEqual([123, 125]);
  });

  it('refuses what is not a command log', () => {
    expect(() => commandLogRequests('')).toThrow(/empty/);
    expect(() => commandLogRequests('{"nope":1}')).toThrow(/header/);
    expect(() => commandLogRequests(`${header}\n{"x":1}`)).toThrow(/line 2 has no "request"/);
    expect(() => commandLogRequests(`${header}\n${cmd(1, { type: 'noSuchCommand' })}`)).toThrow(/line 2 is not an engine request/);
  });
});
