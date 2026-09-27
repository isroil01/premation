/**
 * F2: main is the engine's one client — the command log lives here, and every
 * window's requests are renumbered into main's seq space. Pinned against the
 * generated codec: the rewritten bytes decode to the same message with only
 * the envelope field changed, and the log's peeks read what the codec wrote.
 */

import { decodeEngineMessage, encodeEngineMessage, type Command, type EngineMessage, type Response } from '@motion/engine-api';
import {
  appliedRequestFromLogRecord,
  peekRequest,
  responseIsError,
  transcribeProviderOf,
  withCausedBy,
  withEnvelopeSeq,
  withTranscribeCredential,
} from './engineFraming';
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

  it('replays a job only as the edit it applied, never as startJob', () => {
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
    // job_1 is still running (or was cancelled): nothing of it is replayed.
    const plan = log.plan();
    expect(plan).toHaveLength(2);
    expect(plan.some((e) => e.commandId === CMD.startJob)).toBe(false);
    expect(plan[1]!.revisionAfter).toBe(4);
    const batch = decodeEngineMessage(plan[1]!.bytes) as Extract<EngineMessage, { kind: 'request' }>;
    expect(batch.value.body).toMatchObject({ kind: 'batch', value: { label: 'Scene Edit' } });
  });

  it('logs a held result applied later as its commands, not as applyJobResult', () => {
    const log = new EngineCommandLog();
    const started = encodeEngineMessage({
      kind: 'response',
      value: { seq: 1, revision: 1, outcome: { kind: 'command', value: { type: 'startJob', job: 'job_7' } as never } },
    });
    log.record(req({
      type: 'startJob',
      job: { kind: 'audioGate', value: { layer: 'A', params: '{}' } },
      apply: false,
    } as Command), started, 1);
    // The engine sends the log record, then answers the applyJobResult.
    const applied = appliedRequestFromLogRecord(encodeEngineMessage({
      kind: 'logRecord',
      value: {
        request: {
          seq: 0,
          origin: 'engine',
          body: { kind: 'batch', value: { label: 'Gate', commands: [{ type: 'renameLayer', layer: 'A', name: 'Gated' } as Command] } },
        },
        revisionAfter: 2,
        documentHash: 0,
        job: 'job_7',
      },
    }))!;
    log.absorbJobEdit(applied.bytes, applied.revisionAfter, applied.job);
    log.record(req({ type: 'applyJobResult', job: 'job_7' } as Command), ok(2), 2);
    const plan = log.plan();
    expect(plan).toHaveLength(1);
    expect(plan[0]!.commandId).toBeUndefined();
    const batch = decodeEngineMessage(plan[0]!.bytes) as Extract<EngineMessage, { kind: 'request' }>;
    expect(batch.value.body).toMatchObject({ kind: 'batch', value: { label: 'Gate' } });
  });
});

describe("the transcribe job's provider key (main to engine only)", () => {
  const transcribe = (credential?: string) => req({
    type: 'startJob',
    job: {
      kind: 'transcribe',
      value: { layer: '', language: 'en', createCaptions: false, comp: 'comp_1', provider: 'openai', ...(credential !== undefined ? { credential } : {}) },
    },
    apply: false,
  } as Command);
  const specOf = (bytes: Uint8Array) => {
    const m = decodeEngineMessage(bytes) as Extract<EngineMessage, { kind: 'request' }>;
    const body = m.value.body as Extract<typeof m.value.body, { kind: 'command' }>;
    const start = body.value as Extract<Command, { type: 'startJob' }>;
    return start.job as Extract<typeof start.job, { kind: 'transcribe' }>;
  };

  it('reads the provider of a transcribe startJob and nothing else', () => {
    expect(transcribeProviderOf(transcribe())).toBe('openai');
    expect(transcribeProviderOf(req({ type: 'renameLayer', layer: 'A', name: 'x' } as Command))).toBeNull();
    expect(transcribeProviderOf(req({
      type: 'startJob',
      job: { kind: 'sceneDetect', value: { layer: 'A', createMarkers: true, splitLayers: false } },
      apply: true,
    } as Command))).toBeNull();
  });

  it('writes the key in, replacing what the page sent, and takes it out again', () => {
    const page = transcribe();
    const withKey = withTranscribeCredential(transcribe('page-sent'), 'sk-secret');
    const spec = specOf(withKey);
    expect(spec.value.credential).toBe('sk-secret');
    expect(spec.value).toMatchObject({ comp: 'comp_1', language: 'en', provider: 'openai' });
    const stripped = withTranscribeCredential(withKey, '');
    expect(specOf(stripped).value.credential).toBeUndefined();
    expect(new TextDecoder().decode(stripped)).not.toContain('sk-secret');
    // Canonical: the page's own request (no key) round-trips byte for byte.
    const back = withTranscribeCredential(withTranscribeCredential(page, 'k'), '');
    expect(Array.from(back)).toEqual(Array.from(page));
    // Anything else passes through untouched.
    const other = req({ type: 'renameLayer', layer: 'A', name: 'x' } as Command);
    expect(withTranscribeCredential(other, 'k')).toBe(other);
  });
});
