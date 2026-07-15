import { getTimelineController } from '@core/timeline/TimelineController';
import { defaultAnimation, type EasingKind, type BezierHandles } from '@motion/animation';

export type AIOperation =
  | {
      op: 'set';
      target: string;
      properties: Record<string, number>;
      timing: { t: number; curve?: string };
    }
  | {
      op: 'remove';
      target: string;
      prop: string;
      timing: { t: number };
    }
  | {
      op: 'move';
      target: string;
      prop: string;
      timing: { t: number; toT: number };
    }
  | {
      op: 'easing';
      target: string;
      prop: string;
      timing: { t: number; curve: string };
    }
  | {
      op: 'create_layer';
      target: string;
      properties: {
        kind: 'shape' | 'text' | 'image' | 'video' | 'group' | 'null';
        name: string;
      };
    }
  | {
      op: 'delete_layer';
      target: string;
    }
  | {
      op: 'reparent_layer';
      target: string;
      properties: {
        parentId: string | null;
      };
    };

import { sceneProjectIO } from '@core/scene/sceneProjectIO';
import { StoreSnapshotCommand } from '@stores/historyStore';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { bumpScene } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { reparentNode } from '@core/scene/parenting';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';

/** Build a fresh scene node (adapted from sceneInsert) */
function makeNode(kind: string, id: string, name: string): SceneNode {
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

function parseCurve(curveStr?: string): { easing: EasingKind; bezier?: BezierHandles } {
  if (!curveStr) return { easing: 'linear' };
  const normalized = curveStr.trim().toLowerCase();

  // Presets
  if (normalized === 'linear') return { easing: 'linear' };
  if (normalized === 'step') return { easing: 'step' };
  if (normalized === 'hold') return { easing: 'hold' };
  if (normalized === 'ease') return { easing: 'ease' };
  if (normalized === 'ease-in') return { easing: 'easeIn' };
  if (normalized === 'ease-out') return { easing: 'easeOut' };
  if (normalized === 'ease-in-out') return { easing: 'easeInOut' };

  // Custom curves
  const bezierRegex = /^cubic-bezier\(\s*([0-9.-]+)\s*,\s*([0-9.-]+)\s*,\s*([0-9.-]+)\s*,\s*([0-9.-]+)\s*\)$/;
  const match = normalized.match(bezierRegex);
  if (match) {
    const x1 = parseFloat(match[1]!);
    const y1 = parseFloat(match[2]!);
    const x2 = parseFloat(match[3]!);
    const y2 = parseFloat(match[4]!);
    if (!isNaN(x1) && !isNaN(y1) && !isNaN(x2) && !isNaN(y2)) {
      return {
        easing: 'bezier',
        bezier: [x1, y1, x2, y2] as BezierHandles,
      };
    }
  }

  return { easing: 'linear' };
}

export function applyAiOps(label: string, ops: AIOperation[]): void {
  if (!ops.length) return;

  const before = {
    scene: structuredClone(sceneProjectIO.capture()),
    anim: defaultAnimation.snapshot(),
  };

  for (const op of ops) {
    switch (op.op) {
      case 'create_layer': {
        const rootId = defaultSceneGraph.getRoots()[0]?.id ?? 'comp_root';
        const node = makeNode(op.properties.kind, op.target, op.properties.name);
        defaultSceneGraph.addChild(rootId, node);
        break;
      }
      case 'delete_layer': {
        defaultSceneGraph.removeNode(op.target);
        break;
      }
      case 'reparent_layer': {
        reparentNode(op.target, op.properties.parentId);
        break;
      }
      case 'set': {
        const { easing, bezier } = parseCurve(op.timing.curve);
        for (const [prop, val] of Object.entries(op.properties)) {
          defaultAnimation.setKeyframe(op.target, prop, getTimelineController().toLayerTime(op.target, op.timing.t), val, easing);
          if (easing === 'bezier' && bezier) {
            defaultAnimation.setBezier(op.target, prop, op.timing.t, bezier);
          }
        }
        break;
      }
      case 'remove': {
        defaultAnimation.removeKeyframe(op.target, op.prop, getTimelineController().toLayerTime(op.target, op.timing.t));
        break;
      }
      case 'move': {
        defaultAnimation.moveKeyframe(op.target, op.prop, op.timing.t, op.timing.toT);
        break;
      }
      case 'easing': {
        const { easing, bezier } = parseCurve(op.timing.curve);
        defaultAnimation.setEasing(op.target, op.prop, op.timing.t, easing);
        if (easing === 'bezier' && bezier) {
          defaultAnimation.setBezier(op.target, op.prop, op.timing.t, bezier);
        }
        break;
      }
    }
  }

  const after = {
    scene: structuredClone(sceneProjectIO.capture()),
    anim: defaultAnimation.snapshot(),
  };

  const command = new StoreSnapshotCommand(label || 'AI edit', before, after);
  getCommandSystem().getHistory().push(command);
  bumpScene();
}
