/**
 * Chunk tree → `AepProject`.
 *
 * The project is one folder tree. `LIST Fold` is the root; each `LIST Item`
 * inside it is a folder, a composition or a piece of footage, and a folder's
 * contents are another `LIST Sfdr` of `Item`s. What an item IS comes from the
 * first two bytes of its `idta`.
 *
 *     LIST Fold
 *       LIST Item          idta says 4 → composition
 *         idta  Utf8 "Comp 1"  cdta
 *         LIST Layr …          one per layer, top layer first
 *       LIST Item          idta says 7 → footage
 *         idta  Utf8 ""
 *         LIST Pin           sspc, the alias JSON, the opti variant
 *       LIST Item          idta says 1 → folder
 *         LIST Sfdr          … and round again
 *
 * ## Two things in a comp that are not layers
 *
 * Every composition also carries `DLay` and `SLay` lists that look exactly like
 * layers — same `ldta`, same property tree — and are not. They are the comp
 * viewer's own cameras (Default, Front, Left, Top, …). Only `Layr` is a layer,
 * which is why the layer walk matches on the list type instead of on "anything
 * with an `ldta`". An importer that misses this adds eleven invisible cameras
 * to every comp it opens.
 *
 * ## Nothing here interprets
 *
 * Units, axes and names stay AE's. A layer's opacity is 0–100 because AE says
 * so; positions are top-left-origin comp pixels because AE says so. Everything
 * that turns those into this editor's conventions lives in `aepPlan.ts`, so a
 * bug is either "we read the file wrong" or "we mapped it wrong" and never both.
 */

import {
  chunkText,
  findChunk,
  findList,
  findLists,
  ratio,
  readerFor,
  type AepChunk,
  type Reader,
} from './riff';
import { groupMembers, readGroup, type PropertyContext } from './aepProperties';
import type {
  AepComp,
  AepFolder,
  AepFootage,
  AepItem,
  AepLayer,
  AepLayerKind,
  AepMask,
  AepMaskMode,
  AepProject,
  AepPropertyGroup,
  AepTrackMatte,
} from './aepModel';

// ── Enumerations, as stored ─────────────────────────────────────────

const ITEM_KINDS: Record<number, 'folder' | 'comp' | 'footage'> = { 1: 'folder', 4: 'comp', 7: 'footage' };

const LAYER_KINDS: Record<number, AepLayerKind> = {
  0: 'av',
  1: 'light',
  2: 'camera',
  3: 'text',
  4: 'shape',
  5: 'model',
  7: 'mesh',
};

const TRACK_MATTES: AepTrackMatte[] = ['none', 'alpha', 'alpha-inverted', 'luma', 'luma-inverted'];

const MASK_MODES: AepMaskMode[] = ['none', 'add', 'subtract', 'intersect', 'lighten', 'darken', 'difference'];

/**
 * Transfer-mode index → AE's blending-mode name.
 *
 * The indices are not the order the menu shows and are not contiguous (there
 * is no 1), which is the whole reason this is a table. Index 0 is what AE
 * writes for layers that cannot have a blending mode at all — cameras, lights
 * and nulls — and reads as Normal.
 */
const BLENDING_MODES: Record<number, string> = {
  0: 'Normal',
  2: 'Normal',
  3: 'Dissolve',
  4: 'Add',
  5: 'Multiply',
  6: 'Screen',
  7: 'Overlay',
  8: 'Soft Light',
  9: 'Hard Light',
  10: 'Darken',
  11: 'Lighten',
  12: 'Classic Difference',
  13: 'Hue',
  14: 'Saturation',
  15: 'Color',
  16: 'Luminosity',
  17: 'Stencil Alpha',
  18: 'Stencil Luma',
  19: 'Silhouette Alpha',
  20: 'Silhouette Luma',
  21: 'Luminescent Premul',
  22: 'Alpha Add',
  23: 'Classic Color Dodge',
  24: 'Classic Color Burn',
  25: 'Exclusion',
  26: 'Difference',
  27: 'Color Dodge',
  28: 'Color Burn',
  29: 'Linear Dodge',
  30: 'Linear Burn',
  31: 'Linear Light',
  32: 'Vivid Light',
  33: 'Pin Light',
  34: 'Hard Mix',
  35: 'Lighter Color',
  36: 'Darker Color',
  37: 'Subtract',
  38: 'Divide',
};

