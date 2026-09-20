/**
 * A tiny After Effects project writer, for tests.
 *
 * The reader's job is to find named fields at fixed offsets inside binary
 * records, and the only honest way to test that is to write those records and
 * read them back. So this builds real RIFX bytes — real `cdta`, real `ldta`,
 * real keyframe `ldat` — from named options, and every offset here is the
 * INVERSE of one in the reader.
 *
 * That makes the pair a genuine round trip rather than a tautology: a test
 * writes `{ width: 1920 }`, the writer puts 1920 at byte 140 of a `cdta`, and
 * the reader has to look at byte 140 to find it. Getting both wrong in the same
 * way is possible in principle, which is why the fixtures in
 * `docs/AFTER_EFFECTS_IMPORT.md` name the real AE projects the offsets were
 * originally read off.
 */

const enc = new TextEncoder();

const fourcc = (id: string): Uint8Array => {
  const out = new Uint8Array(4).fill(0x20);
  out.set(enc.encode(id).subarray(0, 4));
  return out;
};

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const u32be = (v: number): Uint8Array => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, v >>> 0, false);
  return out;
};

/** A leaf chunk: id, big-endian size, body, and a pad byte when odd. */
export function chunk(id: string, body: Uint8Array): Uint8Array {
  const parts = [fourcc(id), u32be(body.length), body];
  if (body.length % 2 === 1) parts.push(new Uint8Array(1));
  return concat(parts);
}

/** A `LIST` chunk of the given type. */
export function list(type: string, children: readonly Uint8Array[]): Uint8Array {
  return chunk('LIST', concat([fourcc(type), ...children]));
}

/** A `Utf8` chunk — how AE writes every free-form name. */
export const utf8 = (text: string): Uint8Array => chunk('Utf8', enc.encode(text));

/** A `tdmn` chunk — the 40-byte NUL-padded match name before every member. */
export function tdmn(matchName: string): Uint8Array {
  const body = new Uint8Array(40);
  body.set(enc.encode(matchName).subarray(0, 40));
  return chunk('tdmn', body);
}

/** A writable fixed-size record. */
class Record {
  readonly bytes: Uint8Array;
  private readonly view: DataView;

  constructor(size: number) {
    this.bytes = new Uint8Array(size);
    this.view = new DataView(this.bytes.buffer);
  }
  u8(at: number, v: number): this {
    this.view.setUint8(at, v);
    return this;
  }
  u16(at: number, v: number): this {
    this.view.setUint16(at, v, false);
    return this;
  }
  u32(at: number, v: number): this {
    this.view.setUint32(at, v >>> 0, false);
    return this;
  }
  i32(at: number, v: number): this {
    this.view.setInt32(at, v, false);
    return this;
  }
  f32(at: number, v: number): this {
    this.view.setFloat32(at, v, false);
    return this;
  }
  f64(at: number, v: number): this {
    this.view.setFloat64(at, v, false);
    return this;
  }
  str(at: number, size: number, text: string): this {
    this.bytes.set(enc.encode(text).subarray(0, size - 1), at);
    return this;
  }
  bit(at: number, bit: number, on: boolean): this {
    const cur = this.view.getUint8(at);
    this.view.setUint8(at, on ? cur | (1 << bit) : cur & ~(1 << bit));
    return this;
  }
}

// ── Items ───────────────────────────────────────────────────────────

export interface IdtaOptions {
  /** 1 folder, 4 composition, 7 footage. */
  type: number;
  id: number;
  label?: number;
}

export const idta = ({ type, id, label = 0 }: IdtaOptions): Uint8Array =>
  chunk('idta', new Record(84).u16(0, type).u32(16, id).u8(58, label).bytes);

export interface CdtaOptions {
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  background?: [number, number, number];
  /** Keyframe times are counts of this; AE's 24 fps value is 24576. */
  timebase?: number;
  motionBlur?: boolean;
  shutterAngle?: number;
}

