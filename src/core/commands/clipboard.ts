/* eslint-disable no-restricted-syntax -- F11: SAFE, verified.
 * Mutates `JSON.parse(JSON.stringify(original))` — a deep clone made at
 * clipboard.ts:98 — not a live graph node. Nudging the pasted copy by 20px is
 * applied before the clone is inserted. */
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
} from '@motion/animation';
import { useSelectionStore } from '@stores/selectionStore';
import { useKeyframeSelectionStore } from '@stores/keyframeSelectionStore';
import { getTimelineController, compToKeyframeTime } from '@core/timeline/TimelineController';
import { runAnimEdit } from '@core/animation/animationCommands';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { activeCompRootId } from '@core/scene/activeComp';
import { bumpScene } from '@stores/sceneStore';
import { snapshotNodeAnimation, applyNodeAnimation, type NodeAnimationSnapshot } from '@core/animation/cloneNodeAnimation';
import { insertSvgShapeGroup } from '@core/scene/sceneInsert';
import type { SceneNode } from '@core/types';

/** Float times never compare exactly; match the engine's own tolerance. */
const T_EPSILON = 1e-6;

/**
 * Pull an `<svg>…</svg>` fragment out of clipboard text / HTML.
 * Figma and browsers often put `image/svg+xml` or wrap SVG in HTML; Illustrator
 * sometimes pastes plain SVG markup as `text/plain`.
 */
export function extractSvgMarkup(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  if (/^<\?xml/i.test(text) || /^<!DOCTYPE\s+svg/i.test(text) || /^<svg[\s>]/i.test(text)) {
    const m = text.match(/<svg\b[\s\S]*?<\/svg>/i);
    return m ? m[0] : null;
  }
  const embedded = text.match(/<svg\b[\s\S]*?<\/svg>/i);
  return embedded ? embedded[0] : null;
}

/** Read SVG markup from the OS clipboard, if any. */
export async function readOsClipboardSvg(): Promise<string | null> {
  if (typeof navigator === 'undefined' || !navigator.clipboard) return null;

  // Prefer typed clipboard items (Figma / Chrome often expose image/svg+xml).
  try {
    const read = navigator.clipboard.read?.bind(navigator.clipboard);
    if (read) {
      const items = await read();
      for (const item of items) {
        const svgType = item.types.find(
          (t) => t === 'image/svg+xml' || t === 'text/html' || t === 'text/plain',
        );
        if (!svgType) continue;
        const blob = await item.getType(svgType);
        const text = await blob.text();
        const svg = extractSvgMarkup(text);
        if (svg) return svg;
      }
    }
  } catch {
    // Permission denied or unsupported — fall through to readText.
  }

  try {
    const text = await navigator.clipboard.readText();
    return extractSvgMarkup(text);
  } catch {
    return null;
  }
}

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
    continuous?: boolean;
    roving?: boolean;
  }> | null;
  copiedLayers: Array<{
    node: SceneNode;
    animation: NodeAnimationSnapshot;
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
          continuous: kf.continuous,
          roving: kf.roving,
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
        
        // Deep clone node. Animation is snapshotted separately so paste still
        // works after the original is deleted (Cut, or a later Delete).
        const clonedNode = JSON.parse(JSON.stringify(original)) as SceneNode;
        copiedLayers.push({
          node: clonedNode,
          animation: snapshotNodeAnimation(id),
        });
      }
      
      clipboardState.copiedLayers = copiedLayers;
      clipboardState.copiedKeyframes = null;
    }
  }
}

/** Is there anything in the *internal* clipboard? (OS SVG is checked async on paste.) */
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

export type PasteResult = 'keyframes' | 'layers' | 'svg' | null;

/**
 * Paste internal clipboard first (keyframes → layers). If empty, try OS
 * clipboard SVG → editable shape group (AE 26.3 paste Illustrator/SVG).
 */
export async function pasteSelection(): Promise<PasteResult> {
  if (clipboardState.copiedKeyframes && clipboardState.copiedKeyframes.length > 0) {
    const keyframes = clipboardState.copiedKeyframes;
    const controller = getTimelineController();
    const curTime = controller.currentSeconds;
    const selectedLayerIds = useSelectionStore.getState().ids;
    const newSelectionIds = new Set<string>();

    // AE logic: paste on selected layers if available
    if (selectedLayerIds.length === 0) return null;

    runAnimEdit('Paste keyframes', () => {
      for (const layerId of selectedLayerIds) {
        // The playhead converts to the TARGET's canonical keyframe time once;
        // `relativeTime` is already keyframe-axis spacing, so it adds directly.
        const base = compToKeyframeTime(layerId, curTime);
        for (const kf of keyframes) {
          // ONE time base for all three calls. setBezier/setSpatialTangent used
          // to be handed comp time while setKeyframe got layer time, so their
          // lookups missed and pasted keyframes silently came back linear.
          const layerT = base + kf.relativeTime;
          defaultAnimation.setKeyframe(layerId, kf.prop, layerT, kf.value, kf.easing);
          if (kf.bezier) {
            defaultAnimation.setBezier(layerId, kf.prop, layerT, kf.bezier);
          }
          if (kf.si !== undefined || kf.so !== undefined) {
            defaultAnimation.setSpatialTangent(layerId, kf.prop, layerT, { si: kf.si, so: kf.so });
          }
          if (kf.continuous !== undefined || kf.roving !== undefined) {
            defaultAnimation.updateKeyframe(layerId, kf.prop, layerT, {
              continuous: kf.continuous,
              roving: kf.roving,
            });
          }
          newSelectionIds.add(makeKeyframeId(layerId, kf.prop, layerT));
        }
      }
    });

    if (newSelectionIds.size > 0) {
      useKeyframeSelectionStore.getState().set(newSelectionIds);
    }
    return 'keyframes';
  }

  if (clipboardState.copiedLayers && clipboardState.copiedLayers.length > 0) {
    const newIds: string[] = [];
    const rootId = activeCompRootId();
    
    for (const item of clipboardState.copiedLayers) {
      const dupId = `${item.node.id}_paste_${Math.random().toString(36).slice(2, 6)}`;
      const dupComponents = item.node.components.map((c) => ({
        ...c,
        id: `${dupId}_${c.type}`,
        // Deep-clone so a second paste does not share nested fx / pathOps /
        // puppet state with the first paste (or the clipboard).
        props: structuredClone(c.props),
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
      
      // Paste tracks wholesale — property keyframes, data tracks (Source Text,
      // puppet pins) and expressions. A property-track-only paste left the
      // copy looking like a bare object with none of the original's motion.
      applyNodeAnimation(dupId, item.animation);
      
      newIds.push(dupId);
    }
    
    if (newIds.length > 0) {
      useSelectionStore.getState().set(newIds);
    }
    bumpScene();
    return 'layers';
  }

  // AE 26.3: paste SVG / Illustrator markup from the OS as editable shapes.
  const svg = await readOsClipboardSvg();
  if (!svg) return null;
  const id = insertSvgShapeGroup(svg, 'Pasted SVG');
  if (!id) return null;
  useSelectionStore.getState().set([id]);
  return 'svg';
}
