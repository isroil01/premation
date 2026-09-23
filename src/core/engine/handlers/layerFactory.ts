/**
 * Node factory for `createLayer`: the same component shapes the editor's insert
 * helpers build (sceneInsert.ts), but deterministic — the id comes from the
 * engine's allocator, the placement is the composition centre (no pointer, no
 * active tab), and nothing touches selection or shows a toast.
 */

import type { LayerKind } from '@motion/engine-api';
import type { SceneNode } from '@core/types';
import type { ImportedAsset } from '@stores/assetStore';
import type { CompositionSettings } from '@stores/projectStore';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { COMP_REF_PROP } from '@core/scene/compInstance';
import { DEFAULT_PARTICLE_CONFIG } from '@core/particles/particleSim';
import { defaultPrimitiveSpec, makePrimitiveComponent } from '@core/scene/primitiveLayer';
import { Project3D } from '@motion/scene';
import { defaultTextSize } from '@core/scene/textDefaults';
import { fail } from '../errors';

export interface FactoryInput {
  kind: LayerKind;
  id: string;
  name?: string;
  comp: CompositionSettings;
  asset?: ImportedAsset;
  refComp?: { id: string; settings: CompositionSettings };
}

const DEFAULT_NAMES: Partial<Record<LayerKind, string>> = {
  null: 'Null', solid: 'Solid', shape: 'Shape Layer', rectangle: 'Rectangle', ellipse: 'Ellipse',
  polygon: 'Polygon', path: 'Path', text: 'Text', camera: 'Camera', light: 'Light', group: 'Group',
  particle: 'Particles', model3d: '3D Box', adjustment: 'Adjustment Layer',
};

export function makeLayerNode(input: FactoryInput): SceneNode {
  const { kind, id, comp } = input;
  const cx = comp.width / 2;
  const cy = comp.height / 2;
  const name = input.name ?? input.asset?.name ?? input.refComp?.settings.name ?? DEFAULT_NAMES[kind] ?? kind;
  const transform = (sceneKind: string, extra: Record<string, unknown> = {}): SceneNode['components'][number] => ({
    id: `${id}_t`,
    type: 'Transform',
    props: { [SCENE_KIND_PROP]: sceneKind, x: cx, y: cy, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0, anchorY: 0, ...extra },
  });
  const style = (props: Record<string, unknown>): SceneNode['components'][number] => ({ id: `${id}_s`, type: 'Style', props });
  const node = (components: SceneNode['components']): SceneNode => ({
    id, name, parent: null, children: [],
    transform: { position: { x: cx, y: cy }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true, locked: false, components,
  });

  switch (kind) {
    case 'null':
      return node([transform('null', { width: 100, height: 100 })]);
    case 'solid':
    case 'adjustment':
      return node([
        transform(kind === 'solid' ? 'shape' : 'adjustment', { width: comp.width, height: comp.height }),
        style({ opacity: 100, fill: kind === 'solid' ? '#4f7ea8' : 'rgba(255,255,255,0)' }),
        { id: `${id}_fx`, type: 'fx', props: kind === 'solid'
          ? { solid: true, fill: { type: 'solid', color: '#4f7ea8' } }
          : { solid: true, fill: { type: 'solid', color: 'rgba(255,255,255,0)' }, isAdjustment: true } },
      ]);
    case 'shape':
    case 'rectangle':
      return node([transform('shape', { width: 280, height: 280, shapeType: 'rect' }), style({ opacity: 100, fill: '#3b8276' })]);
    case 'ellipse':
      return node([transform('shape', { width: 280, height: 280, shapeType: 'ellipse' }), style({ opacity: 100, fill: '#3b8276' })]);
    case 'polygon':
      return node([transform('shape', { width: 280, height: 280, shapeType: 'polygon' }), style({ opacity: 100, fill: '#3b8276' })]);
    case 'path':
      return node([
        transform('shape', { width: 1, height: 1 }),
        style({ opacity: 100, fill: '#3b8276' }),
        { id: `${id}_g`, type: 'Geometry', props: { points: [] } },
      ]);
    case 'text':
      return node([
        transform('text'),
        { id: `${id}_c`, type: 'Text', props: { content: input.name ?? 'Text', fontSize: defaultTextSize(), opacity: 100 } },
      ]);
    case 'camera': {
      const cam = Project3D.defaultCamera(comp.width, comp.height);
      return node([transform('camera', { width: 100, height: 100, x: cam.position.x, y: cam.position.y, z: -cam.focalLength, focalLength: cam.focalLength }), style({ opacity: 100 })]);
    }
    case 'light':
      return node([
        transform('light', {
          width: 100, height: 100, z: -Math.round(comp.width * 0.2315), intensity: 100,
          radius: Math.round(Math.max(comp.width, comp.height) * 0.45), falloff: 'none', castShadows: true,
        }),
        style({ opacity: 100, fill: '#fff3c0' }),
      ]);
    case 'group':
      return node([
        transform('group', { width: 280, height: 280 }),
        { id: `${id}_m`, type: 'group', props: { [SCENE_KIND_PROP]: 'group' } },
      ]);
    case 'particle':
      return node([
        transform('particle', { width: 400, height: 400 }),
        style({ opacity: 100 }),
        { id: `${id}_fx`, type: 'fx', props: { particle: { ...DEFAULT_PARTICLE_CONFIG, emitterWidth: 400, emitterHeight: 400 } } },
      ]);
    case 'model3d': {
      const spec = defaultPrimitiveSpec('box');
      return node([
        transform('shape', { width: 240, height: 240, z: 0, rotationX: 0, rotationY: 0, primitiveType: 'box', castsShadows: true, acceptsLights: true }),
        style({ opacity: 100, fill: '#3b8276' }),
        makePrimitiveComponent(id, spec),
      ]);
    }
    case 'image':
    case 'video':
    case 'svg':
    case 'sequence': {
      const a = input.asset;
      if (!a) fail('invalidArgument', `a ${kind} layer needs a footage source`);
      const par = a.interpret?.par ?? 1;
      const w = Math.round((a.metadata?.width ?? 400) * par);
      const h = a.metadata?.height ?? 400;
      const sceneKind = kind === 'video' ? 'video' : kind === 'svg' ? 'svg' : 'image';
      return node([transform(sceneKind, { width: w, height: h, src: a.src, assetId: a.id }), style({ opacity: 100 })]);
    }
    case 'audio': {
      const a = input.asset;
      if (!a) fail('invalidArgument', 'an audio layer needs a footage source');
      const d = a.metadata?.duration ?? 0;
      return node([
        transform('audio', { width: 100, height: 100 }),
        { id: `${id}_a`, type: 'Audio', props: { __assetId: a.id, __src: a.src, __level: 100, __start: 0, __in: 0, __out: d, __duration: d, __muted: false } },
      ]);
    }
    case 'precomp': {
      const ref = input.refComp;
      if (!ref) fail('invalidArgument', 'a precomp layer needs a composition source');
      return node([
        transform('comp', { width: ref.settings.width, height: ref.settings.height }),
        style({ opacity: 100 }),
        { id: `${id}_fx`, type: 'fx', props: { precomp: true, [COMP_REF_PROP]: ref.id } },
      ]);
    }
    case 'component':
    case 'generator':
    default:
      return fail('unsupported', `creating a '${kind}' layer through the engine API is not supported by the TypeScript engine (plugin/component layers are created by their plugin)`);
  }
}
