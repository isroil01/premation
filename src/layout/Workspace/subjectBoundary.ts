/**
 * The subjects' boundaries on screen (After Effects draws a selected subject
 * in magenta while a Roto Brush / Object Matte tool is up): each subject's
 * outline — its outline mask at the frame on screen — as an SVG path in the
 * overlay's own screen space, in the subject's colour. The Object Matte
 * overlay and the brush overlay both draw them, so the selection stays
 * visible while it is edited.
 */

import { secondsToFlicks } from '@motion/engine-api';
import { maskPathPolyline } from '@core/effects/mask';
import { mirrorMasksAt } from '@core/mirror/masks';
import { subjectOfOutline } from '@core/workspace/subjects';
import { documentMirror } from '@stores/documentMirror';

type Pt = { x: number; y: number };

/** One subject's outline at a frame: layer-local px (x y pairs), its path data on screen and its screen box. */
export interface SubjectBoundary {
  subject: string;
  local: number[];
  d: string;
  box: { x0: number; y0: number; x1: number; y1: number };
}

/** Every subject's outline of `nodeId` at comp second `time`, via `toScreen` (layer-local px → overlay px). */
export function subjectBoundaries(nodeId: string, time: number, toScreen: (x: number, y: number) => Pt): SubjectBoundary[] {
  const out: SubjectBoundary[] = [];
  for (const mask of mirrorMasksAt(documentMirror(), nodeId, secondsToFlicks(time))) {
    const subject = subjectOfOutline(mask.name ?? '');
    if (!subject) continue;
    const flat = maskPathPolyline(mask, 4);
    if (flat.length < 6) continue;
    let d = '';
    const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const s = toScreen(flat[i]!, flat[i + 1]!);
      d += `${i === 0 ? 'M' : 'L'} ${s.x.toFixed(1)} ${s.y.toFixed(1)} `;
      box.x0 = Math.min(box.x0, s.x); box.x1 = Math.max(box.x1, s.x);
      box.y0 = Math.min(box.y0, s.y); box.y1 = Math.max(box.y1, s.y);
    }
    out.push({ subject, local: flat, d: `${d}Z`, box });
  }
  return out;
}

/** All the subjects' outlines as one path ('' when there are none). */
export function subjectBoundaryPath(nodeId: string, time: number, toScreen: (x: number, y: number) => Pt): string {
  return subjectBoundaries(nodeId, time, toScreen).map((b) => b.d).join(' ');
}

/** Whether layer-local `p` lies inside the outline (x y pairs, even-odd). */
export function insideOutline(flat: readonly number[], p: Pt): boolean {
  let inside = false;
  for (let i = 0, j = flat.length - 2; i + 1 < flat.length; j = i, i += 2) {
    const xi = flat[i]!, yi = flat[i + 1]!, xj = flat[j]!, yj = flat[j + 1]!;
    if ((yi > p.y) !== (yj > p.y) && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
