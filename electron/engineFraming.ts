/**
 * Byte-level helpers for talking to `premation-engine` from Electron main.
 *
 * Main is a RELAY: it never decodes a whole engine message (the renderer's
 * EngineClient does that with the generated codec in packages/engine-api).
 * It only needs to
 *   - cut the stdout byte stream into frames (4-byte LE length + payload,
 *     schema 10_envelope.eapi / native/protocol/include/premation/protocol/framing.hpp),
 *   - peek an envelope's kind and `seq` to correlate responses with requests,
 *     and `fromRevision`/`toRevision` of event batches,
 *   - build the Hello / Goodbye it sends itself and read the Welcome / Goodbye,
 *   - speak the frame channel (fd 3 / fd 4) — schema family "FrameChannel",
 *     through the generated standalone codec in ./generated/frameChannel.ts.
 *
 * Why not import @motion/engine-api: electron/ is its own TypeScript project
 * (rootDir `.`, CommonJS) and cannot import packages/. The encoding is the
 * canonical protobuf wire format, so peeking a varint field is a dozen lines;
 * `engineTransport.test.ts` pins these helpers byte-for-byte against the
 * generated codec, so they cannot drift silently.
 */

import { codecs as frameCodecs, type FrameChannelMessage } from './generated/frameChannel';

/** Protocol major this build of the UI speaks (schema `version 1.0`). Pinned by a test against the generated meta. */
export const PROTOCOL_MAJOR = 1;
export const PROTOCOL_MINOR = 0;

/** Largest command-pipe frame accepted (framing.hpp kDefaultMaxFrame). */
export const MAX_FRAME = 64 * 1024 * 1024;
/** Largest frame-channel payload (framing.hpp kMaxFramePayload). */
export const MAX_FRAME_CHANNEL_PAYLOAD = 4096;

// ── framing ──────────────────────────────────────────────────────────────────

/** Prefix `payload` with its 4-byte little-endian length. */
export function frame(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length + 4);
  new DataView(out.buffer).setUint32(0, payload.length, true);
  out.set(payload, 4);
  return out;
}

/** Reassembles frames from arbitrary chunks. An oversize length is unrecoverable. */
export class FrameDecoder {
  private buf = new Uint8Array(0);
  private len = 0;
  private failed = false;

  constructor(private readonly max = MAX_FRAME) {}

  get error(): boolean {
    return this.failed;
  }

  /** Feed a chunk; returns the complete payloads it finished (copies, safe to keep). */
  push(chunk: Uint8Array): Uint8Array[] {
    if (this.failed) return [];
    if (this.len + chunk.length > this.buf.length) {
      const next = new Uint8Array(Math.max(this.buf.length * 2, this.len + chunk.length, 4096));
      next.set(this.buf.subarray(0, this.len));
      this.buf = next;
    }
    this.buf.set(chunk, this.len);
    this.len += chunk.length;
    const out: Uint8Array[] = [];
    let at = 0;
    while (this.len - at >= 4) {
      const n = new DataView(this.buf.buffer, this.buf.byteOffset + at, 4).getUint32(0, true);
      if (n > this.max) {
        this.failed = true;
        return out;
      }
      if (this.len - at - 4 < n) break;
      out.push(this.buf.slice(at + 4, at + 4 + n));
      at += 4 + n;
    }
    if (at > 0) {
      this.buf.copyWithin(0, at, this.len);
      this.len -= at;
    }
    return out;
  }

  /** Bytes held that do not yet form a frame. */
  get pending(): number {
    return this.len;
  }
}

// ── protobuf wire, the minimum main needs ────────────────────────────────────

const WT_VARINT = 0;
const WT_FIXED64 = 1;
const WT_LEN = 2;
const WT_FIXED32 = 5;

interface Field {
  field: number;
  wire: number;
  /** varint value (exact up to 2^53) */
  num: number;
  /** length-delimited body */
  body: Uint8Array | null;
}

function readVarint(b: Uint8Array, pos: number): [number, number] | null {
  let result = 0;
  let mul = 1;
  for (let i = 0; i < 10; i++) {
    if (pos >= b.length) return null;
    const byte = b[pos++]!;
    result += (byte & 0x7f) * mul;
    if (byte < 0x80) return [result, pos];
    mul *= 128;
  }
  return null;
}