export function cdta(o: CdtaOptions): Uint8Array {
  const r = new Record(204);
  const fpsInt = Math.floor(o.fps);
  r.u32(8, o.timebase ?? 24576);
  r.u32(16, 600);
  r.u32(20, 0).u32(24, 1); // work area start
  r.u32(28, 0xffffffff).u32(32, 1); // work area end: AE's "to the end" sentinel
  r.u32(44, Math.round(o.durationSeconds * 1000)).u32(48, 1000);
  const [br, bg, bb] = o.background ?? [0, 0, 0];
  r.u8(52, br).u8(53, bg).u8(54, bb);
  if (o.motionBlur) r.bit(139, 3, true);
  r.u16(140, o.width).u16(142, o.height);
  r.u32(144, 1).u32(148, 1); // pixel aspect
  r.u16(156, fpsInt).u16(158, Math.round((o.fps - fpsInt) * 65536));
  r.i32(164, 0).u32(168, 1); // display start time
  r.u16(174, o.shutterAngle ?? 180);
  r.i32(196, 128).i32(200, 16);
  return chunk('cdta', r.bytes);
}

export interface SspcOptions {
  width: number;
  height: number;
  durationSeconds?: number;
  frameRate?: number;
  sourceFormat?: string;
  missing?: boolean;
  sampleRate?: number;
}

export function sspc(o: SspcOptions): Uint8Array {
  const r = new Record(224);
  r.str(22, 5, o.sourceFormat ?? 'png!');
  r.u16(32, o.width).u16(36, o.height);
  r.u32(38, Math.round((o.durationSeconds ?? 0) * 1000)).u32(42, 1000);
  r.u32(56, Math.floor(o.frameRate ?? 0)).u16(60, 0);
  if (o.missing) r.u8(115, 1);
  r.u32(136, 1).u32(140, 1);
  r.f64(160, o.sampleRate ?? 0);
  return chunk('sspc', r.bytes);
}

/** A solid's `opti`: the type code, the colour, and the solid's own name. */
export function soliOpti(color: [number, number, number], name: string): Uint8Array {
  const r = new Record(282);
  r.str(0, 5, 'Soli');
  r.u16(4, 9);
  r.f32(14, color[0]).f32(18, color[1]).f32(22, color[2]);
  r.str(26, 256, name);
  return chunk('opti', r.bytes);
}

/** The alias JSON AE writes for a file-backed footage item. */
export const alas = (fullpath: string): Uint8Array =>
  list('Als2', [chunk('alas', enc.encode(JSON.stringify({ fullpath })))]);

// ── Layers ──────────────────────────────────────────────────────────

export interface LdtaOptions {
  id: number;
  /** 0 av, 1 light, 2 camera, 3 text, 4 shape. */
  type?: number;
  sourceId?: number;
  parentId?: number;
  inPoint?: number;
  outPoint?: number;
  startTime?: number;
  name?: string;
  blendingMode?: number;
  trackMatte?: number;
  label?: number;
  threeD?: boolean;
  solo?: boolean;
  shy?: boolean;
  locked?: boolean;
  guide?: boolean;
  adjustment?: boolean;
  nullLayer?: boolean;
  enabled?: boolean;
  motionBlur?: boolean;
  matteLayerId?: number;
}

export function ldta(o: LdtaOptions): Uint8Array {
  const r = new Record(164);
  const time = (seconds: number, dividendAt: number, divisorAt: number): void => {
    r.i32(dividendAt, Math.round(seconds * 1000)).u32(divisorAt, 1000);
  };
  r.u32(0, o.id);
  r.i32(8, 1); // stretch dividend
  time(o.startTime ?? 0, 12, 16);
  time(o.inPoint ?? 0, 20, 24);
  time(o.outPoint ?? 0, 28, 32);
  r.bit(37, 1, !!o.guide);
  r.bit(38, 7, !!o.nullLayer)
    .bit(38, 3, !!o.solo)
    .bit(38, 2, !!o.threeD)
    .bit(38, 1, !!o.adjustment);
  r.bit(39, 6, !!o.shy)
    .bit(39, 5, !!o.locked)
    .bit(39, 3, !!o.motionBlur)
    .bit(39, 2, true) // effects active
    .bit(39, 1, true) // audio enabled
    .bit(39, 0, o.enabled !== false);
  r.u32(40, o.sourceId ?? 0);
  r.u8(61, o.label ?? 0);
  r.str(64, 32, o.name ?? '');
  r.u8(99, o.blendingMode ?? 2);
  r.u8(107, o.trackMatte ?? 0);
  r.u32(108, 1); // stretch divisor
  r.u8(131, o.type ?? 0);
  r.u32(132, o.parentId ?? 0);
  r.u32(160, o.matteLayerId ?? 0);
  return chunk('ldta', r.bytes);
}

