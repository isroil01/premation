/**
 * The multicam angle cut through the engine API (B4 round 5): hold-keyframe
 * every angle's Opacity at the playhead so only the chosen angle is visible
 * from there to the next cut — ONE `addKeyframes`, one undo entry. The angles
 * come from the document mirror (`mirrorMulticamAngles`: the active
 * composition's layers tagged `multicamAngle`).
 */

import { secondsToFlicks, type KeyframeInsert } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import { FragmentBuilder } from '@/engine-client/fragmentBuilder';
import { pasteBuilt } from '@/engine-client/insertFragment';
import { buildMulticamAngles } from '@/engine-client/multicamFragment';
import { DEFAULT_COMPOSITION } from '@stores/compositionStore';
import type { ImportedAsset } from '@stores/assetStore';
import { edit } from '@core/engine/uiEdits';
import { mirrorMulticamAngles, type MulticamAngle } from '@core/mirror/multicam';
import { documentMirror } from '@stores/documentMirror';
import { getTime } from '@stores/playbackClockStore';
import { activeCompIdNow } from '@hooks/useMirror';
import { trackWrites } from '@layout/Inspector/inspectorEdits';

/** The active composition's multicam angles, by angle number. */
export function activeMulticamAngles(): MulticamAngle[] {
  return mirrorMulticamAngles(documentMirror(), activeCompIdNow() ?? '');
}

/**
 * Cut to `angle` (1-based) at `seconds` (default: the playhead): Opacity 100
 * on that angle, 0 on the others, as hold keys. Resolves false when there is
 * no such angle or the engine refused (toasted by `edit`).
 */
export async function switchMulticamAngleEdit(
  angle: number,
  angles: ReadonlyArray<Pick<MulticamAngle, 'id' | 'angle'>> = activeMulticamAngles(),
  seconds: number = getTime(),
): Promise<boolean> {
  const target = angles.find((a) => a.angle === angle);
  if (!target) return false;
  const keys: KeyframeInsert[] = [];
  for (const a of angles) {
    for (const w of trackWrites(a.id, { opacity: a.id === target.id ? 100 : 0 }, seconds)) {
      keys.push({ prop: w.prop, time: w.time!, value: w.value, easing: 'hold', spatialIn: [], spatialOut: [] });
    }
  }
  if (keys.length === 0) return false;
  const res = await edit(`Multicam cut → angle ${angle}`, { type: 'addKeyframes', keys });
  return res.ok;
}

/**
 * New Multicam from Library through the ENGINE (the owner-write audit: the
 * page builder wrote the composition and its layers into the replica only) —
 * ONE history entry (an engine gesture): a composition the size, rate and
 * length of the angles (createMulticamComposition's rules), then every angle
 * as a full-frame footage layer tagged with its angle number
 * (`__multicamAngle`), angle 1 visible and the rest at opacity 0, laid into a
 * scratch fragment and pasted as one `pasteLayers`. Resolves to the composition id.
 */
export async function createMulticamEdit(assets: readonly ImportedAsset[], name = 'Multicam'): Promise<string | null> {
  const videos = assets.filter((a) => a.type === 'video' || a.type === 'image');
  if (videos.length < 2) return null;
  const primary = videos[0]!;
  const meta = primary.metadata ?? {};
  const par = primary.interpret?.par && primary.interpret.par > 0 ? primary.interpret.par : 1;
  // The engine's composition bounds (4…30000 px).
  const width = Math.max(4, Math.min(30000, meta.width && meta.width > 0 ? Math.round(meta.width * par) : DEFAULT_COMPOSITION.width));
  const height = Math.max(4, Math.min(30000, meta.height && meta.height > 0 ? meta.height : DEFAULT_COMPOSITION.height));
  const longest = Math.max(0, ...videos.map((a) => a.metadata?.duration ?? 0));
  const durationSeconds = longest > 0 ? longest : DEFAULT_COMPOSITION.durationSeconds;
  const fps = meta.fps && meta.fps > 0 ? meta.fps : DEFAULT_COMPOSITION.fps;
  const e = engine();
  const began = await e.execute({ type: 'beginGesture', label: 'New Multicam' });
  if (!began.ok) return null;
  let comp: string | null = null;
  let ok = false;
  try {
    const made = await e.execute({
      type: 'createComposition',
      settings: {
        name: `${name} (${videos.length} angles)`,
        width,
        height,
        frameRate: { num: Math.round(fps * 1000), den: 1000 },
        duration: secondsToFlicks(durationSeconds),
      },
      fromItems: [],
    });
    if (!made.ok) return null;
    comp = made.value.item;
    const target = comp;
    const b = new FragmentBuilder({ idPrefix: 'mc' });
    buildMulticamAngles(b, target, videos, width, height);
    const ids = await pasteBuilt('New Multicam', target, b.build());
    ok = !!ids && ids.length === videos.length;
  } finally {
    await e.execute({ type: 'endGesture', gesture: began.value.gesture, commit: ok });
  }
  if (ok && comp) await e.execute({ type: 'setActiveComposition', comp });
  return ok ? comp : null;
}
