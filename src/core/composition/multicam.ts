/**
 * Multicam — stack synced video angles in one comp and cut by opacity.
 *
 * What exists: N footage assets → one composition of full-frame layers, only
 * one angle at 100% opacity; a cut at the playhead writes hold keyframes;
 * `alignMulticamByAudio` cross-correlates the angles' soundtracks and shifts
 * their clip bars into sync (the Premiere "synchronize by audio" gesture);
 * the Multicam Viewer (layout/Multicam) shows every angle and cuts on click.
 *
 * Still not Premiere Multicam: no nested multicam sequence object, no
 * per-angle flattening. The cut list IS the opacity hold keyframes.
 */

import type { ImportedAsset } from '@stores/assetStore';
import { createOrAdoptComposition } from '@core/composition/compositionOps';
import { DEFAULT_COMPOSITION } from '@stores/compositionStore';
import { insertMedia } from '@core/scene/sceneInsert';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { flattenScene, readNodeKind } from '@core/scene/sceneDerive';
import { defaultAnimation } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { compToKeyframeTime, getTimelineController } from '@core/timeline/TimelineController';
import { useWorkspaceStore } from '@stores/projectStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useAssetStore } from '@stores/assetStore';
import { bumpScene } from '@stores/sceneStore';
import { assetIdOf } from '@core/source/sourceInfo';
import { audioEngine } from '@core/audio/AudioEngine';
import { framesToSeconds } from '@motion/timeline';
import { rmsEnvelope, bestLagSeconds, mixToMonoChannels, ENVELOPE_HZ } from './multicamSync';

export const MULTICAM_ANGLE_PROP = '__multicamAngle';

/**
 * Build a multicam composition from video/image assets. Layers are stacked
 * in asset order (first = angle 1). Returns the new comp id + layer ids.
 */
export async function createMulticamComposition(
  assets: readonly ImportedAsset[],
  name = 'Multicam',
): Promise<{ compId: string; layerIds: string[] }> {
  const videos = assets.filter((a) => a.type === 'video' || a.type === 'image');
  if (videos.length < 2) throw new Error('Multicam needs at least two video/image assets.');

  const primary = videos[0]!;
  const meta = primary.metadata ?? {};
  const defaults = DEFAULT_COMPOSITION;
  const width = meta.width && meta.width > 0 ? meta.width : defaults.width;
  const height = meta.height && meta.height > 0 ? meta.height : defaults.height;
  const durationSeconds = Math.max(
    defaults.durationSeconds,
    ...videos.map((a) => a.metadata?.duration ?? 0),
  );
  const fps = meta.fps && meta.fps > 0 ? meta.fps : defaults.fps;

  const compId = createOrAdoptComposition({
    name: `${name} (${videos.length} angles)`,
    width,
    height,
    durationSeconds,
    fps,
  });

  const layerIds: string[] = [];
  for (let i = 0; i < videos.length; i++) {
    await insertMedia(videos[i]!);
    const id = useSelectionStore.getState().ids[0];
    if (!id) continue;
    layerIds.push(id);
    const node = defaultSceneGraph.getNode(id);
    if (!node) continue;
    // node.components is a throwaway VIEW — mutating it (or a made-up
    // node.metadata) silently persists nothing. Writes go through writeProp,
    // same as App.tsx's __muted flag.
    const transform = node.components.find((c) => c.type === 'Transform');
    if (transform) defaultSceneGraph.writeProp(id, transform.id, MULTICAM_ANGLE_PROP, i + 1);
    const style = node.components.find((c) => c.type === 'Style');
    if (style) defaultSceneGraph.writeProp(id, style.id, 'opacity', i === 0 ? 100 : 0);
  }

  bumpScene();
  return { compId, layerIds };
}

/** Tagged multicam layers in the active scene, ordered by angle. */
export function multicamLayersInActiveComp(): Array<{ id: string; angle: number; name: string }> {
  const out: Array<{ id: string; angle: number; name: string }> = [];
  for (const n of flattenScene(defaultSceneGraph)) {
    const kind = readNodeKind(n);
    if (kind !== 'video' && kind !== 'image') continue;
    const angle = (n.components.find((c) => c.type === 'Transform')?.props as
      | Record<string, unknown>
      | undefined)?.[MULTICAM_ANGLE_PROP];
    if (typeof angle !== 'number') continue;
    out.push({ id: n.id, angle, name: n.name ?? n.id });
  }
  return out.sort((a, b) => a.angle - b.angle);
}

export interface MulticamSyncReport {
  /** Angles whose bars moved. */
  shifted: number;
  /** Per-angle outcome, angle order. */
  angles: Array<{ angle: number; name: string; offsetSec: number; score: number; note?: string }>;
  /** Human-readable summary for a toast. */
  note: string;
}

/** Below this peak NCC an alignment is a guess, not a measurement. */
const SYNC_MIN_SCORE = 0.3;
/** Cameras on one shoot start within this window of each other. Caps the
 *  O(N·lags) correlation so hour-long takes stay interactive. */
const SYNC_MAX_LAG_SECONDS = 120;