/** AE's "the work area runs to the end of the comp" sentinel. */
const WORK_AREA_OPEN_END = 0xffffffff;

// ── Compositions ────────────────────────────────────────────────────

interface CompSettings {
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  pixelAspect: number;
  background: { r: number; g: number; b: number };
  displayStartTime: number;
  workAreaStart: number;
  workAreaEnd: number;
  motionBlur: boolean;
  shutterAngle: number;
  shutterPhase: number;
  motionBlurSamplesPerFrame: number;
  motionBlurAdaptiveSampleLimit: number;
  frameBlending: boolean;
  hideShyLayers: boolean;
  draft3d: boolean;
  internalTimebase: number;
}

/**
 * `cdta` — 204 bytes of composition settings.
 *
 * The frame rate is an integer plus a 16-bit fraction, so 29.97 arrives as
 * 29 + 63600/65536 rather than as a double. Reading only the integer part is a
 * quiet way to turn every NTSC project into a 29 fps one.
 */
function readCompSettings(cdta: AepChunk | undefined): CompSettings {
  const r = readerFor(cdta);
  const workAreaEndDividend = r.u32(28);
  return {
    width: r.u16(140),
    height: r.u16(142),
    fps: r.u16(156) + r.u16(158) / 65536,
    durationSeconds: ratio(r.u32(44), r.u32(48)),
    pixelAspect: ratio(r.u32(144), r.u32(148)) || 1,
    background: { r: r.u8(52), g: r.u8(53), b: r.u8(54) },
    displayStartTime: ratio(r.i32(164), r.u32(168)),
    workAreaStart: ratio(r.u32(20), r.u32(24)),
    workAreaEnd: workAreaEndDividend === WORK_AREA_OPEN_END ? Infinity : ratio(workAreaEndDividend, r.u32(32)),
    motionBlur: r.bit(139, 3),
    shutterAngle: r.u16(174),
    shutterPhase: r.i32(180),
    motionBlurSamplesPerFrame: r.i32(200),
    motionBlurAdaptiveSampleLimit: r.i32(196),
    frameBlending: r.bit(139, 4),
    hideShyLayers: r.bit(139, 0),
    draft3d: r.bit(138, 7),
    internalTimebase: r.u32(8),
  };
}

// ── Layers ──────────────────────────────────────────────────────────

interface LayerFlags {
  guide: boolean;
  environmentLayer: boolean;
  nullLayer: boolean;
  solo: boolean;
  threeD: boolean;
  adjustment: boolean;
  collapseTransformation: boolean;
  shy: boolean;
  locked: boolean;
  frameBlending: boolean;
  motionBlur: boolean;
  effectsActive: boolean;
  audioEnabled: boolean;
  enabled: boolean;
  autoOrient: number;
}

/**
 * The three flag bytes at `ldta` offsets 37–39.
 *
 * Auto-orient is the awkward one: it is not a field but a combination. "Along
 * path" is its own bit; "toward camera / point of interest" is stored in one
 * bit for solids and another for cameras and lights, which is a difference AE
 * has and nobody would guess.
 */
function readLayerFlags(r: Reader, layerKind: AepLayerKind): LayerFlags {
  const threeD = r.bit(38, 2);
  const alongPath = r.bit(38, 0);
  const towardPoint = layerKind === 'camera' || layerKind === 'light' ? r.bit(38, 6) : r.bit(38, 5);
  const charsTowardCamera = r.bit(37, 4) && r.bit(37, 3);

  let autoOrient = 0;
  if (alongPath) autoOrient = 1;
  else if (towardPoint && threeD) autoOrient = 2;
  else if (charsTowardCamera) autoOrient = 3;

  return {
    guide: r.bit(37, 1),
    environmentLayer: r.bit(37, 5),
    nullLayer: r.bit(38, 7),
    solo: r.bit(38, 3),
    threeD,
    adjustment: r.bit(38, 1),
    collapseTransformation: r.bit(39, 7),
    shy: r.bit(39, 6),
    locked: r.bit(39, 5),
    frameBlending: r.bit(39, 4),
    motionBlur: r.bit(39, 3),
    effectsActive: r.bit(39, 2),
    audioEnabled: r.bit(39, 1),
    enabled: r.bit(39, 0),
    autoOrient,
  };
}

