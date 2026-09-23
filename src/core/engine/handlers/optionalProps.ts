/**
 * Optional properties (G1, ENGINE_API.md §4.7): AE's Add ▸ Property on a text
 * animator — the properties that exist only once added — and deleting them.
 *
 *   addProperties     { parent: text/animators/<id>/props, names }  → the new property paths
 *   removeProperties  { props }                                       → gone with their keys and expressions
 *
 * Optional: Anchor Point X/Y/Z, Skew Axis, Line Anchor, Character Value, Fill
 * Hue/Saturation/Brightness, Stroke Opacity/Hue/Saturation/Brightness
 * (textAnimators.ts OPTIONAL_ANIMATOR_PROPERTIES), Fill Color and Stroke Color
 * (textFields.ts ANIMATOR_OPTIONAL_FIELDS) and Font Axis properties
 * (`axis<TAG>`, at most MAX_ANIMATED_AXES distinct tags per layer, AE 26).
 */

import {
  readAnimatorData,
  updateAnimator,
  removeAnimatorProperty,
  animatorPropPath,
  animatorAxisPropPath,
  OPTIONAL_ANIMATOR_PROPERTIES,
  type TextAnimatorData,
} from '@core/text/textAnimators';
import { ANIMATOR_OPTIONAL_FIELDS } from '@core/text/textFields';
import { isAxisTag, MAX_ANIMATED_AXES } from '@core/text/fontAxes';
import { is3DEnabled } from '@core/scene/threeD';
import { fail } from '../errors';
import { graph, requireLayer } from '../doc';
import { newScope, scopeLayer } from '../state';
import { dropTrackProps } from '../fields';
import type { HandlerTable } from '../handler';
import { ikParentOf, planIkAddProperties, planIkRemoveProperty } from '../rigProps';

type Optional =
  | { kind: 'number'; name: string; value: number }
  | { kind: 'color'; name: string; value: string }
  | { kind: 'axis'; name: string; tag: string };

/** What an optional-property name is, or null when it is not one. */
function optionalOf(name: string): Optional | null {
  const num = OPTIONAL_ANIMATOR_PROPERTIES.find((o) => o.param === name);
  if (num) return { kind: 'number', name, value: num.defaultValue };
  const col = ANIMATOR_OPTIONAL_FIELDS.find((o) => o.key === name);
  if (col) return { kind: 'color', name, value: String(col.default) };
  const m = /^axis(.+)$/.exec(name);
  if (m && isAxisTag(m[1])) return { kind: 'axis', name, tag: m[1]! };
  return null;
}

/** `text/animators/<id>/props` → the animator's index and data. */
function animatorOf(layer: string, path: string): { index: number; data: TextAnimatorData[] } {
  const seg = path.split('/');
  if (!(seg.length === 4 && seg[0] === 'text' && seg[1] === 'animators' && seg[3] === 'props')) {
    fail('unsupported', `'${path}' has no optional properties in this engine (text/animators/<id>/props has)`, { layer, path });
  }
  const node = graph.getNode(layer)!;
  if (!node.components.some((c) => c.type === 'Text')) fail('notFound', `layer '${layer}' is not a text layer`, { layer, path });
  const data = readAnimatorData(node);
  const index = data.findIndex((a) => a.id === seg[2]);
  if (index < 0) fail('notFound', `no animator '${seg[2]}'`, { layer, path });
  return { index, data };
}

function present(a: TextAnimatorData, o: Optional): boolean {
  if (o.kind === 'axis') return !!a.axes && o.tag in a.axes;
  return (a as unknown as Record<string, unknown>)[o.name] !== undefined;
}

