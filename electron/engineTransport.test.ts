// engineFraming + engineTransport: the byte helpers are pinned against the
// generated codec (so main's hand-written peeks cannot drift from the schema),
// the transport is exercised over in-memory streams, and — when it has been
// built (`node scripts/native.mjs build --engine`) — against the REAL
// premation-engine with a scripted session.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PassThrough, type Readable, type Writable } from 'node:stream';
import {
  codecs,
  decodeEngineMessage,
  encodeEngineMessage,
  type Command,
  type EngineMessage,
  type FrameChannelMessage,
  type Query,
  type Response,
} from '@motion/engine-api';
import {
  FrameDecoder,
  PROTOCOL_MAJOR,
  decodeFrameMessage,
  decodeGoodbye,
  decodeWelcome,
  encodeFrameMessage,
  encodeGoodbye,
  encodeHello,
  encodePing,
  encodeRelease,
  frame,
  peekEnvelope,
  type FrameReadyMessage,
} from './engineFraming';
import { EngineGoneError, EngineTransport } from './engineTransport';

const FLICKS = 705_600_000;

function requestBytes(seq: number, body: { kind: 'command'; value: Command } | { kind: 'query'; value: Query }): Uint8Array {
  return encodeEngineMessage({ kind: 'request', value: { seq, body, origin: 'ui' } });
}

describe('engineFraming — pinned against the generated codec', () => {
  it('speaks the schema major', () => {
    const schema = readFileSync(path.join(__dirname, '..', 'packages', 'engine-api', 'schema', '00_core.eapi'), 'utf8');
    const m = /^version (\d+)\.(\d+);/m.exec(schema);
    expect(Number(m?.[1])).toBe(PROTOCOL_MAJOR);
  });

  it('encodes Hello byte-identically', () => {
    const mine = encodeHello({ client: 'premation-ui', clientVersion: '1.2.3', capabilities: ['frames.sharedTexture', 'x'] });
    const theirs = encodeEngineMessage({
      kind: 'hello',
      value: { protocolMajor: 1, protocolMinor: 0, client: 'premation-ui', clientVersion: '1.2.3', capabilities: ['frames.sharedTexture', 'x'] },
    });
    expect(Buffer.from(mine).toString('hex')).toBe(Buffer.from(theirs).toString('hex'));
  });

  it('encodes Goodbye byte-identically and decodes it', () => {
    const mine = encodeGoodbye('normal', 'bye');
    const theirs = encodeEngineMessage({ kind: 'goodbye', value: { reason: 'normal', message: 'bye' } });
    expect(Buffer.from(mine)).toEqual(Buffer.from(theirs));
    const g = encodeEngineMessage({ kind: 'goodbye', value: { reason: 'versionMismatch', message: 'nope' } });
    expect(decodeGoodbye(peekEnvelope(g)!.body)).toEqual({ reason: 'versionMismatch', message: 'nope' });
  });

  it('decodes Welcome', () => {
    const w = {
      protocolMajor: 1,
      protocolMinor: 3,
      engine: 'premation-engine',
      engineVersion: '0.2.0',
      revision: 12345678901,
      sessionId: 's1',
      capabilities: ['a', 'b'],
    };
    const bytes = encodeEngineMessage({ kind: 'welcome', value: w });
    expect(decodeWelcome(peekEnvelope(bytes)!.body)).toEqual(w);
  });

  it('peeks seq and revisions', () => {
    const req = requestBytes(2 ** 40, { kind: 'command', value: { type: 'undo' } });
    expect(peekEnvelope(req)).toMatchObject({ kind: 'request', seq: 2 ** 40 });
    const res = encodeEngineMessage({
      kind: 'response',
      value: { seq: 77, revision: 9, outcome: { kind: 'error', value: { code: 'notFound', message: 'x' } } },
    });
    expect(peekEnvelope(res)).toMatchObject({ kind: 'response', seq: 77, revision: 9 });
    const ev = encodeEngineMessage({ kind: 'events', value: { fromRevision: 4, toRevision: 5, events: [], causedBy: 3 } });
    expect(peekEnvelope(ev)).toMatchObject({ kind: 'events', fromRevision: 4, revision: 5, seq: 3 });
    expect(peekEnvelope(Uint8Array.from([0xff, 0xff]))).toBeNull();
  });

  it('reassembles frames from any chunking and refuses an oversize length', () => {
    const payloads = [new Uint8Array(0), Uint8Array.from([1]), new Uint8Array(300).fill(7)];
    const stream = Buffer.concat(payloads.map((p) => Buffer.from(frame(p))));
    for (const size of [1, 2, 3, 5, 64, stream.length]) {
      const d = new FrameDecoder();
      const got: Uint8Array[] = [];
      for (let i = 0; i < stream.length; i += size) got.push(...d.push(stream.subarray(i, i + size)));
      expect(got.map((g) => Buffer.from(g))).toEqual(payloads.map((p) => Buffer.from(p)));
    }
    const d = new FrameDecoder(10);
    expect(d.push(Uint8Array.from([11, 0, 0, 0]))).toEqual([]);
    expect(d.error).toBe(true);
  });

  it('frame channel: the electron copy of the generated codec emits the schema codec\'s bytes', () => {
    const msgs: FrameChannelMessage[] = [
      { type: 'frameReady', generation: 3, slot: 1, viewport: 1, dropped: 4, frame: 90, time: 3 * FLICKS, revision: 17, renderStartUs: 1.5, renderDoneUs: 2.5, width: 1920, height: 1080 },
      { type: 'slots', generation: 2, viewport: 1, width: 640, height: 360, format: 'rgba8unorm', shared: true, handles: [0x1a4, 0x1b8, 0x2000] },
      { type: 'pong', nonce: 2 ** 40, revision: 9, playing: true, queued: 3 },
      { type: 'release', generation: 7, slot: 2 },
      { type: 'ping', nonce: 0xdeadbeef },
    ];
    for (const m of msgs) {
      const mine = encodeFrameMessage(m);
      expect(Buffer.from(mine).toString('hex')).toBe(Buffer.from(codecs.FrameChannelMessage.encode(m)).toString('hex'));
    }
    expect(Buffer.from(encodeRelease(7, 2))).toEqual(Buffer.from(encodeFrameMessage(msgs[3]!)));
    expect(Buffer.from(encodePing(0xdeadbeef))).toEqual(Buffer.from(encodeFrameMessage(msgs[4]!)));
    // Engine → host decodes; host → engine types and malformed input are null.
    const ready = encodeFrameMessage(msgs[0]!);
    expect(decodeFrameMessage(ready)).toEqual(msgs[0]);
    expect(decodeFrameMessage(encodeFrameMessage(msgs[1]!))).toEqual(msgs[1]);
    expect(decodeFrameMessage(encodeRelease(1, 1))).toBeNull();
    for (let n = 0; n < ready.length; n++) expect(decodeFrameMessage(ready.subarray(0, n))).toBeNull();
    const tooMany = encodeFrameMessage({ ...(msgs[1] as Extract<FrameChannelMessage, { type: 'slots' }>), handles: new Array(17).fill(4) });
    expect(decodeFrameMessage(tooMany)).toBeNull();
    // An unknown variant (a newer engine) is skipped, not an error that kills the channel.
    expect(decodeFrameMessage(Uint8Array.from([0xfa, 0x01, 0x00]))).toBeNull();
  });
});