/**
 * Masks, lifted out of the `ADBE Mask Parade` group.
 *
 * Each mask is a `tdmn "ADBE Mask Atom"` whose `mkif` sits BETWEEN the name and
 * the group — which is why this walks raw members rather than the decoded
 * property tree, where that chunk has nowhere to live.
 */
function readMasks(parade: AepChunk | undefined, ctx: PropertyContext): AepMask[] {
  if (!parade) return [];
  const out: AepMask[] = [];
  for (const member of groupMembers(parade)) {
    if (member.value.listType !== 'tdgp') continue;
    const info = readerFor(member.between.find((c) => c.id === 'mkif'));
    const properties = readGroup(member.value, ctx, member.matchName);
    const shapeProp = properties.children.find((c) => c.node === 'property' && c.shape);
    out.push({
      name: properties.name ?? `Mask ${out.length + 1}`,
      mode: MASK_MODES[info.u16(6)] ?? 'add',
      inverted: info.u8(0) !== 0,
      locked: info.u8(1) !== 0,
      color: { r: info.u8(45), g: info.u8(46), b: info.u8(47) },
      ...(shapeProp?.node === 'property' && shapeProp.shape ? { shape: shapeProp.shape } : {}),
      properties,
    });
  }
  return out;
}

/**
 * `ldta` + the layer's name and property tree.
 *
 * The name is subtle. `ldta` holds a 32-byte name field, and a sibling `Utf8`
 * chunk holds the real one — which is empty when the layer was never renamed,
 * because AE shows the SOURCE's name in that case. Returning the empty string
 * here is deliberate: only the planner knows the source, so only the planner
 * can resolve the fallback.
 */
function readLayer(layr: AepChunk, index: number, comp: CompSettings, read: ReadContext): AepLayer {
  const r = readerFor(findChunk(layr, 'ldta'));
  const kind = LAYER_KINDS[r.u8(131)] ?? 'av';
  const flags = readLayerFlags(r, kind);
  const utf8Name = chunkText(findChunk(layr, 'Utf8'));

  // The size everything normalised on this layer is a fraction OF. A layer
  // with a source measures in the source's pixels; one without (shape, text,
  // null, camera) measures in the comp's.
  const sourceId = r.u32(40);
  const source = read.sizes.get(sourceId);
  const ctx: PropertyContext = {
    timebase: comp.internalTimebase,
    layerWidth: source?.width || comp.width,
    layerHeight: source?.height || comp.height,
    hasSource: source !== undefined,
    warnings: read.warnings,
  };

  const tdgp = findList(layr, 'tdgp');
  const properties: AepPropertyGroup = tdgp
    ? readGroup(tdgp, ctx, 'ADBE Layer')
    : { node: 'group', matchName: 'ADBE Layer', children: [] };

  const parade = tdgp?.children?.find(
    (c, i) => c.listType === 'tdgp' && chunkText(tdgp.children?.[i - 1]) === 'ADBE Mask Parade',
  );

  const stretchDividend = r.i32(8);
  const stretchDivisor = r.u32(108);
  // AE 23 added an explicit matte-layer id. In older files the matte source is
  // "the layer above", which the planner resolves — there is nothing to read.
  const matteLayerId = r.length >= 164 ? r.u32(160) : 0;

  return {
    id: r.u32(0),
    name: utf8Name || r.str(64, 32),
    kind,
    index,
    sourceId,
    parentId: r.u32(132),
    // Three rationals in a row: start time, in point, out point. They are
    // adjacent and identically shaped, which is exactly why the offsets are
    // written out rather than stepped — an off-by-one field here reads an
    // out point as `divisor / dividend` and every layer lands at 0.1 s.
    startTime: ratio(r.i32(12), r.u32(16)),
    inPoint: ratio(r.i32(20), r.u32(24)),
    outPoint: ratio(r.i32(28), r.u32(32)),
    stretch: stretchDivisor === 0 ? 100 : (stretchDividend * 100) / stretchDivisor,
    ...flags,
    blendingMode: BLENDING_MODES[r.u8(99)] ?? 'Normal',
    trackMatte: TRACK_MATTES[r.u8(107)] ?? 'none',
    ...(matteLayerId ? { matteLayerId } : {}),
    label: r.u8(61),
    ...(kind === 'light' ? { lightType: r.u8(139) } : {}),
    properties,
    masks: readMasks(parade, ctx),
  };
}