// ── Properties ──────────────────────────────────────────────────────

export interface Tdb4Options {
  dimensions: number;
  spatial?: boolean;
  color?: boolean;
  animated?: boolean;
  expression?: boolean;
}

export function tdb4(o: Tdb4Options): Uint8Array {
  const r = new Record(124);
  r.u16(0, 0xdb99).u16(2, o.dimensions);
  r.bit(5, 3, !!o.spatial);
  r.bit(59, 0, !!o.color);
  r.u8(68, o.animated ? 1 : 0);
  if (o.expression) r.bit(120, 0, true);
  return chunk('tdb4', r.bytes);
}

/** A `cdat` chunk: N big-endian doubles, the property's static value. */
export function cdat(values: readonly number[]): Uint8Array {
  const r = new Record(values.length * 8);
  values.forEach((v, i) => r.f64(i * 8, v));
  return chunk('cdat', r.bytes);
}

export interface AeKeyframe {
  /** Seconds — converted to timebase units by the writer. */
  time: number;
  value: number[];
  /** 1 linear, 2 bezier, 3 hold. */
  inInterp?: number;
  outInterp?: number;
  inSpeed?: number[];
  inInfluence?: number[];
  outSpeed?: number[];
  outInfluence?: number[];
  inTangent?: number[];
  outTangent?: number[];
}

export interface KeyframeListOptions {
  dimensions: number;
  spatial?: boolean;
  timebase?: number;
  keyframes: readonly AeKeyframe[];
}

/**
 * The `LIST list` that holds a property's keyframes: an `lhd3` header saying
 * how many and how big, then the `ldat` items themselves.
 */
export function keyframeList(o: KeyframeListOptions): Uint8Array {
  const n = o.dimensions;
  const timebase = o.timebase ?? 24576;
  const itemSize = o.spatial ? 8 + 8 + 5 * 8 + 3 * n * 8 : 8 + 5 * n * 8;

  const header = new Record(52);
  header.u16(10, o.keyframes.length).u32(12, 1).u16(18, itemSize).u8(23, 4).u32(24, 1).u32(28, 2);

  const data = new Record(itemSize * o.keyframes.length);
  o.keyframes.forEach((kf, i) => {
    const at = i * itemSize;
    data.i32(at, Math.round(kf.time * timebase));
    data.u8(at + 4, kf.inInterp ?? 1).u8(at + 5, kf.outInterp ?? 1);
    const pick = (a: number[] | undefined, dim: number): number => a?.[dim] ?? a?.[0] ?? 0;
    if (o.spatial) {
      // A spatial keyframe: a flag byte, five shared doubles, then the value
      // and the two tangent arrays.
      const base = at + 8 + 8;
      data.f64(base, 0);
      data.f64(base + 8, pick(kf.inSpeed, 0));
      data.f64(base + 16, pick(kf.inInfluence, 0));
      data.f64(base + 24, pick(kf.outSpeed, 0));
      data.f64(base + 32, pick(kf.outInfluence, 0));
      for (let d = 0; d < n; d++) {
        data.f64(base + 40 + d * 8, kf.value[d] ?? 0);
        data.f64(base + 40 + (n + d) * 8, pick(kf.inTangent, d));
        data.f64(base + 40 + (2 * n + d) * 8, pick(kf.outTangent, d));
      }
    } else {
      const base = at + 8;
      for (let d = 0; d < n; d++) {
        data.f64(base + d * 8, kf.value[d] ?? 0);
        data.f64(base + (n + d) * 8, pick(kf.inSpeed, d));
        data.f64(base + (2 * n + d) * 8, pick(kf.inInfluence, d));
        data.f64(base + (3 * n + d) * 8, pick(kf.outSpeed, d));
        data.f64(base + (4 * n + d) * 8, pick(kf.outInfluence, d));
      }
    }
  });

  return list('list', [chunk('lhd3', header.bytes), chunk('ldat', data.bytes)]);
}

