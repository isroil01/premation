/**
 * Edit ▸ Cut / Copy / Paste for keyframes and layers.
 *
 * Time discipline: the clipboard stores times RELATIVE to the earliest copied
 * keyframe, and every engine call uses LAYER time. Mixing layer and comp time
 * here silently drops easing on any layer that doesn't start at frame 0,
 * because the lookup misses and the setter returns without complaint.
 */

import {
  defaultAnimation,
  makeKeyframeId,
  parseKeyframeId,
  expandKeyframeProp,
  type EasingKind,
  type BezierHandles,
  type PropertyTrack,
} from '@motion/animation';
import { useSelectionStore } from '@stores/selectionStore';
import { useKeyframeSelectionStore } from '@stores/keyframeSelectionStore';
import { getTimelineController } from '@core/timeline/TimelineController';
import { runAnimEdit } from '@core/animation/animationCommands';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { activeCompRootId } from '@core/scene/activeComp';
import { bumpScene } from '@stores/sceneStore';
import type { SceneNode } from '@core/types';

/** Float times never compare exactly; match the engine's own tolerance. */
const T_EPSILON = 1e-6;

interface ClipboardState {
  copiedKeyframes: Array<{
    prop: string;
    relativeTime: number;
    value: number;
    easing?: EasingKind;
    bezier?: BezierHandles;
    /** Spatial motion-path tangents (value-space offsets). */
    si?: number;
    so?: number;
  }> | null;
  copiedLayers: Array<{
    node: SceneNode;
    tracks: PropertyTrack[];
  }> | null;
}

const clipboardState: ClipboardState = {
  copiedKeyframes: null,
  copiedLayers: null,
};

export function copySelection(): void {
  const kfIds = useKeyframeSelectionStore.getState().ids;
  
  if (kfIds.size > 0) {
    const copiedKfs: ClipboardState['copiedKeyframes'] = [];

    // Use the shared codec. This used to hand-parse "nodeId::prop@time", but
    // the real format is "nodeId::prop::t" — so every id failed to parse and
    // copy silently did nothing.
    const parsed = Array.from(kfIds)
      .map((id) => parseKeyframeId(id))
      .filter((x): x is NonNullable<typeof x> => x !== null)
      // A selected "Position" row stands for the x/y/z tracks.
      .flatMap(({ nodeId, prop, t }) => expandKeyframeProp(prop).map((p) => ({ nodeId, prop: p, t })));

    if (parsed.length > 0) {
      const minTime = Math.min(...parsed.map((p) => p.t));
      for (const p of parsed) {
        const trackKfs = defaultAnimation.getTrackKeyframes(p.nodeId, p.prop);
        if (!trackKfs) continue;
        const kf = trackKfs.find((k) => Math.abs(k.t - p.t) < T_EPSILON);
        if (!kf) continue;
        copiedKfs.push({
          prop: p.prop,
          relativeTime: kf.t - minTime,
          value: kf.value,
          easing: kf.easing,
          bezier: kf.bezier,
          si: kf.si,
          so: kf.so,
        });
      }

      clipboardState.copiedKeyframes = copiedKfs;
      clipboardState.copiedLayers = null;
    }
  } else {
    const { ids: layerIds } = useSelectionStore.getState();
    if (layerIds.length > 0) {
      const copiedLayers: ClipboardState['copiedLayers'] = [];
      for (const id of layerIds) {
        const original = defaultSceneGraph.getNode(id);
        if (!original) continue;
        
        // Deep clone node
        const clonedNode = JSON.parse(JSON.stringify(original)) as SceneNode;
        const tracks = defaultAnimation.tracksFor(id);
        
        copiedLayers.push({
          node: clonedNode,
          tracks: JSON.parse(JSON.stringify(tracks)) as PropertyTrack[],
        });
      }
      
      clipboardState.copiedLayers = copiedLayers;
      clipboardState.copiedKeyframes = null;
    }
  }
}

/** Is there anything to paste? Drives the Paste menu item's enabled state. */
export function hasClipboardContent(): boolean {
  return (
    (clipboardState.copiedKeyframes?.length ?? 0) > 0 || (clipboardState.copiedLayers?.length ?? 0) > 0
  );
}