// ── Footage ─────────────────────────────────────────────────────────

/**
 * The file path AE last resolved.
 *
 * `alas` is JSON — one of the few places AE uses it — and `fullpath` is the
 * absolute path. Parsing is guarded because the field has carried different
 * shapes across versions and a footage item without a path is still an item.
 */
function readAliasPath(pin: AepChunk | undefined): string | undefined {
  const alas = findChunk(findList(pin, 'Als2'), 'alas');
  const text = chunkText(alas);
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as { fullpath?: unknown };
    return typeof parsed.fullpath === 'string' && parsed.fullpath ? parsed.fullpath : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `opti` — what KIND of footage this is.
 *
 * The body's first four bytes are a type code: `Soli` for a solid, `8BPS` for a
 * Photoshop import, and so on. A placeholder writes no code at all, and is
 * identified by the 2 that follows the empty slot — an encoding that looks like
 * a bug and is simply what AE does.
 */
function readOpti(opti: AepChunk | undefined): {
  kind: 'file' | 'solid' | 'placeholder';
  solidColor?: { r: number; g: number; b: number };
  solidName?: string;
} {
  const r = readerFor(opti);
  if (r.length < 6) return { kind: 'file' };
  const code = r.fourcc(0).replace(/\0+$/, '');
  if (code === 'Soli') {
    return {
      kind: 'solid',
      solidColor: { r: r.f32(14), g: r.f32(18), b: r.f32(22) },
      solidName: r.str(26, 256),
    };
  }
  if (code === '' && r.u16(4) === 2) return { kind: 'placeholder' };
  return { kind: 'file' };
}

/** `sspc` — the source's dimensions, timing and audio. */
function readSourceSpec(pin: AepChunk | undefined): {
  width: number;
  height: number;
  durationSeconds: number;
  frameRate: number;
  pixelAspect: number;
  missingAtSave: boolean;
  sourceFormat: string;
  hasAudio: boolean;
} {
  const r = readerFor(findChunk(pin, 'sspc'));
  return {
    width: r.u16(32),
    height: r.u16(36),
    durationSeconds: ratio(r.u32(38), r.u32(42)),
    frameRate: r.u32(56) + r.u16(60) / 65536,
    pixelAspect: ratio(r.u32(136), r.u32(140)) || 1,
    missingAtSave: r.u8(115) !== 0,
    sourceFormat: r.fourcc(22).replace(/\0+$/, ''),
    hasAudio: r.f64(160) > 0,
  };
}

// ── Items ───────────────────────────────────────────────────────────

/**
 * One item's header, without touching its contents.
 *
 * Reading the project takes two passes and this is the first: what every item
 * IS and how big it is, cheaply, so that the second pass — which decodes
 * layers — already knows the size of every source it might point at. A layer's
 * mask vertices, anchor point and effect points are all stored as fractions of
 * that size, and a single pass would have to guess at it for any source
 * declared after the comp that uses it.
 */
interface ItemHeader {
  chunk: AepChunk;
  kind: 'folder' | 'comp' | 'footage';
  id: number;
  name: string;
  label: number;
  folder: readonly string[];
}

function collectItems(list: AepChunk | undefined, folder: readonly string[], out: ItemHeader[]): void {
  for (const item of list?.children ?? []) {
    if (item.listType !== 'Item') continue;
    const idta = readerFor(findChunk(item, 'idta'));
    const kind = ITEM_KINDS[idta.u16(0)];
    if (!kind) continue;
    const name = chunkText(findChunk(item, 'Utf8'));
    out.push({ chunk: item, kind, id: idta.u32(16), name, label: idta.u8(58), folder });
    if (kind === 'folder') collectItems(findList(item, 'Sfdr'), [...folder, name], out);
  }
}

function readFootage(header: ItemHeader): AepFootage {
  const pin = findList(header.chunk, 'Pin ');
  const spec = readSourceSpec(pin);
  const opti = readOpti(findChunk(pin, 'opti'));
  const path = readAliasPath(pin);
  return {
    id: header.id,
    // A solid keeps its name in the `opti` rather than in the item's `Utf8`.
    name: header.name || opti.solidName || '',
    kind: 'footage',
    label: header.label,
    folder: header.folder,
    footageKind: opti.kind,
    ...spec,
    ...(path ? { path } : {}),
    ...(opti.solidColor ? { solidColor: opti.solidColor } : {}),
    // AE gives a still a nominal duration; treating that as real turns every
    // logo PNG into a clip that ends partway through the comp.
    isStill: spec.frameRate === 0 || spec.durationSeconds === 0,
  };
}

interface ReadContext {
  warnings: string[];
  /** Item id → its pixel size, for every item that can be a layer's source. */
  sizes: Map<number, { width: number; height: number }>;
}

/**
 * The AE version that wrote the file, from the packed word in `head`.
 *
 * Only used for reporting — nothing branches on it. The layout is five bits of
 * major-A times eight plus three bits of major-B, which is AE's way of fitting
 * a version like 24.6 into a word alongside the OS and the build.
 */
function readAeVersion(root: AepChunk): string | undefined {
  const head = findChunk(root, 'head');
  if (!head) return undefined;
  const r = readerFor(head);
  const word = r.u32(4);
  const major = ((word >>> 26) & 0x1f) * 8 + ((word >>> 19) & 0x07);
  const minor = (word >>> 15) & 0x0f;
  if (major === 0) return undefined;
  return `${major}.${minor}`;
}

/** Decode a parsed chunk tree into the project model. */
export function readAepProject(root: AepChunk): AepProject {
  const fold = findList(root, 'Fold');
  if (!fold) {
    return { items: [], comps: [], footage: [], warnings: ['the project has no item folder — nothing to import'] };
  }

  const headers: ItemHeader[] = [];
  collectItems(fold, [], headers);

  const ctx: ReadContext = { warnings: [], sizes: new Map() };

  // Pass 1 — footage and composition settings. Both can be a layer's source,
  // so both sizes go into the map before any layer is decoded.
  const footageById = new Map<number, AepFootage>();
  const settingsById = new Map<number, CompSettings>();
  for (const header of headers) {
    if (header.kind === 'footage') {
      const item = readFootage(header);
      footageById.set(header.id, item);
      ctx.sizes.set(header.id, { width: item.width, height: item.height });
    } else if (header.kind === 'comp') {
      const settings = readCompSettings(findChunk(header.chunk, 'cdta'));
      settingsById.set(header.id, settings);
      ctx.sizes.set(header.id, { width: settings.width, height: settings.height });
    }
  }

  // Pass 2 — layers, now that every source size is known.
  const compsById = new Map<number, AepComp>();
  for (const header of headers) {
    if (header.kind !== 'comp') continue;
    const settings = settingsById.get(header.id)!;
    // `Layr` only — `DLay`/`SLay` are the viewer's cameras, not the comp's.
    const layers = findLists(header.chunk, 'Layr').map((layr, i) => readLayer(layr, i + 1, settings, ctx));
    compsById.set(header.id, {
      id: header.id,
      name: header.name,
      kind: 'comp',
      label: header.label,
      folder: header.folder,
      ...settings,
      layers,
    });
  }

  const items: AepItem[] = headers.map((header) => {
    if (header.kind === 'comp') return compsById.get(header.id)!;
    if (header.kind === 'footage') return footageById.get(header.id)!;
    const folder: AepFolder = {
      id: header.id,
      name: header.name,
      kind: 'folder',
      label: header.label,
      folder: header.folder,
    };
    return folder;
  });

  return {
    items,
    comps: [...compsById.values()],
    footage: [...footageById.values()],
    ...(readAeVersion(root) ? { aeVersion: readAeVersion(root) } : {}),
    warnings: ctx.warnings,
  };
}