export interface PropertyOptions extends Tdb4Options {
  value?: readonly number[];
  keyframes?: readonly AeKeyframe[];
  timebase?: number;
  expressionSource?: string;
}

/** One leaf property: the `tdmn` naming it and the `LIST tdbs` holding it. */
export function property(matchName: string, o: PropertyOptions): Uint8Array[] {
  const children: Uint8Array[] = [
    chunk('tdsb', new Uint8Array(4)),
    tdb4({ ...o, animated: o.animated ?? (o.keyframes?.length ?? 0) > 0, expression: !!o.expressionSource }),
  ];
  if (o.value) children.push(cdat(o.value));
  if (o.keyframes?.length) {
    children.push(
      keyframeList({
        dimensions: o.dimensions,
        ...(o.spatial ? { spatial: true } : {}),
        ...(o.timebase ? { timebase: o.timebase } : {}),
        keyframes: o.keyframes,
      }),
    );
  }
  if (o.expressionSource) children.push(utf8(o.expressionSource));
  return [tdmn(matchName), list('tdbs', children)];
}

/** A property group: its members, terminated the way AE terminates them. */
export function group(matchName: string, members: readonly Uint8Array[]): Uint8Array[] {
  return [
    tdmn(matchName),
    list('tdgp', [chunk('tdsb', new Uint8Array(4)), ...members, tdmn('ADBE Group End')]),
  ];
}

/** A mask outline: `shph` bounding box plus its normalised vertices. */
export function maskShape(
  box: { left: number; top: number; right: number; bottom: number },
  points: ReadonlyArray<[number, number]>,
  closed = true,
): Uint8Array {
  const header = new Record(24);
  header.u8(3, closed ? 1 : 1 | (1 << 3));
  header.f32(4, box.left).f32(8, box.top).f32(12, box.right).f32(16, box.bottom);

  const listHeader = new Record(52);
  listHeader.u16(10, points.length).u32(12, 1).u16(18, 8).u8(23, 4);
  const data = new Record(points.length * 8);
  points.forEach(([x, y], i) => data.f32(i * 8, x).f32(i * 8 + 4, y));

  return list('shap', [
    chunk('shph', header.bytes),
    list('list', [chunk('lhd3', listHeader.bytes), chunk('ldat', data.bytes)]),
  ]);
}

export interface MaskOptions {
  /** 0 none, 1 add, 2 subtract, 3 intersect, 4 lighten, 5 darken, 6 difference. */
  mode?: number;
  inverted?: boolean;
  name?: string;
  shape: Uint8Array;
}

/** One `ADBE Mask Atom`: its `mkif` and its property group. */
export function mask(o: MaskOptions): Uint8Array[] {
  const info = new Record(48);
  info.u8(0, o.inverted ? 1 : 0).u16(6, o.mode ?? 1).u32(8, 1);
  const shapeMember = [
    tdmn('ADBE Mask Shape'),
    list('om-s', [
      list('tdbs', [chunk('tdsb', new Uint8Array(4)), tdb4({ dimensions: 1 }), cdat([0])]),
      list('omks', [o.shape]),
    ]),
  ];
  const members = [
    ...shapeMember,
    ...property('ADBE Mask Opacity', { dimensions: 1, value: [1] }),
    ...property('ADBE Mask Feather', { dimensions: 2, value: [0, 0] }),
  ];
  return [
    tdmn('ADBE Mask Atom'),
    chunk('mkif', info.bytes),
    list('tdgp', [
      chunk('tdsb', new Uint8Array(4)),
      ...(o.name ? [chunk('tdsn', utf8(o.name))] : []),
      ...members,
      tdmn('ADBE Group End'),
    ]),
  ];
}

