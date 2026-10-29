/**
 * Place behind subject — "text behind the person", without a second copy of
 * the video.
 *
 * After Effects, Premiere, Resolve and CapCut all teach the same sandwich:
 * duplicate the clip, cut the subject out of the top copy, put the text
 * between. Here the chosen layers (text, shapes, anything) get Behind Subject
 * (`layer/behindSubject`) naming the footage, and move directly above it: the
 * engine hides them wherever the footage's subject matte is (its soft alpha,
 * hair included) — one video, one matte, one undo entry.
 *
 * When the footage has no subject yet the layers are still placed and the
 * Object Matte tool takes over: click the subject. The Assistant's
 * `place_behind_subject` tool can pass a point instead, and the matte is then
 * made through the shot without a click.
 */

import type { Command } from '@motion/engine-api';
import { secondsToFlicks } from '@motion/engine-api';
import { edit } from '@core/engine/uiEdits';
import { MAIN_VIEWPORT, overlayLayer } from '@stores/overlayGeometry';
import { layerToComp } from './layerScreen';
import { maskPathPolyline } from '@core/effects/mask';
import { mirrorMasksAt } from '@core/mirror/masks';
import { paths } from '@core/engine/propRefs';
import { mirrorMaskHeaders } from '@core/mirror/effects';
import { childOrderOf } from '@core/mirror/layerTree';
import { ROTO_FROZEN_NAME, ROTO_PATH_NAME } from '@core/workspace/rotoBrushTool';
import { subjectOfOutline, subjectOutlineName } from '@core/workspace/subjects';
import { documentMirror } from '@stores/documentMirror';
import { t } from '@core/i18n';
import { reorderCommands } from './layerMenuEdits';

/** The mask names a subject matte travels with (rotoBrushTool.ts / the objectMatte job). */
const MATTE_MASK_NAMES = new Set([ROTO_PATH_NAME, ROTO_FROZEN_NAME]);
const isMatteMask = (name: string): boolean => MATTE_MASK_NAMES.has(name) || subjectOfOutline(name) !== null;

export interface SubjectPlan {
  /** The footage layer whose subject the layers go behind. */
  footage: string;
  /** The layers that go behind the subject, back → front. */
  behind: string[];
  /** The composition / group the layers share (the reorder's parent). */
  comp: string;
  parent: string;
  /** Which of the footage's subjects stand in front of them (absent / empty = all of them): text between two people. */
  inFront?: string[];
}

export type PlanResult = { ok: true; plan: SubjectPlan } | { ok: false; message: string };

function isFootage(id: string): boolean {
  const m = documentMirror();
  const layer = m.layer(id);
  const source = layer?.source;
  if (!source) return false;
  const type = m.item(source)?.mediaType;
  return type === 'video' || type === 'image';
}

/**
 * Which footage and which layers, from a selection. A selected footage layer
 * is the subject's layer; with none selected it is the nearest footage layer
 * BELOW the front-most selected layer. Everything else selected goes behind.
 */
export function planPlaceBehindSubject(selection: readonly string[]): PlanResult {
  const m = documentMirror();
  const ids = selection.filter((id) => !!m.layer(id));
  if (ids.length === 0) return { ok: false, message: t('workspace.placeBehind.selectLayers', 'Select the text or shape layers to put behind the subject.') };
  const first = m.layer(ids[0]!)!;
  const parent = first.parent ?? first.comp;
  if (ids.some((id) => (m.layer(id)!.parent ?? m.layer(id)!.comp) !== parent)) {
    return { ok: false, message: t('workspace.placeBehind.sameParent', 'The layers must be in the same composition (and the same group).') };
  }
  const kids = childOrderOf(m, parent); // back → front
  const selectedFootage = ids.filter(isFootage);
  let footage: string | undefined;
  if (selectedFootage.length === 1 && ids.length > 1) footage = selectedFootage[0];
  else if (selectedFootage.length > 1) {
    return { ok: false, message: t('workspace.placeBehind.oneFootage', 'Select one footage layer (the subject’s) and the layers to put behind it.') };
  } else if (selectedFootage.length === 0) {
    const front = Math.max(...ids.map((id) => kids.indexOf(id)));
    for (let i = front - 1; i >= 0; i--) {
      if (isFootage(kids[i]!) && !ids.includes(kids[i]!)) {
        footage = kids[i];
        break;
      }
    }
    // Nothing under them: the nearest footage above will do (the layers drop under it).
    if (!footage) footage = kids.find((id) => isFootage(id));
  }
  if (!footage) return { ok: false, message: t('workspace.placeBehind.noFootage', 'There is no video or image layer to put them behind.') };
  const behind = kids.filter((id) => ids.includes(id) && id !== footage);
  if (behind.length === 0) return { ok: false, message: t('workspace.placeBehind.selectLayers', 'Select the text or shape layers to put behind the subject.') };
  return { ok: true, plan: { footage, behind, comp: first.comp, parent } };
}