/** Copy, then remove the originals (After Effects: Ctrl+X). */
export function cutSelection(): void {
  const kfIds = useKeyframeSelectionStore.getState().ids;
  copySelection();

  if (kfIds.size > 0) {
    const refs = Array.from(kfIds)
      .map((id) => parseKeyframeId(id))
      .filter((x): x is NonNullable<typeof x> => x !== null);
    if (!refs.length) return;
    runAnimEdit('Cut keyframes', () => {
      for (const ref of refs) {
        for (const prop of expandKeyframeProp(ref.prop)) {
          defaultAnimation.removeKeyframe(ref.nodeId, prop, ref.t);
        }
      }
    });
    useKeyframeSelectionStore.getState().set(new Set());
    return;
  }

  const layerIds = useSelectionStore.getState().ids;
  if (!layerIds.length) return;
  for (const id of layerIds) defaultSceneGraph.removeNode(id);
  useSelectionStore.getState().set([]);
  bumpScene();
}

export function pasteSelection(): void {
  if (clipboardState.copiedKeyframes && clipboardState.copiedKeyframes.length > 0) {
    const keyframes = clipboardState.copiedKeyframes;
    const controller = getTimelineController();
    const curTime = controller.currentSeconds;
    const selectedLayerIds = useSelectionStore.getState().ids;
    const newSelectionIds = new Set<string>();

    // AE logic: paste on selected layers if available
    if (selectedLayerIds.length === 0) return;

    runAnimEdit('Paste keyframes', () => {
      for (const layerId of selectedLayerIds) {
        for (const kf of keyframes) {
          // ONE time base for all three calls. setBezier/setSpatialTangent used
          // to be handed comp time while setKeyframe got layer time, so their
          // lookups missed and pasted keyframes silently came back linear.
          const layerT = controller.toLayerTime(layerId, curTime + kf.relativeTime);
          defaultAnimation.setKeyframe(layerId, kf.prop, layerT, kf.value, kf.easing);
          if (kf.bezier) {
            defaultAnimation.setBezier(layerId, kf.prop, layerT, kf.bezier);
          }
          if (kf.si !== undefined || kf.so !== undefined) {
            defaultAnimation.setSpatialTangent(layerId, kf.prop, layerT, { si: kf.si, so: kf.so });
          }
          newSelectionIds.add(makeKeyframeId(layerId, kf.prop, layerT));
        }
      }
    });

    if (newSelectionIds.size > 0) {
      useKeyframeSelectionStore.getState().set(newSelectionIds);
    }
  } else if (clipboardState.copiedLayers && clipboardState.copiedLayers.length > 0) {
    const newIds: string[] = [];
    const rootId = activeCompRootId();
    
    for (const item of clipboardState.copiedLayers) {
      const dupId = `${item.node.id}_paste_${Math.random().toString(36).slice(2, 6)}`;
      const dupComponents = item.node.components.map((c) => ({
        ...c,
        id: `${dupId}_${c.type}`,
        props: { ...c.props },
      }));
      
      const dupNode = {
        ...item.node,
        id: dupId,
        name: `${item.node.name ?? 'Layer'} copy`,
        parent: null as string | null,
        children: [] as string[],
        transform: {
          position: {
            x: item.node.transform.position.x + 20,
            y: item.node.transform.position.y + 20,
          },
          rotation: item.node.transform.rotation,
          scale: { ...item.node.transform.scale },
        },
        components: dupComponents,
      };
      
      defaultSceneGraph.addChild(rootId, dupNode as Parameters<typeof defaultSceneGraph.addChild>[1]);
      
      const tComp = dupComponents.find((c) => c.type === 'Transform');
      if (tComp && typeof tComp.props.x === 'number') {
        tComp.props.x = (tComp.props.x as number) + 20;
        tComp.props.y = (tComp.props.y as number) + 20;
        defaultSceneGraph.setLocalTransform(dupId, {
          x: tComp.props.x as number,
          y: tComp.props.y as number,
          rotation: (tComp.props.rotation as number) ?? 0,
        });
      }
      
      // Paste tracks wholesale — carries every keyframe field (easing, bezier,
      // roving, spatial tangents) without per-field re-assembly.
      for (const track of item.tracks) {
        defaultAnimation.setTrackKeyframes(dupId, track.prop, track.keyframes);
      }
      
      newIds.push(dupId);
    }
    
    if (newIds.length > 0) {
      useSelectionStore.getState().set(newIds);
    }
    bumpScene();
  }
}