export const optionalPropHandlers: HandlerTable = {
  addProperties: (cmd) => {
    const layer = cmd.parent.layer;
    requireLayer(layer);
    if (cmd.names.length === 0) fail('invalidArgument', 'no property names given', { layer, path: cmd.parent.path });
    if (ikParentOf(cmd.parent.path) !== null) {
      // An IK goal's optional Pole (rigProps.ts).
      const run = planIkAddProperties(layer, cmd.parent.path, cmd.names);
      return {
        scope: scopeLayer(newScope(), layer),
        label: 'Add Property',
        apply: () => { run(); return { paths: cmd.names.map((n) => `${cmd.parent.path}/${n}`) }; },
      };
    }
    const { index, data } = animatorOf(layer, cmd.parent.path);
    const node = graph.getNode(layer)!;
    const cur = data[index]!;
    const opts = cmd.names.map((name) => {
      const o = optionalOf(name);
      if (!o) fail('invalidArgument', `'${name}' is not an optional property of a text animator`, { layer, path: `${cmd.parent.path}/${name}` });
      if (o.name === 'anchorZ' && !is3DEnabled(node)) {
        fail('invalidArgument', "'anchorZ' needs a 3D layer (per-character 3D)", { layer, path: `${cmd.parent.path}/${name}` });
      }
      return o;
    });
    // AE's per-LAYER limit on animated font axes (across all its animators).
    const used = new Set(data.flatMap((a) => Object.keys(a.axes ?? {})));
    for (const o of opts) if (o.kind === 'axis') used.add(o.tag);
    if (used.size > MAX_ANIMATED_AXES) {
      fail('outOfRange', `a text layer's animators can drive at most ${MAX_ANIMATED_AXES} font axes`, { layer, path: cmd.parent.path });
    }
    const patch: Record<string, unknown> = {};
    let axes: Record<string, number> | undefined;
    for (const o of opts) {
      if (present(cur, o) || o.name in patch || (o.kind === 'axis' && axes && o.tag in axes)) continue;
      if (o.kind === 'axis') {
        axes = { ...(axes ?? cur.axes ?? {}), [o.tag]: 0 };
        patch.axes = axes;
      } else {
        patch[o.name] = o.value;
      }
    }
    return {
      scope: scopeLayer(newScope(), layer),
      label: opts.length === 1 ? 'Add Property' : 'Add Properties',
      apply: () => {
        if (Object.keys(patch).length > 0) updateAnimator(layer, index, patch as Partial<TextAnimatorData>);
        return { paths: cmd.names.map((n) => `${cmd.parent.path}/${n}`) };
      },
    };
  },

  removeProperties: (cmd) => {
    if (cmd.props.length === 0) fail('invalidArgument', 'no properties given');
    const scope = newScope();
    const plans: Array<{ layer: string; animatorId: string; o: Optional }> = [];
    const rigRuns = new Map<string, () => void>();
    for (const p of cmd.props) {
      requireLayer(p.layer);
      const ik = planIkRemoveProperty(p.layer, p.path);
      if (ik) {
        rigRuns.set(ik.key, ik.run);
        scopeLayer(scope, p.layer);
        continue;
      }
      const slash = p.path.lastIndexOf('/');
      const parent = p.path.slice(0, slash);
      const name = p.path.slice(slash + 1);
      const { index, data } = animatorOf(p.layer, parent);
      const o = optionalOf(name);
      if (!o) fail('invalidArgument', `'${p.path}' is not an optional property (it cannot be removed)`, { layer: p.layer, path: p.path });
      if (!present(data[index]!, o)) fail('notFound', `layer '${p.layer}' has no property '${p.path}'`, { layer: p.layer, path: p.path });
      if (plans.some((x) => x.layer === p.layer && x.animatorId === data[index]!.id && x.o.name === o.name)) continue;
      plans.push({ layer: p.layer, animatorId: data[index]!.id, o });
      scopeLayer(scope, p.layer);
    }
    return {
      scope,
      label: plans.length + rigRuns.size === 1 ? 'Remove Property' : 'Remove Properties',
      apply: () => {
        for (const run of rigRuns.values()) run();
        for (const { layer, animatorId, o } of plans) {
          const index = readAnimatorData(graph.getNode(layer)!).findIndex((a) => a.id === animatorId);
          // AE: a deleted property takes its keyframes and expression with it.
          const track = o.kind === 'axis' ? animatorAxisPropPath(index, o.tag) : animatorPropPath(index, o.name as never);
          dropTrackProps(layer, new Set([track]));
          removeAnimatorProperty(layer, index, o.name);
        }
        return {};
      },
    };
  },
};
