/**
 * EngineTransport — Electron main's end of one `premation-engine` process.
 *
 *   commandIn   child stdin     framed EngineMessages, main → engine
 *   commandOut  child stdout    framed EngineMessages, engine → main
 *   framesOut   child fd 3      frame channel, engine → main (Slots, FrameReady, Pong)
 *   framesIn    child fd 4      frame channel, main → engine (Release, Ping)
 *
 * It does framing, the Hello/Welcome handshake, request/response correlation
 * by `seq`, and fan-out of event batches and frame-channel messages. Payloads
 * stay ENCODED: main relays bytes to the renderer's EngineClient (C3), which
 * owns the generated codec — main never pays to decode a document.
 *
 * Failure is contained here: an engine that dies, closes a pipe, sends a
 * frame longer than the maximum or answers garbage makes `closed` resolve
 * and every pending request reject with `EngineGoneError`. It never throws
 * into the caller's event loop.
 */

import type { Readable, Writable } from 'node:stream';
import {
  FrameDecoder,
  MAX_FRAME_CHANNEL_PAYLOAD,
  PROTOCOL_MAJOR,
  decodeFrameMessage,
  decodeGoodbye,
  decodeWelcome,
  encodeGoodbye,
  encodeHello,
  encodePing,
  encodeRelease,
  frame,
  peekEnvelope,
  type EngineFrameMessage,
  type GoodbyeReason,
  type HelloInfo,
  type WelcomeInfo,
} from './engineFraming';

export interface EngineStreams {
  commandIn: Writable;
  commandOut: Readable;
  framesOut: Readable | null;
  framesIn: Writable | null;
}

/** A request could not complete because the engine went away (crash, restart, shutdown). */
export class EngineGoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineGoneError';
  }
}

/** The engine refused the session (version mismatch) or closed it. */
export class EngineGoodbyeError extends Error {
  constructor(
    readonly reason: GoodbyeReason,
    message: string,
  ) {
    super(message);
    this.name = 'EngineGoodbyeError';
  }
}

export interface EventBatchBytes {
  /** The encoded EngineMessage{events}, ready to relay. */
  bytes: Uint8Array;
  fromRevision: number;
  toRevision: number;
  causedBy?: number;
}

export interface TransportListeners {
  events?: (batch: EventBatchBytes) => void;
  frame?: (msg: EngineFrameMessage) => void;
  goodbye?: (reason: GoodbyeReason, message: string) => void;
  /** The connection is over (any cause). Called once. */
  closed?: (why: string) => void;
}