/**
 * Synchronize the multicam angles by their soundtracks (Premiere's
 * "Synchronize > Audio"): RMS-envelope cross-correlation of every angle
 * against angle 1, then the clip bars shift so common events line up. The
 * earliest bar lands at 0 (the timeline cannot host negative starts), so
 * angle 1 itself may move — relative alignment is what sync means.
 *
 * Angles whose audio fails to decode (a silent B-cam) or correlate below
 * confidence keep their current start and say so in the report.
 */
export async function alignMulticamByAudio(): Promise<MulticamSyncReport> {
  const layers = multicamLayersInActiveComp();
  if (layers.length < 2) {
    return { shifted: 0, angles: [], note: 'Need at least two multicam angles.' };
  }

  const controller = getTimelineController();
  const fr = controller.timeline.getFrameRate();

  // Decode every angle's audio into an alignment envelope, in parallel.
  const envs = await Promise.all(layers.map(async (l) => {
    const node = defaultSceneGraph.getNode(l.id);
    const assetId = node ? assetIdOf(node) : null;
    const asset = assetId ? useAssetStore.getState().assets.find((a) => a.id === assetId) : null;
    if (!assetId || !asset?.src) return null;
    const loaded = await audioEngine.load(assetId, asset.src);
    if (!loaded) return null;
    const channels: Float32Array[] = [];
    for (let c = 0; c < loaded.buffer.numberOfChannels; c++) channels.push(loaded.buffer.getChannelData(c));
    const mono = mixToMonoChannels(channels, loaded.buffer.length);
    return rmsEnvelope(mono, loaded.buffer.sampleRate, ENVELOPE_HZ);
  }));

  const refEnv = envs[0];
  const refLayer = controller.getLayersForNode(layers[0]!.id)[0];
  if (!refEnv || !refLayer) {
    return {
      shifted: 0,
      angles: [],
      note: 'Angle 1 has no decodable audio — nothing to align against.',
    };
  }
  const refStartSec = framesToSeconds(refLayer.start, fr);

  // Desired ABSOLUTE start per angle. Angle k's content at time e_k matches
  // angle 1's at e_1 with lag = e_k − e_1, so bar k starts at s_1 − lag.
  const report: MulticamSyncReport['angles'] = [
    { angle: layers[0]!.angle, name: layers[0]!.name, offsetSec: 0, score: 1 },
  ];
  const targets = new Map<string, number>([[layers[0]!.id, refStartSec]]);
  for (let i = 1; i < layers.length; i++) {
    const l = layers[i]!;
    const env = envs[i];
    const bar = controller.getLayersForNode(l.id)[0];
    const entry: MulticamSyncReport['angles'][number] = { angle: l.angle, name: l.name, offsetSec: 0, score: 0 };
    report.push(entry);
    if (!env || !bar) {
      entry.note = env ? 'no clip bar' : 'no decodable audio';
      continue;
    }
    const { lagSec, score } = bestLagSeconds(refEnv, env, ENVELOPE_HZ, SYNC_MAX_LAG_SECONDS);
    entry.score = score;
    if (score < SYNC_MIN_SCORE) {
      entry.note = 'no confident audio match';
      continue;
    }
    entry.offsetSec = -lagSec;
    targets.set(l.id, refStartSec - lagSec);
  }

  // Normalize so the earliest aligned bar sits at 0, keeping every relative
  // offset — setLayerStart clamps at 0, which would otherwise silently
  // truncate the alignment instead of sliding the group.
  const minStart = Math.min(...targets.values());
  let shifted = 0;
  for (const l of layers) {
    const want = targets.get(l.id);
    const bar = controller.getLayersForNode(l.id)[0];
    if (want === undefined || !bar) continue;
    const next = want - Math.min(0, minStart);
    if (Math.abs(next - framesToSeconds(bar.start, fr)) < 0.5 / fr.fps) continue;
    controller.setClipStart(bar.id, next);
    shifted += 1;
  }

  const misses = report.filter((r) => r.note).length;
  const note =
    shifted === 0
      ? misses > 0
        ? 'No angles moved — audio failed to match. Align manually via a clap/slate frame.'
        : 'Angles already in sync.'
      : `Synced ${shifted} angle${shifted === 1 ? '' : 's'} by audio${misses ? ` (${misses} not matched)` : ''}.`;
  return { shifted, angles: report, note };
}

/**
 * Cut to `angle` (1-based) at the playhead: hold-keyframe opacity so only
 * that angle is visible from here forward until the next cut.
 */
export function switchMulticamAngle(angle: number): boolean {
  const layers = multicamLayersInActiveComp();
  if (layers.length === 0) return false;
  // Plain function — read the store, don't call the React hook.
  const ws = useWorkspaceStore.getState();
  const t = (ws.activeTabId ? ws.tabs[ws.activeTabId]?.time : 0) ?? 0;
  const target = layers.find((l) => l.angle === angle);
  if (!target) return false;

  runAnimEdit(`Multicam cut → angle ${angle}`, () => {
    defaultAnimation.batch(() => {
      for (const layer of layers) {
        const opacity = layer.id === target.id ? 100 : 0;
        // Keyframes live on the per-node keyframe axis, not raw comp time —
        // equal for a full-frame angle starting at 0, but the conversion is
        // the contract every other keyframe write in the app honours.
        defaultAnimation.setKeyframe(layer.id, 'opacity', compToKeyframeTime(layer.id, t), opacity, 'hold');
      }
    });
  });
  bumpScene();
  return true;
}
