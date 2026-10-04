/**
 * The menu / library / dialog inserts as engine edits: each lays its layer(s)
 * into a FragmentBuilder (sceneInsert.ts `build*`, pure) against the
 * mirror's insert frame and lands as ONE `pasteLayers` entry, selected
 * (insertFragment.ts). What a builder needs from the existing document — the
 * next free "Camera N", whether the comp already has an ambient light — is
 * read from the mirror here, not from the page replica.
 *
 * Every function resolves to the new layer ids (fragment order), [] when
 * nothing was built, or null when the engine refused (toasted).
 */

import {
  build3DPrimitive, build3DText, buildCamera, buildLight, buildPrimitive, buildShape, buildSolid, buildSvgDocument, buildText,
  notify3DPrimitive, notify3DText, notifyAmbientFill, notifyCameraNeeds3D,
  type CameraSeed, type LightSeed, type Primitive3DKind, type ShapeKind,
} from '@core/scene/layerBuilders';
import type { SceneKind } from '@core/scene/sceneKind';
import type { PrimitiveSpec } from '@core/scene/primitiveLayer';
import { defaultTextSize } from '@core/scene/textDefaults';
import { compLayersDeep, fieldValue } from '@core/mirror/layerFields';
import { uiKindOf } from '@core/mirror/layerKinds';
import { nextDeviceNameIn } from '@core/mirror/deviceNames';
import { documentMirror } from '@stores/documentMirror';
import { activeCompIdNow } from '@hooks/useMirror';
import { insertFragment, type InsertOptions } from './insertFragment';

type At = { x: number; y: number };

/** A library shape (rect / star / heart …), centred (or at `at`, comp px). */
export function insertShapeEdit(shape: ShapeKind, name: string, at?: At, label = `Insert ${name}`, opts: InsertOptions = {}): Promise<string[] | null> {
  return insertFragment(label, (b, f) => buildShape(b, f, shape, name, at), opts);
}

/** A text preset (size / weight / style overrides), centred (or at `at`). */
export function insertTextEdit(
  name: string,
  fontSize = defaultTextSize(),
  fontWeight = 400,
  extraProps: Record<string, unknown> = {},
  at?: At,
  label = `Insert ${name}`,
  opts: InsertOptions = {},
): Promise<string[] | null> {
  return insertFragment(label, (b, f) => buildText(b, f, name, fontSize, fontWeight, at ? { ...extraProps, pos: at } : extraProps), opts);
}

/** Layer ▸ New ▸ Shape / Text Layer (the generic primitive). */
export function insertPrimitiveEdit(kind: SceneKind, name: string, label: string, opts: InsertOptions = {}): Promise<string[] | null> {
  return insertFragment(label, (b, f) => buildPrimitive(b, f, kind, name), opts);
}

/** A full-frame solid. */
export function insertSolidEdit(color?: string, label = 'New Solid', opts: InsertOptions = {}): Promise<string[] | null> {
  return insertFragment(label, (b, f) => buildSolid(b, f, color), opts);
}

/** 3D Extruded Text. */
export async function insert3DTextEdit(text = '3D TEXT', label = 'New 3D Text', opts: InsertOptions = {}): Promise<string[] | null> {
  const ids = await insertFragment(label, (b, f) => build3DText(b, f, text), opts);
  if (ids && ids.length > 0) notify3DText();
  return ids;
}

/** A 3D primitive (cube / plane / sphere …, `spec` overriding the mesh defaults). */
export async function insert3DPrimitiveEdit(
  type: Primitive3DKind = 'cube',
  spec?: Partial<PrimitiveSpec>,
  label = 'New 3D Primitive',
  opts: InsertOptions = {},
): Promise<string[] | null> {
  const ids = await insertFragment(label, (b, f) => build3DPrimitive(b, f, type, spec), opts);
  if (ids && ids.length > 0) notify3DPrimitive(type);
  return ids;
}

/**
 * A camera (AE New Camera). The name defaults to the comp's next free
 * "Camera N"; after it lands, a scene with no 3D content layer gets the tip
 * that a camera only moves 3D layers.
 */
export async function insertCameraEdit(seed: CameraSeed = {}, label = 'New Camera', opts: InsertOptions = {}): Promise<string[] | null> {
  const comp = opts.comp ?? activeCompIdNow() ?? 'comp_root';
  const m = documentMirror();
  const name = seed.name?.trim() || nextDeviceNameIn(m, comp, 'camera');
  const ids = await insertFragment(label, (b, f) => buildCamera(b, f, { ...seed, name }), { ...opts, comp });
  if (ids && ids.length > 0) {
    const mine = new Set(ids);
    const anyThreeD = m.layerIds().some((id) => {
      if (mine.has(id)) return false;
      const l = m.layer(id);
      const k = l ? uiKindOf(l) : '';
      return !!l && k !== 'camera' && k !== 'light' && l.switches.threeD;
    });
    if (!anyThreeD) notifyCameraNeeds3D();
  }
  return ids;
}

/** Whether composition `comp` holds an ambient or environment light (sceneInsert.compHasAmbientLight over the mirror). */
export async function compHasAmbientLightNow(comp: string): Promise<boolean> {
  const m = documentMirror();
  for (const l of compLayersDeep(m, comp)) {
    if (uiKindOf(l) !== 'light') continue;
    await m.loadTree(l.id);
    const t = fieldValue(m, l.id, 'light/lightType');
    if (t === 'ambient' || t === 'environment') return true;
  }
  return false;
}

/**
 * A light (AE New Light). The name defaults to the comp's next free "Light N";
 * a comp's first positional light brings an Ambient Fill unless
 * `seed.ambientFill` is false. The light is selected.
 */
export async function insertLightEdit(seed: LightSeed = {}, label = 'New Light', opts: InsertOptions = {}): Promise<string[] | null> {
  const comp = opts.comp ?? activeCompIdNow() ?? 'comp_root';
  const m = documentMirror();
  const name = seed.name?.trim() || nextDeviceNameIn(m, comp, 'light');
  const positional = seed.type !== 'ambient' && seed.type !== 'environment';
  const compHasAmbient = positional && seed.ambientFill !== false ? await compHasAmbientLightNow(comp) : true;
  let fill = false;
  const ids = await insertFragment(label, (b, f) => {
    const made = buildLight(b, f, { ...seed, name, compHasAmbient });
    fill = !!made.fill;
    return made.light;
  }, { ...opts, comp });
  if (ids && ids.length > 0 && fill) notifyAmbientFill();
  return ids;
}

/**
 * An SVG document (a paste, a drop): stored intact as one SVG layer, or — an
 * animated, losslessly convertible one — an icon group with its keyframes
 * (sceneInsert.ts `buildSvgDocument`). Null result = refused; [] = the
 * markup could not be read.
 */
export async function insertSvgDocumentEdit(svgText: string, name: string, label: string, opts: InsertOptions & { sizeHint?: number; at?: At } = {}): Promise<string[] | null> {
  let report: (() => void) | null = null;
  const ids = await insertFragment(label, (b, f) => {
    const made = buildSvgDocument(b, f, svgText, name, { ...(opts.sizeHint ? { sizeHint: opts.sizeHint } : {}), ...(opts.at ?? {}) });
    if (!made) return null;
    report = made.report;
    return made.id;
  }, opts);
  if (ids && ids.length > 0) (report as (() => void) | null)?.();
  return ids;
}
