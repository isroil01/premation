/**
 * What the AI tools READ of the document, over the document MIRROR (B4,
 * docs/B4_MIRROR.md) — never the page replica (docs/TS_ENGINE_REMOVAL.md
 * block 3). The turn's session lets the mirror reach each write's revision
 * before the next tool reads (aiEngineSession.ts), so a read sees what the
 * turn wrote.
 *
 * Property trees load on first ask, so every reader that needs one is async
 * (`loadTree`). Values are the STATIC ones a property stores (`PropertyInfo
 * .value`, the base under any keys), in stored units — what the pre-mirror
 * reads of component props returned.
 *
 * No React (src/core).
 */

import type { LayerInfo, PropertyInfo } from '@motion/engine-api';
import type { SceneNodeView } from '@motion/ai-tools';
import { documentMirror, type MirrorTree } from '@stores/documentMirror';
import { uiKindOf } from '@core/mirror/layerKinds';
import { membersOf, numbersOfValue, plainValue, storedNumber, trackRefIn } from '@core/mirror/trackIndex';
import { colorValueHex, mirrorFill } from '@core/mirror/paintFields';

/** A layer of any composition. */
export function layerInfo(id: string): LayerInfo | undefined {
  return documentMirror().layer(id);
}

/** Whether `id` names a layer or a composition. */
export function hasNode(id: string): boolean {
  const m = documentMirror();
  return m.hasLayer(id) || m.comp(id) !== undefined;
}

/** The editor kind of a layer (`shape`, `text`, `image`, …), or null when it is not one. */
export function layerKind(id: string): string | null {
  return uiKindOf(layerInfo(id));
}

/** The layer's property tree, loaded. */
export function treeOf(id: string): Promise<MirrorTree | undefined> {
  return documentMirror().loadTree(id);
}

/**
 * Every layer of every composition, compositions in document order, each
 * composition's stack top first with a parent before its children (what
 * `describe_scene`'s subtree pass relies on).
 */