export interface PlaceBehindResult {
  /** The footage layer whose subject they are behind. */
  subject: string;
  /** Whether the footage already had a subject (else the Object Matte tool is next). */
  hadMatte: boolean;
}

/**
 * The subject's box in composition px at comp second `time`: its outline mask
 * through the footage layer's own layer → comp matrix (the one the viewer's
 * overlays draw with). Null when there is no subject or no matrix yet.
 */
export async function subjectBoundsInComp(
  footage: string,
  time: number,
  subjects?: readonly string[],
): Promise<{ x0: number; y0: number; x1: number; y1: number; frame: { x0: number; x1: number } } | null> {
  const m = documentMirror();
  await m.loadTrees([footage]);
  // The named subjects' outlines together (default: every subject's).
  const names = new Set(subjects?.map(subjectOutlineName));
  const outlines = mirrorMasksAt(m, footage, secondsToFlicks(time)).filter((x) => {
    const id = subjectOfOutline(x.name ?? '');
    return id !== null && (names.size === 0 || names.has(x.name ?? ''));
  });
  if (outlines.length === 0) return null;
  const flat = outlines.flatMap((o) => maskPathPolyline(o, 2));
  const record = overlayLayer(MAIN_VIEWPORT, footage, secondsToFlicks(time));
  const h = layerToComp(record, false, (p) => ({ x: p.x, y: p.y }));
  if (flat.length < 6 || !h) return null;
  const toComp = (lx: number, ly: number) => {
    const w = h[6]! * lx + h[7]! * ly + h[8]!;
    return { x: (h[0]! * lx + h[1]! * ly + h[2]!) / w, y: (h[3]! * lx + h[4]! * ly + h[5]!) / w };
  };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const p = toComp(flat[i]!, flat[i + 1]!);
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
  }
  // The footage's own left / right edges in the comp (its box, layer-local).
  const b = record?.box;
  const frame = b && b.length >= 4
    ? { x0: Math.min(toComp(b[0]!, b[1]!).x, toComp(b[0]! + b[2]!, b[1]!).x), x1: Math.max(toComp(b[0]!, b[1]!).x, toComp(b[0]! + b[2]!, b[1]!).x) }
    : { x0: -Infinity, x1: Infinity };
  return { x0, y0, x1, y1, frame };
}

/** The commands that put `plan.behind` behind the footage's subject (Behind Subject + directly above it). */
export function placeBehindCommands(plan: SubjectPlan): Command[] {
  const m = documentMirror();
  const out: Command[] = plan.behind.map((id) => ({
    type: 'setProperty' as const, prop: { layer: id, path: paths.layerParam('behindSubject') }, value: { kind: 'string' as const, value: plan.footage },
  }));
  for (const id of plan.behind) {
    out.push({
      type: 'setProperty', prop: { layer: id, path: 'layer/behindSubjects' },
      value: plan.inFront && plan.inFront.length > 0 ? { kind: 'json', value: JSON.stringify(plan.inFront) } : { kind: 'json', value: 'null' },
    });
  }
  const kids = childOrderOf(m, plan.parent);
  const moving = new Set(plan.behind);
  const rest = kids.filter((id) => !moving.has(id));
  const at = rest.indexOf(plan.footage);
  const next = [...rest.slice(0, at + 1), ...plan.behind, ...rest.slice(at + 1)];
  out.push(...reorderCommands(plan.comp, plan.parent, kids, next, moving));
  return out;
}

/** Place the layers behind the subject (one entry). Null when the engine refused (already reported). */
export async function placeBehindSubjectEdit(plan: SubjectPlan): Promise<PlaceBehindResult | null> {
  const m = documentMirror();
  await m.loadTrees([plan.footage]);
  const hadMatte = mirrorMaskHeaders(m.tree(plan.footage)).some((x) => isMatteMask(x.name));
  const label = t('workspace.placeBehind.label', 'Place Behind Subject');
  const res = await edit(label, placeBehindCommands(plan));
  return res.ok ? { subject: plan.footage, hadMatte } : null;
}