/**
 * A `pard` — the serialised `PF_ParamDef` that carries a parameter's LABEL.
 *
 * The importer matches parameters by label rather than by position, so a
 * fixture without these is a fixture whose effect lands at its defaults.
 */
export function pard(label: string, controlType = 10): Uint8Array {
  return chunk('pard', new Record(56).u8(15, controlType).str(16, 32, label).bytes);
}

export interface EffectParamSpec {
  /** The `-000N` suffix AE would give it. */
  index: number;
  label: string;
  /** `PF_ParamType` — 6 point, 5 colour, 10 slider (the default). */
  controlType?: number;
  value?: readonly number[];
  keyframes?: readonly AeKeyframe[];
  dimensions?: number;
  color?: boolean;
}

/**
 * An effect: the `sspc` wrapper, its display name, the `parT` list declaring
 * its parameters, and the `tdgp` holding their values.
 */
export function effect(matchName: string, displayName: string, params: readonly EffectParamSpec[]): Uint8Array[] {
  const names = params.map((p) => `${matchName}-${String(p.index).padStart(4, '0')}`);
  const definitions = params.flatMap((p, i) => [tdmn(names[i]!), pard(p.label, p.controlType ?? 10)]);
  const values = params.flatMap((p, i) =>
    property(names[i]!, {
      dimensions: p.dimensions ?? (p.controlType === 6 ? 2 : p.color ? 4 : 1),
      ...(p.color ? { color: true } : {}),
      ...(p.value ? { value: p.value } : {}),
      ...(p.keyframes ? { keyframes: p.keyframes } : {}),
    }),
  );
  return [
    tdmn(matchName),
    list('sspc', [
      chunk('fnam', utf8(displayName)),
      list('parT', [chunk('parn', new Uint8Array(4)), ...definitions]),
      list('tdgp', [chunk('tdsb', new Uint8Array(4)), ...values, tdmn('ADBE Group End')]),
    ]),
  ];
}

// ── Whole files ─────────────────────────────────────────────────────

export interface LayerOptions extends LdtaOptions {
  displayName?: string;
  properties?: readonly Uint8Array[];
}

export const layer = (o: LayerOptions): Uint8Array =>
  list('Layr', [
    ldta(o),
    utf8(o.displayName ?? ''),
    list('tdgp', [chunk('tdsb', new Uint8Array(4)), ...(o.properties ?? []), tdmn('ADBE Group End')]),
  ]);

export interface CompItemOptions extends CdtaOptions {
  id: number;
  name: string;
  layers?: readonly Uint8Array[];
}

export const compItem = (o: CompItemOptions): Uint8Array =>
  list('Item', [idta({ type: 4, id: o.id }), utf8(o.name), cdta(o), ...(o.layers ?? [])]);

export interface FootageItemOptions extends SspcOptions {
  id: number;
  name: string;
  path?: string;
  solid?: { color: [number, number, number]; name: string };
}

export const footageItem = (o: FootageItemOptions): Uint8Array =>
  list('Item', [
    idta({ type: 7, id: o.id }),
    utf8(o.name),
    list('Pin ', [
      sspc(o),
      ...(o.path ? [alas(o.path)] : []),
      ...(o.solid ? [soliOpti(o.solid.color, o.solid.name)] : []),
    ]),
  ]);

export const folderItem = (id: number, name: string, children: readonly Uint8Array[]): Uint8Array =>
  list('Item', [idta({ type: 1, id }), utf8(name), list('Sfdr', children)]);

/** The whole file: `RIFX`, its size, `Egg!`, then the chunks. */
export function aepFile(items: readonly Uint8Array[], opts: { aeMajor?: number; aeMinor?: number } = {}): Uint8Array {
  const head = new Record(20);
  const major = opts.aeMajor ?? 24;
  const word =
    ((Math.floor(major / 8) & 0x1f) << 26) | ((major % 8) << 19) | (((opts.aeMinor ?? 0) & 0x0f) << 15);
  head.u32(4, word);
  const body = concat([fourcc('Egg!'), chunk('head', head.bytes), list('Fold', [chunk('fdta', new Uint8Array(14)), ...items])]);
  return concat([fourcc('RIFX'), u32be(body.length), body]);
}