export function allLayerIds(): string[] {
  const m = documentMirror();
  return m.compIds.flatMap((c) => [...(m.comp(c)?.layers ?? [])]);
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** A track's static value in stored units (`x` of Position, `fontSize`), undefined when the layer has none. */
export function staticTrack(tree: MirrorTree | undefined, track: string): number | undefined {
  const r = trackRefIn(tree, track);
  return r ? storedNumber(r, r.info.value) : undefined;
}

/** A property's static value as a plain JS value (strings, choices, json parsed), undefined when absent. */
export function staticField(tree: MirrorTree | undefined, path: string): unknown {
  return plainValue(tree?.nodes.get(path)?.value);
}

/** The child group paths of a group (`contents`, `text/animators`), in order. */
export function childGroups(tree: MirrorTree | undefined, path: string): PropertyInfo[] {
  const kids = tree?.nodes.get(path)?.children ?? [];
  return kids.map((p) => tree!.nodes.get(p)).filter((n): n is PropertyInfo => !!n && n.kind !== 'property');
}

/** The last segment of a property path (a group's id: `contents/op_1` → `op_1`). */
export const lastSegment = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** A layer's shape operators (Contents ▸ Trim Paths, Repeater, …), in chain order: id, type and static numeric params. */
export async function pathOperators(id: string): Promise<Array<{ id: string; type: string; params: Record<string, number> }>> {
  const tree = await treeOf(id);
  return childGroups(tree, 'contents')
    .filter((g) => g.matchName.startsWith('pathop:'))
    .map((g) => {
      const params: Record<string, number> = {};
      for (const p of g.children) {
        const n = num(numbersOfValue(tree!.nodes.get(p)?.value)[0]);
        if (n !== undefined && tree!.nodes.get(p)?.valueType === 'scalar') params[lastSegment(p)] = n;
      }
      return { id: lastSegment(g.path), type: g.matchName.slice('pathop:'.length), params };
    });
}

/** A text layer's animators, in order: each id and its selectors' ids. */
export async function textAnimators(id: string): Promise<Array<{ id: string; selectors: string[] }>> {
  const tree = await treeOf(id);
  return childGroups(tree, 'text/animators').map((a) => ({
    id: lastSegment(a.path),
    selectors: childGroups(tree, `${a.path}/selectors`).map((s) => lastSegment(s.path)),
  }));
}

/** The layer's effects (`effects/<id>`, the match name is the effect type), in stack order. */
export async function layerEffects(id: string): Promise<Array<{ id: string; type: string }>> {
  const tree = await treeOf(id);
  return childGroups(tree, 'effects').map((g) => ({ id: lastSegment(g.path), type: g.matchName }));
}

/** The puppet pins of a layer (`puppet/pins/<id>`, named), [] when it has no rig. */
export async function puppetPins(id: string): Promise<Array<{ id: string; name: string }>> {
  const tree = await treeOf(id);
  return childGroups(tree, 'puppet/pins').map((p) => ({ id: lastSegment(p.path), name: p.name }));
}

/** The layer's box (`layer/width`, `layer/height`), each undefined when absent. */
export async function layerBox(id: string): Promise<{ width?: number; height?: number }> {
  const tree = await treeOf(id);
  return { width: num(staticField(tree, 'layer/width')), height: num(staticField(tree, 'layer/height')) };
}

/** The stored track names of a layer's animated properties (every member of a keyed vector). */
function animatedTracks(id: string, tree: MirrorTree | undefined): string[] {
  const out: string[] = [];
  for (const path of documentMirror().layerKeyframes(id).keys()) {
    const info = tree?.nodes.get(path);
    const members = info ? membersOf(info) : [];
    out.push(...(members.length > 0 ? members : [path]));
  }
  return out;
}

/** The scene facade's view of one layer (`describe_scene`, `get`). */
export async function layerView(id: string): Promise<SceneNodeView | undefined> {
  const layer = layerInfo(id);
  if (!layer) return undefined;
  const m = documentMirror();
  const tree = await treeOf(id);
  const kind = uiKindOf(layer) ?? 'shape';
  // A gradient / image fill is an object, not a hex — reported as such, so the
  // model knows the layer is not a flat colour. A text layer's fill is its
  // Character colour.
  const paint = kind === 'text' ? undefined : mirrorFill(m, id);
  const fill = kind === 'text'
    ? colorValueHex(tree?.nodes.get('layer/fill')?.value)
    : paint ? (paint.type === 'solid' ? paint.color : 'gradient') : undefined;
  const { width, height } = await layerBox(id);
  const text = staticField(tree, 'text/sourceText') as { text?: unknown } | undefined;
  const fontFamily = staticField(tree, 'text/fontFamily');
  const fontSize = staticTrack(tree, 'fontSize');
  const fontWeight = staticTrack(tree, 'fontWeight');
  return {
    id,
    name: layer.name || id,
    kind,
    parent: layer.parent ?? null,
    visible: layer.switches.visible,
    locked: layer.switches.locked,
    x: staticTrack(tree, 'x') ?? 0,
    y: staticTrack(tree, 'y') ?? 0,
    rotation: staticTrack(tree, 'rotation') ?? 0,
    opacity: staticTrack(tree, 'opacity') ?? 100,
    ...(fill !== undefined ? { fill } : {}),
    ...(width !== undefined && (kind !== 'text' || width > 0) ? { width } : {}),
    ...(height !== undefined && (kind !== 'text' || height > 0) ? { height } : {}),
    ...(typeof text?.text === 'string' ? { text: text.text } : {}),
    ...(fontSize !== undefined ? { fontSize } : {}),
    ...(fontWeight !== undefined ? { fontWeight } : {}),
    ...(typeof fontFamily === 'string' ? { fontFamily } : {}),
    animated: animatedTracks(id, tree),
  };
}
