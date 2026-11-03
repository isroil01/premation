/**
 * A footage layer's SUBJECTS — several per layer, each a soft matte of its own
 * (the engine's setLayerMatte `subject`, native/engine/src/core/subjects.hpp).
 * Each has an entry in `layer/subjects` (name, colour, shown, locked, and its
 * live edge: feather, choke, contrast, temporal smooth, invert) and an outline
 * mask ("Object Matte" for the first, "Object Matte <id>" for the others) that
 * the viewer draws and Freeze locks.
 *
 * This file reads them from the document mirror and builds the commands that
 * change them; the UI sends the commands (one undo entry each).
 */

import type { Command } from '@motion/engine-api';
import { documentMirror } from '@stores/documentMirror';
import { mirrorEffects, mirrorMaskHeaders } from '@core/mirror/effects';
import type { Effect } from '@core/inspector/effectCatalog';
import { plainValue } from '@core/mirror/trackIndex';
import { values } from '@core/engine/propRefs';

export const FIRST_SUBJECT = 's1';
export const SUBJECTS_PATH = 'layer/subjects';

/** One subject's entry (layer/subjects). Edge values: feather / choke px, contrast / smooth 0–100. */
export interface Subject {
  id: string;
  name: string;
  color: string;
  hidden?: boolean;
  locked?: boolean;
  invert?: boolean;
  feather?: number;
  choke?: number;
  contrast?: number;
  smooth?: number;
}

export type SubjectEdge = Pick<Subject, 'feather' | 'choke' | 'contrast' | 'smooth' | 'invert'>;

/** The outline mask a subject's edits keep (the engine's subject_outline_name). */
export function subjectOutlineName(id: string): string {
  return id === FIRST_SUBJECT ? 'Object Matte' : `Object Matte ${id}`;
}

/** The subject an outline mask belongs to, from its name; null for any other mask. */
export function subjectOfOutline(name: string): string | null {
  if (name === 'Object Matte') return FIRST_SUBJECT;
  const m = /^Object Matte ([A-Za-z0-9_-]{1,32})$/.exec(name);
  return m ? m[1]! : null;
}

/** The colours a new subject is given in turn (the engine's setLayerMatte uses the same list); document data, not theme. */
export const SUBJECT_PALETTE: readonly string[] = ['#ff3fd4', '#ffb547', '#34d1bf', '#7fb2ff', '#a6e22e', '#ff6b6b', '#c792ea', '#f2f2f2'];
const PALETTE = SUBJECT_PALETTE;

function isSubject(v: unknown): v is Subject {
  return !!v && typeof v === 'object' && typeof (v as Subject).id === 'string' && typeof (v as Subject).name === 'string';
}

/**
 * The layer's subjects, in panel order. A layer selected before subjects had
 * entries (frames, an "Object Matte" outline, no `layer/subjects`) has one,
 * "Subject 1". Empty when the layer's property tree has not arrived.
 */
export function layerSubjects(nodeId: string): Subject[] {
  const tree = documentMirror().tree(nodeId);
  if (!tree) return [];
  const raw = plainValue(tree.nodes.get(SUBJECTS_PATH)?.value);
  const list = Array.isArray(raw) ? raw.filter(isSubject).map((s) => ({ ...s, color: typeof s.color === 'string' ? s.color : PALETTE[0]! })) : [];
  if (list.length > 0) return list;
  const legacy = mirrorMaskHeaders(tree).some((m) => m.name === 'Object Matte');
  return legacy ? [{ id: FIRST_SUBJECT, name: 'Subject 1', color: PALETTE[0]! }] : [];
}

/** The outline mask id of each subject on the layer (subject id → mask id). */
export function subjectOutlines(nodeId: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of mirrorMaskHeaders(documentMirror().tree(nodeId))) {
    const id = subjectOfOutline(m.name);
    if (id && !out.has(id)) out.set(id, m.id);
  }
  return out;
}

