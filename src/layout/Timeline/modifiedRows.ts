/**
 * AE's UU — the rows of every property set away from its default, animated
 * or expression-driven — over the engine (B4 round 8). The inputs of the pure
 * rule (core/animation/modifiedRowIds.ts):
 *
 *   rows        the layer's AE row projection (`getTimelineRows`)
 *   animated    its keyed / expressed member tracks (`getMemberKeyframes`)
 *   values      the Transform members' STORED static values (`PropertyInfo.stored`)
 *   centre      the comp centre in the parent's space (the parent's matrix, `getLayerTransforms`)
 *
 * plus: any mask (the Mask Shape row), and every other row whose member's
 * stored static value differs from its default.
 */

import { secondsToFlicks } from '@motion/engine-api';
import { Matrix } from '@motion/scene';
import { engine } from '@core/engine/engineInstance';
import { modifiedRowIds, TRANSFORM_GROUPS } from '@core/animation/modifiedRowIds';
import { storedNumber, trackRefIn } from '@core/mirror/trackIndex';
import { mirrorPropertyMeta } from '@core/mirror/metaFacts';
import { documentMirror } from '@stores/documentMirror';
import { fetchMemberTracks } from '@stores/memberTracks';
import { fetchTimelineRows } from '@stores/timelineRows';
import { mirrorTreeOf } from '@stores/trackValues';

const EPS = 1e-6;

async function parentMatrix(parent: string | undefined, seconds: number): Promise<{ a: number; b: number; c: number; d: number; e: number; f: number } | null> {
  if (!parent) return null;
  const res = await engine().query({ type: 'getLayerTransforms', layers: [parent], time: secondsToFlicks(seconds) });
  const m = res.ok ? res.value.transforms[0]?.matrix : undefined;
  return m && m.length >= 16 ? { a: m[0]!, b: m[1]!, c: m[4]!, d: m[5]!, e: m[12]!, f: m[13]! } : null;
}


/** The layer's modified row ids at comp `seconds` ([] for a layer the engine does not know). */
export async function modifiedRowsOf(nodeId: string, seconds: number): Promise<string[]> {
  const m = documentMirror();
  const layer = m.layer(nodeId);
  if (!layer) return [];
  const [rowsBy, tree, members] = await Promise.all([fetchTimelineRows([nodeId]), mirrorTreeOf(nodeId), fetchMemberTracks(nodeId)]);
  const rows = rowsBy.get(nodeId) ?? [];
  const animated = new Set(members.filter((t) => t.keyframes.length > 0 || t.hasExpression).map((t) => t.member as string));
  const values: Record<string, number | undefined> = {};
  for (const group of TRANSFORM_GROUPS) {
    for (const member of group.members) {
      const r = trackRefIn(tree, member);
      if (r?.info.stored) values[member] = storedNumber(r, r.info.value);
    }
  }
  const settings = m.comp(layer.comp)?.settings;
  const centreComp = { x: (settings?.width ?? 1920) / 2, y: (settings?.height ?? 1080) / 2 };
  const pm = await parentMatrix(layer.parent, seconds);
  const centre = pm ? Matrix.transformPoint(Matrix.invert(pm), centreComp) : centreComp;
  const out = new Set(modifiedRowIds({ values, animated, centre }));
  for (const row of rows) {
    if (row.maskTrack) {
      out.add(row.prop);
      continue;
    }
    if (row.group === 'transform' || row.group === 'masks') continue;
    // A member set away from the registry's default (unstored = at its default), as the legacy rule compared.
    if (row.members.some((member) => {
      const r = trackRefIn(tree, member);
      const d = mirrorPropertyMeta(member, layer, tree).defaultValue;
      if (!r?.info.stored || typeof d !== 'number') return false;
      const v = storedNumber(r, r.info.value);
      return v !== undefined && Math.abs(v - d) > EPS;
    })) out.add(row.prop);
  }
  return [...out];
}
