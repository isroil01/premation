/**
 * sceneInsert — shared "add a primitive to the composition" action, so the
 * insert controls can live anywhere (top tool bar, command palette, …) without
 * each call site re-implementing the node factory.
 */

import defaultSceneGraph from './DefaultSceneGraph';
import { SCENE_KIND_PROP, type SceneKind } from './seedDefaultScene';
import { bumpScene } from '@stores/sceneStore';
import { useSelectionStore } from '@stores/selectionStore';
import type { SceneNode } from '@core/types';
import type { ImportedAsset } from '@stores/assetStore';
import { parseSvgToShapes } from '../../utils/svgParser';

let seq = 0;

/** Build a fresh scene node of `kind` with sensible default components. */
function makeNode(kind: SceneKind, name: string): SceneNode {
  const id = `${kind}_${(seq += 1)}_${Math.random().toString(36).slice(2, 6)}`;
  const transform = { position: { x: 160, y: 120 }, rotation: 0, scale: { x: 1, y: 1 } };
  const components: SceneNode['components'] =
    kind === 'text'
      ? [
          { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: kind, x: 160, y: 120, rotation: 0 } },
          { id: `${id}_c`, type: 'Text', props: { content: 'Text', fontSize: 32, opacity: 100 } },
        ]
      : kind === 'group'
        ? [{ id: `${id}_m`, type: 'group', props: { [SCENE_KIND_PROP]: kind } }]
        : [
            { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: kind, x: 160, y: 120, rotation: 0 } },
            { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#2b7eff' } },
          ];
  return { id, name, parent: null, children: [], transform, visible: true, locked: false, components };
}

/** Insert a primitive at the composition root, select it, and refresh the UI. */
export function insertPrimitive(kind: SceneKind, name: string): void {
  const rootId = defaultSceneGraph.getRoots()[0]?.id ?? 'comp_root';
  const node = makeNode(kind, name);
  defaultSceneGraph.addChild(rootId, node);
  useSelectionStore.getState().set([node.id]);
  bumpScene();
}

/** Insert a full-frame solid colour layer (background / matte / adjustment base).
 *  It is a shape flagged `solid`, so buildSnapshot sizes it to the composition. */
export function insertSolid(color = '#2b7eff'): void {
  const rootId = defaultSceneGraph.getRoots()[0]?.id ?? 'comp_root';
  const node = makeNode('shape', 'Solid');
  defaultSceneGraph.addChild(rootId, node);
  defaultSceneGraph.setSolid(node.id, true);
  defaultSceneGraph.setFill(node.id, { type: 'solid', color });
  useSelectionStore.getState().set([node.id]);
  bumpScene();
}

/** Insert a Camera layer, centred on a 1080p comp and pulled back by its focal
 *  length so the comp plane renders 1:1. Position / z / focalLength are plain
 *  editable + keyframeable props (the inspector shows them automatically). */
export function insertCamera(): void {
  const rootId = defaultSceneGraph.getRoots()[0]?.id ?? 'comp_root';
  const node = makeNode('camera', 'Camera 1');
  const focalLength = 2666; // ~50mm on a 1920-wide comp
  const t = node.components.find((c) => c.type === 'Transform');
  if (t) {
    // Seeded before the node enters the graph, so these become its base props.
    t.props.x = 960;
    t.props.y = 540;
    t.props.z = -focalLength;
    t.props.focalLength = focalLength;
  }
  defaultSceneGraph.addChild(rootId, node);
  useSelectionStore.getState().set([node.id]);
  bumpScene();
}

/** Insert a Light layer */
export function insertLight(): void {
  const rootId = defaultSceneGraph.getRoots()[0]?.id ?? 'comp_root';
  const node = makeNode('light', 'Light 1');
  // Seed position + keyframeable intensity/radius; warm colour via Style.fill.
  const t = node.components.find((c) => c.type === 'Transform');
  if (t) {
    t.props.x = 960;
    t.props.y = 540;
    t.props.intensity = 100;
    t.props.radius = 500;
  }
  const s = node.components.find((c) => c.type === 'Style');
  if (s) s.props.fill = '#fff3c0';
  defaultSceneGraph.addChild(rootId, node);
  useSelectionStore.getState().set([node.id]);
  bumpScene();
}

