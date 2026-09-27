/**
 * F2: main is the engine's one client — the command log lives here, and every
 * window's requests are renumbered into main's seq space. Pinned against the
 * generated codec: the rewritten bytes decode to the same message with only
 * the envelope field changed, and the log's peeks read what the codec wrote.
 */

import { decodeEngineMessage, encodeEngineMessage, type Command, type EngineMessage, type Response } from '@motion/engine-api';
import { appliedRequestFromLogRecord, peekRequest, responseIsError, withCausedBy, withEnvelopeSeq } from './engineFraming';
import { CMD, EngineCommandLog } from './engineCommandLog';

let seq = 0;
function req(command: Command): Uint8Array {
  seq += 1;
  return encodeEngineMessage({ kind: 'request', value: { seq, body: { kind: 'command', value: command }, origin: 'ui' } });
}
function query(): Uint8Array {
  seq += 1;
  return encodeEngineMessage({ kind: 'request', value: { seq, body: { kind: 'query', value: { type: 'getHistory' } }, origin: 'ui' } });
}
function ok(revision: number): Uint8Array {
  const r: Response = { seq: 1, revision, outcome: { kind: 'command', value: { type: 'newProject' } as never } };
  return encodeEngineMessage({ kind: 'response', value: r });
}
function err(): Uint8Array {
  const r: Response = { seq: 1, revision: 0, outcome: { kind: 'error', value: { code: 'notFound', message: 'no layer' } as never } };
  return encodeEngineMessage({ kind: 'response', value: r });
}