/** The top-level fields of a message; null when malformed. */
function fields(b: Uint8Array): Field[] | null {
  const out: Field[] = [];
  let pos = 0;
  while (pos < b.length) {
    const k = readVarint(b, pos);
    if (!k) return null;
    pos = k[1];
    const field = Math.floor(k[0] / 8);
    const wire = k[0] % 8;
    if (wire === WT_VARINT) {
      const v = readVarint(b, pos);
      if (!v) return null;
      out.push({ field, wire, num: v[0], body: null });
      pos = v[1];
    } else if (wire === WT_LEN) {
      const l = readVarint(b, pos);
      if (!l) return null;
      pos = l[1];
      if (pos + l[0] > b.length) return null;
      out.push({ field, wire, num: 0, body: b.subarray(pos, pos + l[0]) });
      pos += l[0];
    } else if (wire === WT_FIXED64) {
      if (pos + 8 > b.length) return null;
      pos += 8;
    } else if (wire === WT_FIXED32) {
      if (pos + 4 > b.length) return null;
      pos += 4;
    } else {
      return null;
    }
  }
  return out;
}

class ProtoWriter {
  private bytes: number[] = [];
  varint(v: number): this {
    let x = v;
    while (x >= 0x80) {
      this.bytes.push((x % 128) | 0x80);
      x = Math.floor(x / 128);
    }
    this.bytes.push(x);
    return this;
  }
  key(field: number, wire: number): this {
    return this.varint(field * 8 + wire);
  }
  u32(field: number, v: number): this {
    return this.key(field, WT_VARINT).varint(v);
  }
  bytesField(field: number, body: Uint8Array): this {
    this.key(field, WT_LEN).varint(body.length);
    for (const x of body) this.bytes.push(x);
    return this;
  }
  str(field: number, s: string): this {
    return this.bytesField(field, new TextEncoder().encode(s));
  }
  done(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

const text = new TextDecoder();

// ── envelope ─────────────────────────────────────────────────────────────────

/** EngineMessage union field numbers (schema 10_envelope.eapi). */
export type EnvelopeKind = 'hello' | 'welcome' | 'request' | 'response' | 'events' | 'goodbye';
const KINDS: Record<number, EnvelopeKind> = { 1: 'hello', 2: 'welcome', 3: 'request', 4: 'response', 5: 'events', 6: 'goodbye' };

export interface EnvelopePeek {
  kind: EnvelopeKind;
  /** Request/Response seq; EventBatch causedBy when present. */
  seq?: number;
  /** Response revision / EventBatch toRevision. */
  revision?: number;
  fromRevision?: number;
  body: Uint8Array;
}

/** Kind + correlation fields of an encoded EngineMessage, without decoding it. Null when malformed. */
export function peekEnvelope(msg: Uint8Array): EnvelopePeek | null {
  const top = fields(msg);
  if (!top || top.length !== 1 || !top[0]!.body) return null;
  const kind = KINDS[top[0]!.field];
  if (!kind) return null;
  const body = top[0]!.body;
  const inner = fields(body);
  if (!inner) return null;
  const num = (f: number) => inner.find((x) => x.field === f && x.wire === WT_VARINT)?.num;
  const peek: EnvelopePeek = { kind, body };
  if (kind === 'request' || kind === 'response') {
    peek.seq = num(1) ?? 0;
    if (kind === 'response') peek.revision = num(2) ?? 0;
  } else if (kind === 'events') {
    peek.fromRevision = num(1) ?? 0;
    peek.revision = num(2) ?? 0;
    const caused = num(4);
    if (caused !== undefined) peek.seq = caused;
  }
  return peek;
}

export interface HelloInfo {
  client: string;
  clientVersion: string;
  capabilities: string[];
  protocolMajor?: number;
  protocolMinor?: number;
}

/** EngineMessage{hello: Hello}, canonical (field order, required fields always written). */
export function encodeHello(h: HelloInfo): Uint8Array {
  const body = new ProtoWriter()
    .u32(1, h.protocolMajor ?? PROTOCOL_MAJOR)
    .u32(2, h.protocolMinor ?? PROTOCOL_MINOR)
    .str(3, h.client)
    .str(4, h.clientVersion);
  for (const c of h.capabilities) body.str(5, c);
  return new ProtoWriter().bytesField(1, body.done()).done();
}

export type GoodbyeReason = 'normal' | 'versionMismatch' | 'engineShutdown' | 'protocolError';
const GOODBYE_REASONS: GoodbyeReason[] = ['normal', 'versionMismatch', 'engineShutdown', 'protocolError'];

/** EngineMessage{goodbye: Goodbye}. */
export function encodeGoodbye(reason: GoodbyeReason, message: string): Uint8Array {
  const body = new ProtoWriter().u32(1, GOODBYE_REASONS.indexOf(reason)).str(2, message).done();
  return new ProtoWriter().bytesField(6, body).done();
}

export interface WelcomeInfo {
  protocolMajor: number;
  protocolMinor: number;
  engine: string;
  engineVersion: string;
  revision: number;
  sessionId: string;
  capabilities: string[];
}

export function decodeWelcome(body: Uint8Array): WelcomeInfo | null {
  const f = fields(body);
  if (!f) return null;
  const w: WelcomeInfo = { protocolMajor: 0, protocolMinor: 0, engine: '', engineVersion: '', revision: 0, sessionId: '', capabilities: [] };
  for (const x of f) {
    if (x.wire === WT_VARINT) {
      if (x.field === 1) w.protocolMajor = x.num;
      else if (x.field === 2) w.protocolMinor = x.num;
      else if (x.field === 5) w.revision = x.num;
    } else if (x.body) {
      const s = text.decode(x.body);
      if (x.field === 3) w.engine = s;
      else if (x.field === 4) w.engineVersion = s;
      else if (x.field === 6) w.sessionId = s;
      else if (x.field === 7) w.capabilities.push(s);
    }
  }
  return w;
}

export function decodeGoodbye(body: Uint8Array): { reason: GoodbyeReason; message: string } | null {
  const f = fields(body);
  if (!f) return null;
  let reason: GoodbyeReason = 'normal';
  let message = '';
  for (const x of f) {
    if (x.field === 1 && x.wire === WT_VARINT) reason = GOODBYE_REASONS[x.num] ?? 'protocolError';
    if (x.field === 2 && x.body) message = text.decode(x.body);
  }
  return { reason, message };
}

// ── frame channel (fd 3 engine → host, fd 4 host → engine) ───────────────────
//
// The messages are schema types (packages/engine-api/schema/95_frames.eapi,
// family "FrameChannel"); electron/generated/frameChannel.ts is their generated
// standalone codec — the C++ side uses the same generated structs
// (premation::api::FrameChannelMessage). Nothing here is hand-encoded.

export type SlotsMessage = Extract<FrameChannelMessage, { type: 'slots' }>;
export type FrameReadyMessage = Extract<FrameChannelMessage, { type: 'frameReady' }>;
export type PongMessage = Extract<FrameChannelMessage, { type: 'pong' }>;
/** What the engine sends on fd 3. Slot handles are NT handles valid in THIS process; the engine owns their lifetime — never close them. */
export type EngineFrameMessage = SlotsMessage | FrameReadyMessage | PongMessage;

/** Most slots a ring may announce (FrameSlots.handles). */
export const MAX_FRAME_SLOTS = 16;

/** Decode an engine → host frame-channel payload; null for host → engine types, unknown variants or malformed input. */
export function decodeFrameMessage(p: Uint8Array): EngineFrameMessage | null {
  let m: FrameChannelMessage;
  try {
    m = frameCodecs.FrameChannelMessage.decode(p);
  } catch {
    return null;
  }
  switch (m.type) {
    case 'slots':
      return m.handles.length <= MAX_FRAME_SLOTS ? m : null;
    case 'frameReady':
    case 'pong':
      return m;
    default:
      return null;
  }
}

export function encodeRelease(generation: number, slot: number): Uint8Array {
  return frameCodecs.FrameChannelMessage.encode({ type: 'release', generation, slot });
}

export function encodePing(nonce: number): Uint8Array {
  return frameCodecs.FrameChannelMessage.encode({ type: 'ping', nonce });
}

/** Encode any frame-channel message (tests and fakes play the engine side with it). */
export function encodeFrameMessage(m: FrameChannelMessage): Uint8Array {
  return frameCodecs.FrameChannelMessage.encode(m);
}