interface Pending {
  resolve: (bytes: Uint8Array) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export class EngineTransport {
  private readonly decoder = new FrameDecoder();
  private readonly frameDecoder = new FrameDecoder(MAX_FRAME_CHANNEL_PAYLOAD);
  private readonly pending = new Map<number, Pending>();
  private welcomeWaiter: { resolve: (w: WelcomeInfo) => void; reject: (e: Error) => void } | null = null;
  private isClosed = false;
  private welcome: WelcomeInfo | null = null;

  constructor(
    private readonly streams: EngineStreams,
    private readonly listeners: TransportListeners = {},
    private readonly requestTimeoutMs = 30_000,
  ) {
    streams.commandOut.on('data', (chunk: Buffer) => this.onCommandData(chunk));
    streams.commandOut.on('end', () => this.close('engine closed its output'));
    streams.commandOut.on('error', (e: Error) => this.close(`engine output error: ${e.message}`));
    streams.commandIn.on('error', (e: Error) => this.close(`engine input error: ${e.message}`));
    if (streams.framesOut) {
      streams.framesOut.on('data', (chunk: Buffer) => this.onFrameData(chunk));
      streams.framesOut.on('error', () => undefined);  // the command pipe decides liveness
    }
    streams.framesIn?.on('error', () => undefined);
  }

  get closed(): boolean {
    return this.isClosed;
  }

  get session(): WelcomeInfo | null {
    return this.welcome;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Send Hello and wait for Welcome (or Goodbye → EngineGoodbyeError). `timeoutMs` 0 = no timer (the caller owns it). */
  handshake(hello: HelloInfo, timeoutMs = 10_000): Promise<WelcomeInfo> {
    if (this.isClosed) return Promise.reject(new EngineGoneError('engine connection is closed'));
    return new Promise<WelcomeInfo>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.welcomeWaiter = null;
              reject(new EngineGoneError(`no Welcome within ${timeoutMs} ms`));
            }, timeoutMs)
          : null;
      this.welcomeWaiter = {
        resolve: (w) => {
          if (timer) clearTimeout(timer);
          if (w.protocolMajor !== PROTOCOL_MAJOR) {
            reject(new EngineGoodbyeError('versionMismatch', `engine speaks protocol ${w.protocolMajor}.${w.protocolMinor}`));
            return;
          }
          this.welcome = w;
          resolve(w);
        },
        reject: (e) => {
          if (timer) clearTimeout(timer);
          reject(e);
        },
      };
      this.write(encodeHello(hello));
    });
  }

  /**
   * Send an encoded EngineMessage{request} and resolve with the encoded
   * EngineMessage{response} carrying the same seq. Seq is the caller's
   * (EngineClientBase numbers them); a duplicate in-flight seq is refused.
   */
  request(message: Uint8Array, timeoutMs = this.requestTimeoutMs): Promise<Uint8Array> {
    if (this.isClosed) return Promise.reject(new EngineGoneError('engine connection is closed'));
    const peek = peekEnvelope(message);
    if (!peek || peek.kind !== 'request' || peek.seq === undefined) {
      return Promise.reject(new TypeError('not an encoded EngineMessage{request}'));
    }
    const seq = peek.seq;
    if (this.pending.has(seq)) return Promise.reject(new TypeError(`request seq ${seq} is already in flight`));
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(seq);
              reject(new EngineGoneError(`request ${seq} got no response within ${timeoutMs} ms`));
            }, timeoutMs)
          : null;
      this.pending.set(seq, { resolve, reject, timer });
      this.write(message);
    });
  }

  /** Frame channel: the host (Chromium) is done with a slot. */
  releaseSlot(generation: number, slot: number): void {
    this.writeFrames(encodeRelease(generation, slot));
  }

  ping(nonce: number): void {
    this.writeFrames(encodePing(nonce));
  }

  /** Say goodbye (normal) and stop; the engine exits by itself. */
  goodbye(message = 'host shutting down'): void {
    if (this.isClosed) return;
    this.write(encodeGoodbye('normal', message));
    this.streams.commandIn.end();
    this.close('goodbye sent');
  }

  /** Tear the connection down: reject everything pending. Idempotent. */
  close(why: string): void {
    if (this.isClosed) return;
    this.isClosed = true;
    const err = new EngineGoneError(why);
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.welcomeWaiter?.reject(err);
    this.welcomeWaiter = null;
    this.listeners.closed?.(why);
  }

  private write(message: Uint8Array): void {
    if (this.isClosed) return;
    try {
      this.streams.commandIn.write(frame(message));
    } catch (e) {
      this.close(`write failed: ${(e as Error).message}`);
    }
  }

  private writeFrames(payload: Uint8Array): void {
    if (this.isClosed || !this.streams.framesIn || this.streams.framesIn.destroyed) return;
    try {
      this.streams.framesIn.write(frame(payload));
    } catch {
      /* the command pipe decides liveness */
    }
  }

  private onCommandData(chunk: Uint8Array): void {
    const frames = this.decoder.push(chunk);
    if (this.decoder.error) {
      this.close('engine sent a frame above the maximum length');
      return;
    }
    for (const msg of frames) this.onMessage(msg);
  }

  private onMessage(msg: Uint8Array): void {
    const peek = peekEnvelope(msg);
    if (!peek) return;  // undecodable envelope from the engine: ignore (the engine's fuzz suite guards this)
    switch (peek.kind) {
      case 'welcome': {
        const w = decodeWelcome(peek.body);
        if (w) this.welcomeWaiter?.resolve(w);
        this.welcomeWaiter = null;
        return;
      }
      case 'response': {
        const p = this.pending.get(peek.seq ?? -1);
        if (!p) return;  // timed out already, or not ours
        this.pending.delete(peek.seq!);
        if (p.timer) clearTimeout(p.timer);
        p.resolve(msg);
        return;
      }
      case 'events':
        this.listeners.events?.({
          bytes: msg,
          fromRevision: peek.fromRevision ?? 0,
          toRevision: peek.revision ?? 0,
          ...(peek.seq !== undefined ? { causedBy: peek.seq } : {}),
        });
        return;
      case 'goodbye': {
        const g = decodeGoodbye(peek.body) ?? { reason: 'protocolError' as const, message: '' };
        this.listeners.goodbye?.(g.reason, g.message);
        this.welcomeWaiter?.reject(new EngineGoodbyeError(g.reason, g.message || g.reason));
        this.welcomeWaiter = null;
        this.close(`engine said goodbye: ${g.reason}${g.message ? ` (${g.message})` : ''}`);
        return;
      }
      default:
        return;
    }
  }

  private onFrameData(chunk: Uint8Array): void {
    const frames = this.frameDecoder.push(chunk);
    for (const p of frames) {
      const m = decodeFrameMessage(p);
      if (m) this.listeners.frame?.(m);
    }
  }
}