describe('envelope rewriting (main owns the seq space)', () => {
  it('replaces a request / response seq and nothing else', () => {
    const bytes = req({ type: 'renameLayer', layer: 'n1', name: 'Plate' } as Command);
    const out = withEnvelopeSeq(bytes, 9_000_001)!;
    const a = decodeEngineMessage(bytes) as Extract<EngineMessage, { kind: 'request' }>;
    const b = decodeEngineMessage(out) as Extract<EngineMessage, { kind: 'request' }>;
    expect(b.value.seq).toBe(9_000_001);
    expect({ ...b.value, seq: a.value.seq }).toEqual(a.value);
    // Back again is the original bytes (canonical order kept).
    expect(Array.from(withEnvelopeSeq(out, a.value.seq)!)).toEqual(Array.from(bytes));

    const res = withEnvelopeSeq(ok(4), 77)!;
    expect((decodeEngineMessage(res) as Extract<EngineMessage, { kind: 'response' }>).value).toMatchObject({ seq: 77, revision: 4 });
  });

  it('sets or removes an event batch causedBy', () => {
    const batch = encodeEngineMessage({ kind: 'events', value: { fromRevision: 3, toRevision: 4, events: [], causedBy: 12, origin: 'ui' } });
    const mapped = decodeEngineMessage(withCausedBy(batch, 5)!) as Extract<EngineMessage, { kind: 'events' }>;
    expect(mapped.value).toMatchObject({ fromRevision: 3, toRevision: 4, causedBy: 5, origin: 'ui' });
    const stripped = decodeEngineMessage(withCausedBy(batch, null)!) as Extract<EngineMessage, { kind: 'events' }>;
    expect(stripped.value.causedBy).toBeUndefined();
    expect(stripped.value.origin).toBe('ui');
  });

  it('peeks a request kind, command id and first field; an error outcome', () => {
    expect(peekRequest(req({ type: 'newProject' } as Command))).toMatchObject({ body: 'command', commandId: CMD.newProject });
    expect(peekRequest(req({ type: 'closeViewport', viewport: 2 } as Command))).toMatchObject({ commandId: CMD.closeViewport, firstVarint: 2 });
    expect(peekRequest(query())).toEqual({ body: 'query' });
    expect(responseIsError(ok(1))).toBe(false);
    expect(responseIsError(err())).toBe(true);
    expect(peekRequest(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe('EngineCommandLog', () => {
  it('records applied non-query requests; newProject clears; errors and queries are not recorded', () => {
    const log = new EngineCommandLog();
    log.record(req({ type: 'renameLayer', layer: 'a', name: 'x' } as Command), ok(1), 1);
    log.record(req({ type: 'newProject' } as Command), ok(2), 2);
    log.record(query(), ok(2), 2);
    log.record(req({ type: 'renameLayer', layer: 'b', name: 'y' } as Command), err(), 2);
    log.record(req({ type: 'renameLayer', layer: 'c', name: 'z' } as Command), ok(3), 3);
    expect(log.length).toBe(2);
    expect(log.plan().map((e) => e.revisionAfter)).toEqual([2, 3]);
  });

  it('replays view controls only as their last value, transport play / pause / step never', () => {
    const log = new EngineCommandLog();
    log.record(req({ type: 'newProject' } as Command), ok(1), 1);
    log.record(req({ type: 'closeViewport', viewport: 1 } as Command), ok(1), 1);
    log.record(req({ type: 'setLoop', mode: 'loop' } as Command), ok(1), 1);
    log.record(req({ type: 'step', frames: 1 } as Command), ok(1), 1);
    log.record(req({ type: 'closeViewport', viewport: 2 } as Command), ok(1), 1);
    log.record(req({ type: 'setLoop', mode: 'once' } as Command), ok(1), 1);
    log.record(req({ type: 'pause', returnToStart: false } as Command), ok(1), 1);
    log.record(req({ type: 'closeViewport', viewport: 1 } as Command), ok(1), 1);
    const plan = log.plan().map((e) => [e.commandId, peekRequest(e.bytes)?.firstVarint]);
    expect(plan).toEqual([
      [CMD.newProject, 0],
      [CMD.closeViewport, 2],
      [CMD.setLoop, expect.any(Number)],
      [CMD.closeViewport, 1],
    ]);
  });

  it('records nothing when switched off', () => {
    const log = new EngineCommandLog(false);
    log.record(req({ type: 'newProject' } as Command), ok(1), 1);
    expect(log.length).toBe(0);
  });

  it('replaces the finished job and leaves a still-running job to replay', () => {
    const log = new EngineCommandLog();
    const start = (layer: string) => req({
      type: 'startJob',
      job: { kind: 'sceneDetect', value: { layer, createMarkers: true, splitLayers: false } },
      apply: true,
    } as Command);
    const started = (job: string, revision: number): Uint8Array => encodeEngineMessage({
      kind: 'response',
      value: { seq: 1, revision, outcome: { kind: 'command', value: { type: 'startJob', job } as never } },
    });
    log.record(start('A'), started('job_1', 2), 2);
    log.record(req({ type: 'renameLayer', layer: 'A', name: 'Plate' } as Command), ok(3), 3);
    log.record(start('B'), started('job_2', 3), 3);
    const applied = appliedRequestFromLogRecord(encodeEngineMessage({
      kind: 'logRecord',
      value: {
        request: {
          seq: 0,
          origin: 'engine',
          body: { kind: 'batch', value: { label: 'Scene Edit', commands: [{ type: 'renameLayer', layer: 'A', name: 'Cut' } as Command] } },
        },
        revisionAfter: 4,
        documentHash: 0,
        job: 'job_2',
      },
    }))!;
    log.absorbJobEdit(applied.bytes, applied.revisionAfter, applied.job);
    const plan = log.plan();
    expect(plan).toHaveLength(3);
    expect(plan[0]).toMatchObject({ commandId: CMD.startJob, jobId: 'job_1' });
    expect(plan.some((e) => e.jobId === 'job_2')).toBe(false);
    expect(plan[2]!.revisionAfter).toBe(4);
    const batch = decodeEngineMessage(plan[2]!.bytes) as Extract<EngineMessage, { kind: 'request' }>;
    expect(batch.value.body).toMatchObject({ kind: 'batch', value: { label: 'Scene Edit' } });
  });
});
