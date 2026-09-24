/* eslint-disable no-restricted-syntax -- F11: SAFE, verified.
 * Mutates a plain snapshot built in `copySelection` (getters read off the live
 * view, props structuredClone'd) — not a live graph node. Nudging the pasted
 * copy by 20px is applied before the clone is inserted. */
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
  expandKeyframeProp,
  type EasingKind,
  type BezierHandles,
  type SpatialInterp,
} from '@motion/animation';
import { useSelectionStore } from '@stores/selectionStore';
import { useKeyframeSelectionStore } from '@stores/keyframeSelectionStore';
import { documentMirror } from '@stores/documentMirror';
import { selectionStoredRefs, trackSelectionId } from '@core/mirror/keySelection';
import { getTimelineController, compToKeyframeTime } from '@core/timeline/TimelineController';
import { runAnimEdit } from '@core/animation/animationCommands';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { activeCompRootId } from '@core/scene/activeComp';
import { bumpScene } from '@stores/sceneStore';
import { snapshotNodeAnimation, applyNodeAnimation, type NodeAnimationSnapshot } from '@core/animation/cloneNodeAnimation';
import { insertSvgDocument } from '@core/scene/sceneInsert';
import type { SceneNode } from '@core/types';
import { copyPathFromSelection, pastePathEdit } from '@core/workspace/pathCommands';

/** Float times never compare exactly; match the engine's own tolerance. */
const T_EPSILON = 1e-6;

/**
 * Pull the first `<svg>…</svg>` element out of `raw`, wherever it sits.
 *
 * Depth-aware, not a lazy regex: an exported document can NEST `<svg>` (Figma
 * frames, sprite sheets, Illustrator symbols), and `<svg[\s\S]*?</svg>` would
 * cut it off at the inner close tag and hand the importer a broken document.
 * Returns null when there is no complete element.
 */
export function extractSvgMarkup(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  const openRe = /<svg\b/gi;
  const start = text.search(openRe);
  if (start < 0) return null;
  // Walk tags from the first `<svg`, counting opens and closes.
  const tagRe = /<(\/?)svg\b[^>]*?(\/?)>/gi;
  tagRe.lastIndex = start;
  let depth = 0;
  for (let m = tagRe.exec(text); m; m = tagRe.exec(text)) {
    const closing = m[1] === '/';
    const selfClosing = !closing && m[2] === '/';
    if (selfClosing) {
      if (depth === 0) return m[0]; // `<svg …/>` on its own: empty document
      continue;
    }
    depth += closing ? -1 : 1;
    if (depth === 0) return text.slice(start, m.index + m[0].length);
  }
  return null;
}

/**
 * Is this PLAIN TEXT an SVG document (as opposed to prose or code that merely
 * mentions an `<svg>` somewhere)? Trimmed text must START as one: `<svg …`, an
 * XML prolog followed by `<svg`, or an SVG doctype. This is the strict gate for
 * `text/plain`, which is also how Illustrator hands over its markup.
 */
export function isSvgDocumentText(raw: string): boolean {
  const text = raw.trim();
  if (/^<svg[\s>/]/i.test(text)) return true;
  if (/^<\?xml\b/i.test(text) || /^<!DOCTYPE\s+svg\b/i.test(text)) {
    // Only prolog / doctype / comments may precede the root `<svg`.
    const afterPrologue = text.replace(/^(?:<\?xml[\s\S]*?\?>|<!DOCTYPE[\s\S]*?>|<!--[\s\S]*?-->|\s)+/i, '');
    return /^<svg[\s>/]/i.test(afterPrologue);
  }
  return false;
}

/** One flavour of what the OS clipboard holds, already read to text. */
export interface ClipboardTextItem {
  type: string;
  text: string;
}

/**
 * Decide whether a clipboard read is an SVG paste, and which markup to import.
 *
 * Pure — the decision is the part worth testing, and it needs no clipboard.
 * Flavours are tried in order of how much they promise:
 *
 *  1. `image/svg+xml` — declared SVG (Figma, Chrome, Inkscape). Whole payload.
 *  2. `text/html` — SVG wrapped in HTML (browsers prefix `<meta charset>`,
 *     Figma wraps in a `<div>`). The `<svg>` is pulled out from wherever it is.
 *  3. `text/plain` — only when the text IS an SVG document (Illustrator's
 *     "copy as SVG"). Prose or source code that happens to contain an inline
 *     `<svg>` icon is NOT an SVG paste and must reach the app's other paste
 *     targets untouched.
 *
 * Returns the markup to import, or null when this is not an SVG paste.
 */
export function detectClipboardSvg(items: ReadonlyArray<ClipboardTextItem>): string | null {
  const byType = (t: string) => items.filter((i) => i.type === t);
  for (const item of byType('image/svg+xml')) {
    const svg = extractSvgMarkup(item.text);
    if (svg) return svg;
  }
  for (const item of byType('text/html')) {
    const svg = extractSvgMarkup(item.text);
    if (svg) return svg;
  }
  for (const item of byType('text/plain')) {
    if (!isSvgDocumentText(item.text)) continue;
    const svg = extractSvgMarkup(item.text);
    if (svg) return svg;
  }
  return null;
}

/** The clipboard flavours we read; anything else (PNG, files…) is not ours. */
const SVG_CLIPBOARD_TYPES = ['image/svg+xml', 'text/html', 'text/plain'] as const;

/**
 * Read SVG markup from the OS clipboard, if any.
 *
 * Reads EVERY textual flavour of every item, then lets `detectClipboardSvg`
 * choose. This used to stop at the first flavour an item listed, so an item
 * carrying `text/html` (no SVG) alongside `image/svg+xml` lost its SVG.
 */