/** An id no subject of the layer has: s1, s2, … */
export function newSubjectId(nodeId: string): string {
  const used = new Set(layerSubjects(nodeId).map((s) => s.id));
  for (const id of subjectOutlines(nodeId).keys()) used.add(id);
  let n = 1;
  while (used.has(`s${n}`)) n++;
  return `s${n}`;
}

/** The command that writes the layer's whole subject list. */
function writeList(nodeId: string, list: readonly Subject[]): Command {
  return { type: 'setProperty', prop: { layer: nodeId, path: SUBJECTS_PATH }, value: values.json(list) };
}

/** Change one subject's entry (name, colour, shown, locked, edge). Empty when it is not on the layer. */
export function updateSubjectCommands(nodeId: string, id: string, patch: Partial<Omit<Subject, 'id'>>): Command[] {
  const list = layerSubjects(nodeId);
  const at = list.findIndex((s) => s.id === id);
  if (at < 0) return [];
  const next = list.map((s, i) => (i === at ? { ...s, ...patch } : s));
  const commands: Command[] = [writeList(nodeId, next)];
  // Lock = Freeze: the subject's outline is locked too, so every edit of it refuses (rotoBrushTool).
  if (patch.locked !== undefined) {
    const mask = subjectOutlines(nodeId).get(id);
    if (mask) commands.push({ type: 'setProperty', prop: { layer: nodeId, path: `masks/${mask}/locked` }, value: values.bool(patch.locked) });
  }
  return commands;
}

/** Move a subject up (−1) or down (+1) the list: the order the panel and the depth stack show. */
export function moveSubjectCommands(nodeId: string, id: string, by: -1 | 1): Command[] {
  const list = layerSubjects(nodeId);
  const at = list.findIndex((s) => s.id === id);
  const to = at + by;
  if (at < 0 || to < 0 || to >= list.length) return [];
  const next = [...list];
  [next[at], next[to]] = [next[to]!, next[at]!];
  return [writeList(nodeId, next)];
}

/** Move subject `id` to index `to` of the panel order (a drag in the list). */
export function moveSubjectToCommands(nodeId: string, id: string, to: number): Command[] {
  const list = layerSubjects(nodeId);
  const at = list.findIndex((s) => s.id === id);
  if (at < 0 || to < 0 || to >= list.length || to === at) return [];
  const next = [...list];
  const [moved] = next.splice(at, 1);
  next.splice(to, 0, moved!);
  return [writeList(nodeId, next)];
}

/** The layer's effects that read `id` alone (its styles: Compositing Options ▸ subjectId). */
export function subjectEffects(nodeId: string, id: string): Effect[] {
  return mirrorEffects(documentMirror().tree(nodeId)).filter((e) => e.subjectId === id);
}

/** Delete a subject: its frames, its entry, its outline and the styles that were its alone. */
export function removeSubjectCommands(nodeId: string, id: string): Command[] {
  const commands: Command[] = [{ type: 'setLayerMatte', layer: nodeId, frames: [], merge: false, subject: id }];
  const groups = subjectEffects(nodeId, id).map((e) => ({ layer: nodeId, path: `effects/${e.id}` }));
  const mask = subjectOutlines(nodeId).get(id);
  if (mask) groups.push({ layer: nodeId, path: `masks/${mask}` });
  if (groups.length > 0) commands.push({ type: 'removePropertyGroups', groups });
  return commands;
}

/** Whether the subject is locked (its entry, or its outline mask's lock from Freeze). */
export function subjectLocked(nodeId: string, id: string): boolean {
  if (layerSubjects(nodeId).find((s) => s.id === id)?.locked) return true;
  const mask = subjectOutlines(nodeId).get(id);
  const tree = documentMirror().tree(nodeId);
  return !!mask && plainValue(tree?.nodes.get(`masks/${mask}/locked`)?.value) === true;
}

/** The value an edge field shows when the entry does not set it. */
export const EDGE_DEFAULTS: Required<SubjectEdge> = { feather: 0, choke: 0, contrast: 0, smooth: 0, invert: false };