describe('EngineTransport — in-memory streams', () => {
  function pair() {
    const commandIn = new PassThrough();
    const commandOut = new PassThrough();
    const framesOut = new PassThrough();
    const framesIn = new PassThrough();
    const events: number[] = [];
    let closedWhy = '';
    const t = new EngineTransport(
      { commandIn, commandOut, framesOut, framesIn },
      { events: (b) => events.push(b.toRevision), closed: (w) => (closedWhy = w) },
    );
    const engineReads = new FrameDecoder();
    const received: EngineMessage[] = [];
    commandIn.on('data', (c: Buffer) => {
      for (const m of engineReads.push(c)) received.push(decodeEngineMessage(m));
    });
    const reply = (m: EngineMessage) => commandOut.write(frame(encodeEngineMessage(m)));
    return { t, commandOut, framesIn, received, reply, events, closed: () => closedWhy };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('handshakes, correlates out-of-order responses, fans out events', async () => {
    const { t, received, reply, events } = pair();
    const hs = t.handshake({ client: 'test', clientVersion: '1', capabilities: [] });
    await tick();
    expect(received[0]!.kind).toBe('hello');
    reply({ kind: 'welcome', value: { protocolMajor: 1, protocolMinor: 0, engine: 'e', engineVersion: 'v', revision: 0, sessionId: 's', capabilities: [] } });
    await expect(hs).resolves.toMatchObject({ engine: 'e' });

    const a = t.request(requestBytes(1, { kind: 'command', value: { type: 'undo' } }));
    const b = t.request(requestBytes(2, { kind: 'command', value: { type: 'redo' } }));
    await expect(t.request(requestBytes(2, { kind: 'command', value: { type: 'redo' } }))).rejects.toThrow(/in flight/);
    reply({ kind: 'events', value: { fromRevision: 0, toRevision: 1, events: [], causedBy: 2 } });
    reply({ kind: 'response', value: { seq: 2, revision: 1, outcome: { kind: 'error', value: { code: 'nothingToRedo', message: '' } } } });
    reply({ kind: 'response', value: { seq: 1, revision: 1, outcome: { kind: 'error', value: { code: 'nothingToUndo', message: '' } } } });
    const rb = decodeEngineMessage(await b);
    const ra = decodeEngineMessage(await a);
    expect((rb.value as Response).seq).toBe(2);
    expect((ra.value as Response).seq).toBe(1);
    expect(events).toEqual([1]);
  });

  it('rejects everything pending when the engine goes away', async () => {
    const { t, commandOut, closed } = pair();
    const p = t.request(requestBytes(5, { kind: 'command', value: { type: 'undo' } }));
    commandOut.end();
    await expect(p).rejects.toBeInstanceOf(EngineGoneError);
    expect(closed()).toMatch(/closed its output/);
    await expect(t.request(requestBytes(6, { kind: 'command', value: { type: 'undo' } }))).rejects.toBeInstanceOf(EngineGoneError);
  });

  it('a frame above the maximum closes the connection', async () => {
    const { t, commandOut } = pair();
    const p = t.request(requestBytes(1, { kind: 'command', value: { type: 'undo' } }));
    commandOut.write(Buffer.from([0xff, 0xff, 0xff, 0x7f]));
    await expect(p).rejects.toThrow(/maximum/);
  });

  it('times a request out without killing the connection', async () => {
    const { t } = pair();
    await expect(t.request(requestBytes(1, { kind: 'command', value: { type: 'undo' } }), 20)).rejects.toThrow(/no response/);
    expect(t.closed).toBe(false);
  });
});

// ── the real engine ─────────────────────────────────────────────────────────

const exe = path.join(
  __dirname,
  '..',
  'native',
  'build',
  process.platform === 'win32' ? 'windows-clang-cl-engine' : process.platform === 'darwin' ? 'macos-clang-engine' : 'linux-clang-engine',
  'engine',
  process.platform === 'win32' ? 'premation-engine.exe' : 'premation-engine',
);
const describeEngine = existsSync(exe) ? describe : describe.skip;

describeEngine('premation-engine — scripted session over the real pipes', () => {
  jest.setTimeout(60_000);

  function pct(xs: number[], p: number): number {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
  }

  it.each([['gpu'], ['no-gpu']])('handshake → createLayer → 3 keys → play → seek → undo → layer tree (%s)', async (mode) => {
    const child = spawn(exe, mode === 'gpu' ? [] : ['--no-gpu'], { stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'], windowsHide: true });
    const logs: string[] = [];
    child.stderr!.on('data', (d: Buffer) => logs.push(d.toString()));
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
    const frames: Array<FrameReadyMessage & { at: number }> = [];
    let frameWaiter: ((f: FrameReadyMessage) => boolean) | null = null;
    let frameResolve: (() => void) | null = null;
    const transport = new EngineTransport(
      {
        commandIn: child.stdin!,
        commandOut: child.stdout!,
        framesOut: child.stdio[3] as Readable,
        framesIn: child.stdio[4] as Writable,
      },
      {
        frame: (m) => {
          if (m.type !== 'frameReady') return;
          frames.push({ ...m, at: performance.now() });
          transport.releaseSlot(m.generation, m.slot);  // a host that samples instantly
          if (frameWaiter?.(m)) {
            frameWaiter = null;
            frameResolve?.();
          }
        },
      },
    );
    const waitFrame = (pred: (f: FrameReadyMessage) => boolean) =>
      new Promise<void>((resolve) => {
        frameWaiter = pred;
        frameResolve = resolve;
      });

    let seq = 0;
    const run = async (cmd: Command): Promise<Response> =>
      decodeEngineMessage(await transport.request(requestBytes(++seq, { kind: 'command', value: cmd }))).value as Response;
    const ask = async (q: Query): Promise<Response> =>
      decodeEngineMessage(await transport.request(requestBytes(++seq, { kind: 'query', value: q }))).value as Response;
    const ok = (r: Response) => {
      if (r.outcome.kind === 'error') throw new Error(`${r.outcome.value.code}: ${r.outcome.value.message}\n${logs.join('')}`);
      return r.outcome.value as unknown as Record<string, unknown>;
    };

    const welcome = await transport.handshake({ client: 'jest', clientVersion: '0', capabilities: [] });
    expect(welcome.engine).toBe('premation-engine');

    const comp = ok(await run({ type: 'createComposition', settings: { width: 1920, height: 1080, frameRate: { num: 60, den: 1 }, duration: 10 * FLICKS }, fromItems: [] })).item as string;
    // A new project's active composition is its 30 fps `comp_root`; play this 60 fps one.
    ok(await run({ type: 'setActiveComposition', comp }));
    const layer = ok(
      // The document's default solid: `layer/size` was the N-stage scaffold's
      // path, never a property of the real document (either engine).
      await run({ type: 'createLayer', comp, kind: 'solid', init: [] }),
    ).layer as string;
    for (const [t, x] of [[0, 200], [1, 1700], [2, 960]] as const) {
      ok(await run({ type: 'addKeyframes', keys: [{ prop: { layer, path: 'transform/position' }, time: t * FLICKS, value: { kind: 'vec2', value: { x, y: 540 } }, spatialIn: [], spatialOut: [] }] }));
    }
    ok(await run({ type: 'setViewport', viewport: 1, width: 1920, height: 1080, devicePixelRatio: 1, zoom: 1, pan: { x: 0, y: 0 }, channel: 'rgb', exposure: 0, transparencyGrid: false, displayTransform: '', layerRenderEffects: false }));
    if (frames.length === 0) await waitFrame(() => true);  // the viewport's first frame may beat the response

    // Play: 30 frames through the slots.
    const startCount = frames.length;
    const got30 = waitFrame(() => frames.length - startCount >= 30);
    ok(await run({ type: 'play', rate: 1, range: 'all', audio: false, cacheFirst: false }));
    await got30;
    const played = frames.slice(startCount);
    const fps = (played.length - 1) / ((played[played.length - 1]!.at - played[0]!.at) / 1000);
    expect(played.map((f) => f.frame)).toEqual([...played.map((f) => f.frame)].sort((a, b) => a - b));

    // setProperty round trips DURING playback, and how long until a frame shows the edit.
    const rtt: number[] = [];
    const toFrame: number[] = [];
    for (let i = 0; i < 40; i++) {
      const t0 = performance.now();
      const res = await run({ type: 'setProperty', prop: { layer, path: 'transform/rotation' }, value: { kind: 'scalar', value: i + 1 } });
      ok(res);
      rtt.push(performance.now() - t0);
      if (!frames.some((f) => f.revision >= res.revision && f.at >= t0)) {
        await waitFrame((f) => f.revision >= res.revision);
      }
      toFrame.push(performance.now() - t0);
    }

    // Seek, undo, and the layer tree.
    ok(await run({ type: 'pause', returnToStart: false }));
    const seekShown = waitFrame((f) => f.time === 2 * FLICKS);
    ok(await run({ type: 'seek', time: 2 * FLICKS, mode: 'exact' }));
    await seekShown;
    const undo = await run({ type: 'undo' });
    expect(undo.outcome.kind).toBe('command');
    const tree = ok(await ask({ type: 'getComposition', comp }));
    expect((tree.layers as Array<{ id: string }>).map((l) => l.id)).toEqual([layer]);
    const values = ok(await ask({ type: 'getPropertyValues', props: [{ layer, path: 'transform/position' }], time: FLICKS / 2, evaluated: true }));
    expect((values.values as Array<{ value: { value: { x: number } } }>)[0]!.value.value.x).toBeCloseTo(950, 6);

    transport.goodbye();
    expect(await exited).toBe(0);

    console.log(
      `[C2 ${mode}] play fps ${fps.toFixed(1)} (comp 60) · setProperty during play RTT p50 ${pct(rtt, 50).toFixed(2)} ms p95 ${pct(rtt, 95).toFixed(2)} ms` +
        ` · request→frame showing it p50 ${pct(toFrame, 50).toFixed(1)} ms p95 ${pct(toFrame, 95).toFixed(1)} ms · frames ${frames.length}`,
    );
    expect(fps).toBeGreaterThan(40);
  });
});
