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
export type EnvelopeKind = 'hello' | 'welcome' | 'request' | 'response' | 'events' | 'goodbye' | 'logRecord';
const KINDS: Record<number, EnvelopeKind> = {
  1: 'hello', 2: 'welcome', 3: 'request', 4: 'response', 5: 'events', 6: 'goodbye', 1006: 'logRecord',
};

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

function lenField(body: Uint8Array, field: number): Uint8Array | null {
  const inner = fields(body);
  if (!inner) return null;
  const found = inner.find((x) => x.field === field && x.body);
  return found?.body ?? null;
}

/** Job id in a startJob response (CommandResult field 850 → JobRef.job). */
export function startJobIdFromResponse(response: Uint8Array): string | null {
  const peek = peekEnvelope(response);
  if (!peek || peek.kind !== 'response') return null;
  const outcome = lenField(peek.body, 3);
  const result = outcome ? lenField(outcome, 1) : null;
  const jobRef = result ? lenField(result, 850) : null;
  const job = jobRef ? lenField(jobRef, 1) : null;
  if (!job || job.length === 0) return null;
  return text.decode(job);
}

export interface AppliedJobEdit {
  /** Encoded EngineMessage{request} of the batch the job applied. */
  bytes: Uint8Array;
  revisionAfter: number;
  /** LogRecord.job — which startJob this edit replaces. */
  job?: string;
}

/**
 * EngineMessage{logRecord} → the request it carries, wrapped as
 * EngineMessage{request}, plus the revision and job id. Null when the
 * message is not a log record or has no request.
 */
export function appliedRequestFromLogRecord(msg: Uint8Array): AppliedJobEdit | null {
  const peek = peekEnvelope(msg);
  if (!peek || peek.kind !== 'logRecord') return null;
  const request = lenField(peek.body, 1);
  const inner = fields(peek.body);
  const rev = inner?.find((x) => x.field === 2 && x.wire === WT_VARINT);
  if (!request || !rev) return null;
  const w = new ProtoWriter();
  w.bytesField(3, request);
  const jobBody = lenField(peek.body, 4);
  const job = jobBody && jobBody.length > 0 ? text.decode(jobBody) : undefined;
  return { bytes: w.done(), revisionAfter: rev.num, ...(job ? { job } : {}) };
}

// ── F2: main as the ONE client of the engine (command log, several windows) ──
//
// With the command log in main (engineCommandLog.ts) and pop-out windows as
// second mirrors, main owns the engine connection's `seq` space: each window
// numbers its own requests, so main renumbers them on the way in and back on
// the way out, and maps an event batch's `causedBy` back for the window that
// caused it. Only envelope fields are touched; bodies are copied as bytes.

interface RawField {
  field: number;
  wire: number;
  num: number;
  /** The field's bytes, key included. */
  raw: Uint8Array;
  body: Uint8Array | null;
}

/** The top-level fields with their raw bytes; null when malformed. */
function rawFields(b: Uint8Array): RawField[] | null {
  const out: RawField[] = [];
  let pos = 0;
  while (pos < b.length) {
    const start = pos;
    const k = readVarint(b, pos);
    if (!k) return null;
    pos = k[1];
    const field = Math.floor(k[0] / 8);
    const wire = k[0] % 8;
    let num = 0;
    let body: Uint8Array | null = null;
    if (wire === WT_VARINT) {
      const v = readVarint(b, pos);
      if (!v) return null;
      num = v[0];
      pos = v[1];
    } else if (wire === WT_LEN) {
      const l = readVarint(b, pos);
      if (!l) return null;
      pos = l[1];
      if (pos + l[0] > b.length) return null;
      body = b.subarray(pos, pos + l[0]);
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
    out.push({ field, wire, num, raw: b.subarray(start, pos), body });
  }
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * The same EngineMessage with inner varint field `field` of its (only) variant
 * set to `value` — or removed when `value` is null. Canonical order is kept: the
 * field goes where the encoder would put it (fields are written in number order).
 * Null when `msg` is not an envelope.
 */
function withInnerVarint(msg: Uint8Array, field: number, value: number | null): Uint8Array | null {
  const top = rawFields(msg);
  if (!top || top.length !== 1 || !top[0]!.body) return null;
  const variant = top[0]!.field;
  const inner = rawFields(top[0]!.body);
  if (!inner) return null;
  const parts: Uint8Array[] = [];
  let placed = value === null;
  for (const f of inner) {
    if (f.field === field && f.wire === WT_VARINT) continue;
    if (!placed && f.field > field) {
      parts.push(new ProtoWriter().u32(field, value!).done());
      placed = true;
    }
    parts.push(f.raw);
  }
  if (!placed) parts.push(new ProtoWriter().u32(field, value!).done());
  return new ProtoWriter().bytesField(variant, concat(parts)).done();
}

/** An encoded EngineMessage{request|response} with `seq` replaced. Null when malformed. */
export function withEnvelopeSeq(msg: Uint8Array, seq: number): Uint8Array | null {
  return withInnerVarint(msg, 1, seq);
}

/** An encoded EngineMessage{events} with `causedBy` set (or removed: null). Null when malformed. */
export function withCausedBy(msg: Uint8Array, seq: number | null): Uint8Array | null {
  return withInnerVarint(msg, 4, seq);
}

export interface RequestPeek {
  body: 'command' | 'query' | 'batch';
  /** The command's schema id (the Command union's field number). */
  commandId?: number;
  /** A command's field 1 when it is a varint (setViewport / closeViewport: the viewport). */
  firstVarint?: number;
}

/** What an encoded EngineMessage{request} asks for, without decoding it. Null when malformed. */
export function peekRequest(msg: Uint8Array): RequestPeek | null {
  const env = peekEnvelope(msg);
  if (!env || env.kind !== 'request') return null;
  const inner = fields(env.body);
  const rb = inner?.find((f) => f.field === 2 && f.body);
  if (!rb?.body) return null;
  const union = fields(rb.body);
  if (!union || union.length !== 1 || !union[0]!.body) return null;
  const kind = union[0]!.field === 1 ? 'command' : union[0]!.field === 2 ? 'query' : union[0]!.field === 3 ? 'batch' : null;
  if (!kind) return null;
  if (kind !== 'command') return { body: kind };
  const cmd = fields(union[0]!.body);
  if (!cmd || cmd.length !== 1) return null;
  const peek: RequestPeek = { body: 'command', commandId: cmd[0]!.field };
  const args = cmd[0]!.body ? fields(cmd[0]!.body) : [];
  const first = args?.find((f) => f.field === 1 && f.wire === WT_VARINT);
  peek.firstVarint = first?.num ?? 0;
  return peek;
}

/** Is an encoded EngineMessage{response} an error (Outcome variant 4)? Null when malformed. */
export function responseIsError(msg: Uint8Array): boolean | null {
  const env = peekEnvelope(msg);
  if (!env || env.kind !== 'response') return null;
  const inner = fields(env.body);
  const outcome = inner?.find((f) => f.field === 3 && f.body);
  if (!outcome?.body) return null;
  const union = fields(outcome.body);
  if (!union || union.length !== 1) return null;
  return union[0]!.field === 4;
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
/** B4 round 2: the overlay geometry of the next FrameReady (setOverlayGeometry), possibly in several parts. */
export type FrameGeometryMessage = Extract<FrameChannelMessage, { type: 'geometry' }>;
/** What the engine sends on fd 3. Slot handles are NT handles valid in THIS process; the engine owns their lifetime — never close them. */
export type EngineFrameMessage = SlotsMessage | FrameReadyMessage | PongMessage | FrameGeometryMessage;

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
    case 'geometry':
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