/** Insert an Adjustment Layer */
export function insertAdjustmentLayer(): void {
  const rootId = defaultSceneGraph.getRoots()[0]?.id ?? 'comp_root';
  const node = makeNode('adjustment', 'Adjustment Layer 1');
  defaultSceneGraph.addChild(rootId, node);
  defaultSceneGraph.setSolid(node.id, true);
  defaultSceneGraph.setFill(node.id, { type: 'solid', color: 'rgba(255,255,255,0)' });
  defaultSceneGraph.setAdjustment(node.id, true);
  useSelectionStore.getState().set([node.id]);
  bumpScene();
}

/** Group selected layers into a new Pre-composition folder */
export function precomposeSelected(): void {
  const selectionStore = useSelectionStore.getState();
  const selectedIds = selectionStore.ids;
  if (selectedIds.length === 0) return;

  const rootId = defaultSceneGraph.getRoots()[0]?.id ?? 'comp_root';
  const preCompNode = makeNode('group', 'Pre-comp 1');
  defaultSceneGraph.addChild(rootId, preCompNode);

  for (const childId of selectedIds) {
    defaultSceneGraph.setParent(childId, preCompNode.id);
  }

  // Flag it a real precomp: its subtree now composites as one unit (group
  // opacity / blend / effects apply to the nested result).
  defaultSceneGraph.setPrecomp(preCompNode.id, true);

  selectionStore.set([preCompNode.id]);
  bumpScene();
}

/**
 * Insert an audio layer (Prompt 8). Audio doesn't draw on the canvas — it
 * carries an `Audio` component (asset ref + level/trim), shows a waveform in the
 * inspector, and plays in sync with the transport via the AudioEngine.
 */
export function insertAudio(asset: ImportedAsset): void {
  const rootId = defaultSceneGraph.getRoots()[0]?.id ?? 'comp_root';
  const duration = asset.metadata?.duration ?? 0;
  const node = makeNode('audio', asset.name);
  const transform = node.components.find((c) => c.type === 'Transform');
  node.components = [
    ...(transform ? [transform] : []),
    {
      id: `${node.id}_a`,
      type: 'Audio',
      // `__`-prefixed so the generic NodeInspector hides them — the dedicated
      // AudioControls section owns editing (level / in-out / mute / waveform).
      props: {
        __assetId: asset.id,
        __src: asset.src,
        __level: 100,
        __start: 0,
        __in: 0,
        __out: duration,
        __duration: duration,
        __muted: false,
      },
    },
  ];
  defaultSceneGraph.addChild(rootId, node);
  useSelectionStore.getState().set([node.id]);
  bumpScene();
}