export async function readOsClipboardSvg(): Promise<string | null> {
  if (typeof navigator === 'undefined' || !navigator.clipboard) return null;

  const collected: ClipboardTextItem[] = [];
  try {
    const read = navigator.clipboard.read?.bind(navigator.clipboard);
    if (read) {
      const items = await read();
      for (const item of items) {
        for (const type of SVG_CLIPBOARD_TYPES) {
          if (!item.types.includes(type)) continue;
          try {
            collected.push({ type, text: await (await item.getType(type)).text() });
          } catch {
            // A flavour that fails to materialise is skipped, not fatal.
          }
        }
      }
    }
  } catch {
    // Permission denied or unsupported — readText below still has a chance.
  }

  const typed = detectClipboardSvg(collected);
  if (typed) return typed;

  try {
    const text = await navigator.clipboard.readText();
    return detectClipboardSvg([{ type: 'text/plain', text }]);
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
    spatialInterp?: SpatialInterp;
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
  // Path vertices selected with Direct Selection: copy the PATH (AE's Mask
  // Path / shape Path value), not the layer. Otherwise the stale path
  // clipboard is dropped so it cannot shadow the paste of what is copied now.
  if (copyPathFromSelection()) return;
  const kfIds = useKeyframeSelectionStore.getState().ids;

  if (kfIds.size > 0) {
    const copiedKfs: ClipboardState['copiedKeyframes'] = [];

    // Selection ids name ENGINE keys (core/mirror/keySelection.ts); this legacy
    // copy reads the TS engine's tracks, so it takes each key's stored position.
    const parsed = selectionStoredRefs(documentMirror(), kfIds)
      // A "Position" track stands for the x/y/z tracks.
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
          spatialInterp: kf.spatialInterp,
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
        
        // Snapshot a PLAIN node. Animation is snapshotted separately so paste
        // still works after the original is deleted (Cut, or a later Delete).
        //
        // Not `JSON.parse(JSON.stringify(original))`: `getNode` returns a live
        // `AppNodeView`, whose fields are prototype getters over a private
        // engine node. Stringifying it walks that engine node — parent → root
        // → children → back — and throws "circular structure", so Copy on a
        // layer never worked. Read the getters instead, as duplicate does.
        const clonedNode: SceneNode = {
          id: original.id,
          name: original.name,
          parent: original.parent ?? null,
          children: [...original.children],
          transform: structuredClone(original.transform),
          visible: original.visible,
          locked: original.locked,
          solo: original.solo,
          color: original.color,
          components: original.components.map((c) => ({ ...c, props: structuredClone(c.props) })),
        };
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
    const refs = selectionStoredRefs(documentMirror(), kfIds);
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

export type PasteResult = 'keyframes' | 'layers' | 'svg' | 'path' | null;

/**
 * Paste internal clipboard first (a copied path onto the selected path →
 * keyframes → layers). If empty, try OS clipboard SVG → editable shape group
 * (AE 26.3 paste Illustrator/SVG).
 */
export async function pasteSelection(): Promise<PasteResult> {
  if (pastePathEdit()) return 'path';
  if (clipboardState.copiedKeyframes && clipboardState.copiedKeyframes.length > 0) {
    const keyframes = clipboardState.copiedKeyframes;
    const controller = getTimelineController();
    const curTime = controller.currentSeconds;
    const selectedLayerIds = useSelectionStore.getState().ids;
    const pasted: Array<{ layerId: string; prop: string; t: number }> = [];

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
          if (kf.spatialInterp !== undefined) {
            defaultAnimation.setSpatialInterp(layerId, kf.prop, layerT, kf.spatialInterp);
          }
          if (kf.continuous !== undefined || kf.roving !== undefined) {
            defaultAnimation.updateKeyframe(layerId, kf.prop, layerT, {
              continuous: kf.continuous,
              roving: kf.roving,
            });
          }
          pasted.push({ layerId, prop: kf.prop, t: layerT });
        }
      }
    });

    // Select the pasted keys by their engine ids (a key the legacy writer left
    // without a stable id cannot be named, and is left unselected).
    const newSelectionIds = new Set<string>();
    for (const p of pasted) {
      const id = defaultAnimation.getTrackKeyframes(p.layerId, p.prop)?.find((k) => Math.abs(k.t - p.t) < T_EPSILON)?.id;
      if (id) newSelectionIds.add(trackSelectionId(documentMirror(), p.layerId, p.prop, id));
    }
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
      
      // Offset the PLAIN clone before it enters the graph (ENGINE_API.md §2.5
      // #3). This used to write `tComp.props.x` AFTER `addChild` — a write into
      // a copy the graph had already taken, silently discarded — and patch it
      // back through `setLocalTransform`, which also rewrote rotation.
      const tComp = dupComponents.find((c) => c.type === 'Transform');
      if (tComp && typeof tComp.props.x === 'number') {
        tComp.props.x = (tComp.props.x as number) + 20;
        tComp.props.y = (typeof tComp.props.y === 'number' ? tComp.props.y : 0) + 20;
      }

      defaultSceneGraph.addChild(rootId, dupNode as Parameters<typeof defaultSceneGraph.addChild>[1]);
      
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

  // AE 26.3: paste SVG / Illustrator markup from the OS. Checked LAST, only
  // once the app's own clipboard is empty, and routed through the same
  // importer a dropped .svg file takes, so both land identically.
  const svg = await readOsClipboardSvg();
  if (!svg) return null;
  const id = insertSvgDocument(svg, 'Pasted SVG');
  if (!id) return null;
  useSelectionStore.getState().set([id]);
  return 'svg';
}

/** Empty the internal clipboard (tests; a paste should then reach the OS). */
export function clearClipboard(): void {
  clipboardState.copiedKeyframes = null;
  clipboardState.copiedLayers = null;
}
