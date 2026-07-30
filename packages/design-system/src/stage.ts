/**
 * Stage — masked reveals, scene lighting and depth.
 *
 * The three capabilities the design system had but never used. Each is here
 * rather than inside a template because each has a precondition that is easy to
 * get wrong and expensive to get wrong silently.
 *
 * ## `emitLitStage` and the flag that made lights dead
 *
 * Scene lighting is gated on TWO things in the renderer: the layer's 3D switch,
 * and its `acceptsLights` material flag. The flag defaults to false and, until
 * this work, the only thing that could set it was a checkbox in the inspector —
 * `update_layer` had no material properties at all. So a library could create a
 * light layer, position it, tune its colour and falloff, and not one pixel in
 * the composition would change. Anything here that creates a light also turns
 * both switches on for the layers it is meant to light; a light emitted without
 * them is not a subtle bug, it is a no-op that looks like a feature.
 *
 * ## Depth is parallax, not decoration
 *
 * `emitDepth` assigns z to layers that are already there. It exists because a
 * camera technique cast onto a composition where everything sits at z=0 produces
 * a move with no parallax — the whole frame slides as one plane, which reads as
 * a slide transition rather than a camera. Separating the elements in z is what
 * makes `camera.push_in_slow` and `camera.drift_parallax` do what their names
 * say. The library has had those techniques all along and nothing was ever set
 * up for them to work on.
 *
 * Pure.
 */

import type { ComposeContext } from './compose';
import type { ToolCall } from './toolcall';

/**
 * Reveal a text layer from behind a moving edge.
 *
 * A mask is what separates a headline that FADES from a headline that is
 * uncovered, and the second is the single most recognisable editorial title
 * treatment there is. The mask is emitted at rest — sized to the layer, hard
 * edge — because mask-shape animation is not a tool; a technique animates the
 * layer's position underneath the mask instead, which is how the effect is
 * actually built in practice.
 */
export function emitTypeMask(
  ctx: ComposeContext,
  nodeId: string,
  o: { feather?: number; padding?: number } = {},
): ToolCall[] {
  // A hair of expansion. A mask sized exactly to a text layer clips the
  // overshoot of a descender and the optical overhang of a round letter, and the
  // result reads as a rendering fault rather than as a reveal.
  const pad = o.padding ?? Math.round(ctx.grid.baseline * 0.5);
  return [
    {
      name: 'create_mask',
      args: {
        nodeId,
        shape: 'rectangle',
        mode: 'add',
        feather: o.feather ?? 0,
        expansion: pad,
      },
    },
  ];
}

export interface LitStage {
  calls: ToolCall[];
  /** The key light's layer id, so a technique can animate its intensity. */
  keyId: string;
  /** The fill light's id, or undefined when the look wants a single hard source. */
  fillId?: string;
}

/**
 * A key light, and a fill light unless the look wants one hard source.
 *
 * Two lights, not one and not five. One light is a torch and reads as a bug;
 * beyond two, a still frame cannot tell them apart and each one costs a shading
 * pass. The ratio between them is what actually carries the mood — a tight ratio
 * is soft and corporate, a wide one is dramatic — so that is the parameter.
 */
export function emitLitStage(
  ctx: ComposeContext,
  litNodeIds: readonly string[],
  o: { ratio?: number; keyIntensity?: number } = {},
): LitStage {
  const { palette } = ctx.pack;
  const keyId = `${ctx.idPrefix}_key`;
  const fillId = `${ctx.idPrefix}_fill`;
  const ratio = o.ratio ?? 0.35;
  const keyIntensity = o.keyIntensity ?? 130;
  const radius = Math.round(Math.max(ctx.width, ctx.height) * 1.1);

  const calls: ToolCall[] = [
    { name: 'create_layer', args: { id: keyId, kind: 'light', name: 'Key', x: Math.round(ctx.width * 0.24), y: Math.round(ctx.height * 0.18) } },
    // Warmer than the accent and never the accent itself: a key light the colour
    // of the brand tints every lit surface toward it and the palette stops
    // reading as a palette.
    { name: 'set_light', args: { nodeId: keyId, color: '#fff4e6', intensity: keyIntensity, radius } },
  ];

  let fill: string | undefined;
  if (ratio > 0.05) {
    fill = fillId;
    calls.push(
      { name: 'create_layer', args: { id: fillId, kind: 'light', name: 'Fill', x: Math.round(ctx.width * 0.82), y: Math.round(ctx.height * 0.62) } },
      // The fill is tinted toward the background, because in a real room the
      // fill IS the room — light bounced off whatever surrounds the subject.
      { name: 'set_light', args: { nodeId: fillId, color: palette.surface, intensity: Math.round(keyIntensity * ratio), radius } },
    );
  }

  // The half that makes the lights do anything at all. See the file docstring.
  for (const id of litNodeIds) {
    calls.push({
      name: 'update_layer',
      args: {
        nodeId: id,
        threeD: true,
        acceptsLights: true,
        // Ambient below 100 is what lets a light MATTER — at 100 the layer keeps
        // all of its own colour regardless of what is shining on it, which is
        // indistinguishable from having no lights.
        ambient: 62,
        diffuse: 70,
        specular: ctx.pack.surface.grain > 4 ? 0 : 18,
      },
    });
  }

  return { calls, keyId, ...(fill ? { fillId: fill } : {}) };
}

/**
 * Push layers apart in z so a camera move has something to parallax against.
 *
 * Order is back-to-front: index 0 gets the deepest z. Scaled to the frame so the
 * separation reads the same at any comp size, and capped — past roughly a
 * frame-width of depth, a normal lens starts to distort the layout that was
 * composed in 2D, and the grid work stops meaning anything.
 */
export function emitDepth(
  ctx: ComposeContext,
  orderedIds: readonly string[],
  o: { spread?: number } = {},
): ToolCall[] {
  if (orderedIds.length < 2) return [];
  const span = Math.round(Math.min(ctx.width, ctx.height) * (o.spread ?? 0.35));
  const step = span / (orderedIds.length - 1);
  // One call per layer, with the switch and the value together. `update_layer`
  // applies `threeD` before the transform props precisely so this works — and a
  // one-keyframe `set_keyframes` would set the same value while also leaving an
  // animation track for a later technique to inherit.
  return orderedIds.map((id, i) => ({
    name: 'update_layer',
    args: { nodeId: id, threeD: true, z: Math.round(span - i * step) },
  }));
}