/** Insert an imported media asset (image or video) at native size */
export async function insertMedia(asset: ImportedAsset): Promise<void> {
  const rootId = defaultSceneGraph.getRoots()[0]?.id ?? 'comp_root';
  if (asset.type === 'audio') {
    insertAudio(asset);
    return;
  }

  // Intercept SVG files and parse them into editable vector shapes
  if (asset.type === 'image' && asset.name.toLowerCase().endsWith('.svg')) {
    try {
      const res = await fetch(asset.src);
      const svgText = await res.text();
      const shapes = parseSvgToShapes(svgText);
      if (shapes.length > 0) {
        // Create a group for the SVG shapes to keep them organized
        const group = makeNode('group', asset.name);
        defaultSceneGraph.addChild(rootId, group);

        const selectionIds: string[] = [];

        for (const s of shapes) {
          const pathId = `shape_${(seq += 1)}_${Math.random().toString(36).slice(2, 6)}`;
          const transform = { position: { x: s.centerX, y: s.centerY }, rotation: 0, scale: { x: 1, y: 1 } };
          const components: SceneNode['components'] = [
            {
              id: `${pathId}_t`,
              type: 'Transform',
              props: {
                [SCENE_KIND_PROP]: 'shape',
                x: s.centerX,
                y: s.centerY,
                rotation: 0,
                width: s.width,
                height: s.height,
              },
            },
            {
              id: `${pathId}_s`,
              type: 'Style',
              props: {
                opacity: 100,
                fill: s.fill,
                ...(s.strokeColor ? { stroke: { color: s.strokeColor, width: s.strokeWidth ?? 2, opacity: 1, cap: 'butt', join: 'miter', align: 'center', dash: [] } } : {}),
              },
            },
            {
              id: `${pathId}_g`,
              type: 'Geometry',
              props: { points: s.points },
            },
          ];

          const pathNode: SceneNode = { id: pathId, name: s.name, parent: group.id, children: [], transform, visible: true, locked: false, components };
          defaultSceneGraph.addChild(group.id, pathNode);
          selectionIds.push(pathNode.id);
        }

        useSelectionStore.getState().set([group.id, ...selectionIds]);
        bumpScene();
        return;
      }
    } catch (e) {
      console.error('[sceneInsert] failed to parse SVG asset to vector paths:', e);
      // Fallback to static image insert below on error
    }
  }

  const kind = asset.type === 'video' ? 'video' : 'image';
  const width = asset.metadata?.width ?? 400;
  const height = asset.metadata?.height ?? 400;

  const node = makeNode(kind, asset.name);
  // Add width/height and src/assetId to the transform component props
  const transform = node.components.find(c => c.type === 'Transform');
  if (transform) {
    transform.props.width = width;
    transform.props.height = height;
    transform.props.src = asset.src;
    transform.props.assetId = asset.id;
    // Center it in a standard 1080p composition (can be improved later if comp size is variable here)
    transform.props.x = 1920 / 2;
    transform.props.y = 1080 / 2;
    node.transform.position.x = transform.props.x as number;
    node.transform.position.y = transform.props.y as number;
  }
  
  defaultSceneGraph.addChild(rootId, node);
  useSelectionStore.getState().set([node.id]);
  bumpScene();
}

/**
 * Delete all currently selected layers (and their descendants recursively).
 * Locked layers are skipped. Clears the selection after deletion.
 */
export function deleteSelectedLayers(): void {
  const { ids } = useSelectionStore.getState();
  if (ids.length === 0) return;

  // Filter out locked nodes and roots.
  const toDelete = ids.filter((id) => {
    const node = defaultSceneGraph.getNode(id);
    return node && !node.locked && node.parent !== null;
  });
  if (toDelete.length === 0) return;

  for (const id of toDelete) {
    defaultSceneGraph.removeNode(id);
  }
  useSelectionStore.getState().clear();
  bumpScene();
}

/**
 * Duplicate all currently selected layers, offsetting each copy by +20px/+20px
 * (classic AE behaviour). The copies are added adjacent to the originals.
 */
export function duplicateSelectedLayers(): void {
  const { ids } = useSelectionStore.getState();
  if (ids.length === 0) return;

  const newIds: string[] = [];

  for (const id of ids) {
    const original = defaultSceneGraph.getNode(id);
    if (!original || original.parent === null) continue;

    // Deep-clone the node with a new id.
    const dupId = `${id}_dup_${Math.random().toString(36).slice(2, 6)}`;
    const dupComponents = original.components.map((c) => ({
      ...c,
      id: `${dupId}_${c.type}`,
      props: { ...c.props },
    }));

    const dupNode = {
      id: dupId,
      name: `${original.name ?? 'Layer'} copy`,
      parent: null as string | null,
      children: [] as string[],
      transform: {
        position: {
          x: original.transform.position.x + 20,
          y: original.transform.position.y + 20,
        },
        rotation: original.transform.rotation,
        scale: { ...original.transform.scale },
      },
      visible: original.visible,
      locked: false,
      components: dupComponents,
    };

    defaultSceneGraph.addChild(original.parent!, dupNode as Parameters<typeof defaultSceneGraph.addChild>[1]);
    // Apply the x/y offset on the Transform component too.
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
    newIds.push(dupId);
  }

  if (newIds.length > 0) {
    useSelectionStore.getState().set(newIds);
    bumpScene();
  }
}

