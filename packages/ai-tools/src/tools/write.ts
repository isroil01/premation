/**
 * Write tools — the editing vocabulary.
 *
 * Two rules shaped this list:
 *
 * 1. **Batch, don't chatter.** `set_keyframes` takes an array because a single
 *    gesture ("fade in and rise") is a dozen keyframes; one call per keyframe
 *    would burn the step budget and cost a round-trip each.
 * 2. **Composition time, always.** Callers pass comp seconds; the handler
 *    converts to layer time. Splitting that responsibility is what let a value
 *    and its easing land at two different times in the old op path.
 */

import type { AiToolDef } from '../types';

/** Shared enum — the engine's real EasingKind union. */
const EASING_ENUM = [
  'linear',
  'step',
  'ease',
  'easeIn',
  'easeOut',
  'easeInOut',
  'bezier',
  'hold',
  'autoBezier',
  'continuousBezier',
] as const;

const PROP_HINT =
  'Property path. Transform: x, y, rotation, scale, scaleX, scaleY, opacity. ' +
  '3D (needs the layer\'s 3D switch): z, rotationX, rotationY. ' +
  'Camera (on a camera layer, no 3D switch needed): x, y, z (dolly), focalLength (zoom), ' +
  'orbitYaw, orbitPitch (rotate around the look-at point), poiX, poiY, poiZ (look-at target), ' +
  'dofStrength, focusDistance, dofAperture (depth of field). ' +
  'Effects: effect.<effectId>. Text animators: ta.<index>.<param>. Time remap: timeRemap. ' +
  'Values are numbers only — opacity is 0..100, rotation is degrees, scale is a multiplier (1 = 100%).';

// ── Structure ─────────────────────────────────────────────────────

/**
 * A caller-supplied handle for a layer that does not exist yet.
 *
 * Without this, a batch of calls cannot reference what it just created: the
 * engine assigns the real id at execution time, so `create_layer` followed by
 * `update_layer` needs a round-trip through the model just to learn the id it is
 * about to use. That is fatal for a library emitter, which produces its whole
 * `ToolCall[]` up front with no model in the loop at all.
 *
 * An alias is local to one run. The handler records `alias → real id` and every
 * later call resolves `nodeId` through that map before touching the scene, so
 * the model may also use one if it finds it convenient.
 */
export const ALIAS_PROP = {
  type: 'string',
  description:
    'Optional handle to refer to this layer in LATER calls in the same batch, before the engine ' +
    'has assigned it a real id. Must be unique within the run.',
} as const;

export const createLayerDef: AiToolDef = {
  name: 'create_layer',
  kind: 'write',
  description:
    'Create a layer and return its id. Use that id — or the `id` handle you passed — for ' +
    'subsequent calls.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'name'],
    properties: {
      id: ALIAS_PROP,
      kind: {
        type: 'string',
        enum: ['shape', 'text', 'solid', 'null', 'group', 'camera', 'light', 'adjustment', 'particle'],
      },
      name: { type: 'string', description: 'Layer name. Make it descriptive — you will refer to it later.' },
      x: { type: 'number', description: 'Centre X in comp px. Defaults to comp centre.' },
      y: { type: 'number', description: 'Centre Y in comp px. Defaults to comp centre.' },
      width: { type: 'number', description: 'Layer width in px. REQUIRED for shape/solid — GPU renderer needs explicit size.' },
      height: { type: 'number', description: 'Layer height in px. REQUIRED for shape/solid — GPU renderer needs explicit size.' },
      text: { type: 'string', description: 'For kind=text: the content.' },
      shape: { type: 'string', enum: ['rect', 'ellipse', 'line', 'star', 'polygon'], description: 'For kind=shape.' },
      fill: { type: 'string', description: 'Hex colour, e.g. #2b7eff.' },
      parent: { type: 'string', description: 'Parent layer id.' },
    },
  },
};

export const deleteLayerDef: AiToolDef = {
  name: 'delete_layer',
  kind: 'write',
  description: 'Delete layers and their descendants.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['nodeIds'],
    properties: {
      nodeIds: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string' } },
    },
  },
};

export const reparentLayerDef: AiToolDef = {
  name: 'reparent_layer',
  kind: 'write',
  description: 'Re-parent a layer. The layer keeps its world position.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['nodeId'],
    properties: {
      nodeId: { type: 'string' },
      parentId: { type: 'string', description: 'Omit or pass null to move to the top level.' },
    },
  },
};

export const updateLayerDef: AiToolDef = {
  name: 'update_layer',
  kind: 'write',
  description:
    'Set static (non-animated) layer properties: name, visibility, lock, text content, colour, ' +
    'base transform. To animate a property use set_keyframes instead.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['nodeId'],
    properties: {
      nodeId: { type: 'string' },
      name: { type: 'string' },
      visible: { type: 'boolean' },
      locked: { type: 'boolean' },
      text: { type: 'string' },
      fontSize: { type: 'number', minimum: 1 },
      fontWeight: { type: 'number' },
      fontFamily: { type: 'string' },
      letterSpacing: {
        type: 'number',
        description:
          'Tracking in px. NEGATIVE for display sizes (roughly −2 to −4% of the font size) and ' +
          'POSITIVE for small text (+2 to +6%). A font\'s default spacing is drawn for body copy, so ' +
          'display type at 0 looks loose and unresolved — this is the single biggest "looks typeset" ' +
          'lever there is, and leaving it at 0 on a headline is the most common typographic tell.',
      },
      lineHeight: {
        type: 'number',
        description:
          'Multiplier, not px. Display type sits TIGHT (0.92–1.05 — at 96px the natural gap is ' +
          'already wider than the eye wants); body copy needs 1.4–1.6. One line-height across both ' +
          'is why generated type reads as a single block.',
      },
      align: { type: 'string', enum: ['left', 'center', 'right'] },
      fill: { type: 'string', description: 'Hex colour.' },
      x: { type: 'number' },
      y: { type: 'number' },
      width: { type: 'number', description: 'Layer width in px. Required for GPU renderer to display the layer.' },
      height: { type: 'number', description: 'Layer height in px. Required for GPU renderer to display the layer.' },
      rotation: { type: 'number', description: 'Degrees.' },
      scaleX: { type: 'number' },
      scaleY: { type: 'number' },
      opacity: { type: 'number', minimum: 0, maximum: 100 },
      cornerRadius: {
        type: 'number',
        minimum: 0,
        description:
          'Corner radius in px, for shape/solid layers. Use a SCALE — 0 / 2 / 6 / 12 / 24 — not ' +
          'arbitrary values; one radius everywhere is as much a tell as a random radius on each.',
      },
      backdropBlur: {
        type: 'number',
        minimum: 0,
        description:
          'Blur what is BEHIND this layer, in px — a frosted-glass panel. Different from the blur ' +
          'effect, which blurs the layer itself. This is how you do a glass card, a translucent ' +
          'sheet, or an iOS-style toolbar; pair it with a low-opacity light fill.',
      },
      threeD: { type: 'boolean', description: 'Enable the 3D switch (required before z/rotationX/rotationY).' },
      motionBlur: { type: 'boolean', description: 'Enable/disable motion blur for smooth movement.' },
      blendMode: {
        type: 'string',
        enum: [
          'normal', 'add', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
          'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference',
          'exclusion', 'hue', 'saturation', 'color', 'luminosity'
        ],
        description: 'Set layer blend mode for advanced composite overlays.'
      },
      matte: {
        type: 'object',
        description: 'Configure track matte using the layer directly above this layer.',
        additionalProperties: false,
        required: ['mode'],
        properties: {
          mode: { type: 'string', enum: ['alpha', 'luma', 'alpha-inv', 'luma-inv'] },
          sourceId: { type: 'string', description: 'The layer id of the matte source layer.' }
        }
      },
      removeMatte: { type: 'boolean', description: 'Set true to remove any track matte.' }
    },
  },
};

// ── Animation ─────────────────────────────────────────────────────

export const setKeyframesDef: AiToolDef = {
  name: 'set_keyframes',
  kind: 'write',
  description:
    'Author keyframes. Batch EVERY keyframe for a gesture into ONE call — do not call once per ' +
    'keyframe. Times are COMPOSITION seconds (layer-time conversion is automatic). ' +
    'A property needs at least 2 keyframes at different times to animate. ' +
    'Easing applies to the segment STARTING at that keyframe.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['keyframes'],
    properties: {
      keyframes: {
        type: 'array',
        minItems: 1,
        maxItems: 200,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['nodeId', 'prop', 't', 'value'],
          properties: {
            nodeId: { type: 'string' },
            prop: { type: 'string', description: PROP_HINT },
            t: { type: 'number', minimum: 0, description: 'Composition seconds.' },
            value: { type: 'number' },
            easing: { type: 'string', enum: EASING_ENUM, default: 'linear' },
            bezier: {
              type: 'array',
              minItems: 4,
              maxItems: 4,
              items: { type: 'number' },
              description:
                'Only with easing="bezier". [x1,y1,x2,y2]; x must be 0..1, y may overshoot ' +
                '(e.g. [0.34,1.56,0.64,1] for a bounce).',
            },
          },
        },
      },
    },
  },
};

export const removeKeyframesDef: AiToolDef = {
  name: 'remove_keyframes',
  kind: 'write',
  description:
    'Remove keyframes. Pass t to remove one, or omit t to clear the whole property track.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['targets'],
    properties: {
      targets: {
        type: 'array',
        minItems: 1,
        maxItems: 200,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['nodeId', 'prop'],
          properties: {
            nodeId: { type: 'string' },
            prop: { type: 'string', description: PROP_HINT },
            t: { type: 'number', minimum: 0, description: 'Composition seconds. Omit to clear the track.' },
          },
        },
      },
    },
  },
};

export const setEasingDef: AiToolDef = {
  name: 'set_easing',
  kind: 'write',
  description:
    'Change easing on keyframes that already exist. Also sets roving. ' +
    'Prefer passing easing inline to set_keyframes when authoring; use this to adjust afterwards.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['targets'],
    properties: {
      targets: {
        type: 'array',
        minItems: 1,
        maxItems: 200,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['nodeId', 'prop', 't'],
          properties: {
            nodeId: { type: 'string' },
            prop: { type: 'string' },
            t: { type: 'number', minimum: 0, description: 'Composition seconds of an EXISTING keyframe.' },
            easing: { type: 'string', enum: EASING_ENUM },
            bezier: { type: 'array', minItems: 4, maxItems: 4, items: { type: 'number' } },
            roving: { type: 'boolean' },
          },
        },
      },
    },
  },
};

export const setExpressionDef: AiToolDef = {
  name: 'set_expression',
  kind: 'write',
  description:
    'Attach an expression to a property. It must be a single JS EXPRESSION returning a number ' +
    '(not a statement body, no return). Available: time, value, wiggle(freq,amp), ' +
    'loopOut("cycle"|"pingpong"|"offset"), valueAtTime(t), velocity, speed, linear/ease/easeIn/easeOut, ' +
    'clamp, random(seed), Math, layer(name, prop), thisComp, thisLayer, audio, ctrl(name). ' +
    'Expressions OVERRIDE keyframed values. Pass an empty string to remove.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['nodeId', 'prop', 'expression'],
    properties: {
      nodeId: { type: 'string' },
      prop: { type: 'string', description: PROP_HINT },
      expression: { type: 'string', description: 'e.g. wiggle(2, 30)  or  value + Math.sin(time * 4) * 10' },
    },
  },
};

// ── Effects + text ────────────────────────────────────────────────

export const addEffectDef: AiToolDef = {
  name: 'add_effect',
  kind: 'write',
  description:
    'Add an effect to a layer and return its effectId. Effects have named params ' +
    '(see list_capabilities for each type\'s params, types and ranges). Animate any ' +
    'numeric param by keyframing the prop path "effect.<effectId>.<paramKey>" (or the ' +
    'legacy "effect.<effectId>" for the primary param). Set static param values with ' +
    'update_effect_param.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['nodeId', 'type'],
    properties: {
      nodeId: { type: 'string' },
      type: {
        type: 'string',
        // Kept in lockstep with EFFECT_DEFS (src/core/effects/effects.ts). The
        // enum can't import from the app, so list_capabilities (which reads the
        // live registry) is the source of truth for params; this is the gate.
        enum: [
          'blur', 'glow', 'drop-shadow', 'brightness', 'contrast', 'saturate',
          'grayscale', 'sepia', 'hue-rotate', 'hue-saturation', 'invert',
          'levels', 'curves', 'posterize', 'tint', 'channel-mixer',
          'gradient-ramp', 'fractal-noise', 'displacement-map', 'motion-tile',
          'fill', 'four-color-gradient', 'stroke', 'beam', 'sharpen', 'noise',
          'keylight', 'echo',
        ],
      },
      amount: { type: 'number', description: 'Initial value for the primary param. Omit for the effect default.' },
    },
  },
};

export const updateEffectDef: AiToolDef = {
  name: 'update_effect',
  kind: 'write',
  description: 'Change or remove an effect on a layer.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['nodeId', 'effectId'],
    properties: {
      nodeId: { type: 'string' },
      effectId: { type: 'string' },
      amount: { type: 'number' },
      remove: { type: 'boolean', default: false },
    },
  },
};

export const textAnimatorDef: AiToolDef = {
  name: 'text_animator',
  kind: 'write',
  description:
    'Add or update a per-character text animator — how you do "type on", "letters fly in", ' +
    '"wave". Only valid on text layers. A range selector [start,end]+offset (percentages) sweeps ' +
    'across characters/words/lines with a falloff shape, applying the transform deltas. ' +
    'Animate the sweep by keyframing "ta.<index>.offset". Returns the animator index.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['nodeId'],
    properties: {
      nodeId: { type: 'string' },
      index: { type: 'integer', minimum: 0, description: 'Omit to add a new animator; pass to update one.' },
      basedOn: { type: 'string', enum: ['characters', 'words', 'lines'], default: 'characters' },
      shape: { type: 'string', enum: ['square', 'rampUp', 'rampDown', 'triangle', 'round', 'smooth'] },
      start: { type: 'number', description: 'Range start, percent.' },
      end: { type: 'number', description: 'Range end, percent.' },
      offset: { type: 'number', description: 'Range offset, percent. Keyframe this to sweep.' },
      x: { type: 'number' },
      y: { type: 'number' },
      scale: { type: 'number' },
      scaleY: { type: 'number', description: 'Non-uniform per-glyph scale. Falls back to scale when omitted.' },
      rotation: { type: 'number' },
      opacity: { type: 'number' },
      tracking: { type: 'number' },
      lineSpacing: { type: 'number', description: 'Extra leading between lines, px.' },
      blur: { type: 'number', minimum: 0, description: 'Per-character blur in px — this is how you do a blur-resolve type-on.' },
      skew: { type: 'number', description: 'Per-character skew in degrees — an italic lean that settles out.' },
      fillOpacity: { type: 'number', description: 'Fade the glyph FILL but not its stroke — an outline-to-solid reveal.' },
      characterOffset: {
        type: 'number',
        description:
          'Shift each covered character N places through its alphabet. A staggered offset that ' +
          'rolls back to 0 is the scramble / decode reveal, and it cannot be faked with transforms.',
      },
      color: { type: 'string', description: 'Hex colour the covered glyphs blend toward.' },
      sweep: {
        type: 'object',
        additionalProperties: false,
        description:
          'Animate the range selector in THIS call instead of a follow-up set_keyframes on ' +
          '"ta.<index>.offset". Sweeping the selector is what makes a text animator animate at ' +
          'all — an animator with a static selector is a static style.',
        required: ['fromSec', 'toSec'],
        properties: {
          fromSec: { type: 'number', minimum: 0, description: 'Composition seconds the sweep starts.' },
          toSec: { type: 'number', minimum: 0, description: 'Composition seconds the sweep ends.' },
          fromOffset: { type: 'number', default: -100, description: 'Selector offset at fromSec, percent.' },
          toOffset: { type: 'number', default: 100, description: 'Selector offset at toSec, percent.' },
          easing: { type: 'string', enum: EASING_ENUM, default: 'bezier' },
          bezier: { type: 'array', minItems: 4, maxItems: 4, items: { type: 'number' } },
        },
      },
      remove: { type: 'boolean', default: false },
    },
  },
};

// ── Media ─────────────────────────────────────────────────────────

export const createMediaDef: AiToolDef = {
  name: 'create_media',
  kind: 'write',
  description:
    'Place an already-imported media asset (image / video / audio) on the canvas as a new layer, ' +
    'and return its id. Call list_assets first to get a real assetId — you cannot import new files, ' +
    'only place ones the user already added. Image/video layers appear at native size, centred; ' +
    'pass x/y to position. Animate the result like any other layer.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['assetId'],
    properties: {
      id: ALIAS_PROP,
      assetId: { type: 'string', description: 'An asset id from list_assets.' },
      x: { type: 'number', description: 'Centre X in comp px. Defaults to comp centre.' },
      y: { type: 'number', description: 'Centre Y in comp px. Defaults to comp centre.' },
    },
  },
};

// ── Masks ─────────────────────────────────────────────────────────

export const createMaskDef: AiToolDef = {
  name: 'create_mask',
  kind: 'write',
  description:
    'Add a vector mask to a layer, clipping what it draws to a rectangle or ellipse — how you do ' +
    'a spotlight, a vignette, a shaped reveal, or "show only part of this". The mask fills the ' +
    "layer's bounds by default; pass width/height to size it smaller. Returns the maskId. " +
    'For a reveal, animate an effect or the layer instead — mask-shape animation is not yet a tool.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['nodeId', 'shape'],
    properties: {
      nodeId: { type: 'string' },
      shape: { type: 'string', enum: ['rectangle', 'ellipse'] },
      mode: {
        type: 'string',
        enum: ['add', 'subtract', 'intersect'],
        default: 'add',
        description: 'add = keep inside; subtract = cut a hole; intersect = keep overlap of masks.',
      },
      width: { type: 'number', minimum: 1, description: 'Mask width in layer px. Defaults to the layer width.' },
      height: { type: 'number', minimum: 1, description: 'Mask height in layer px. Defaults to the layer height.' },
      feather: { type: 'number', minimum: 0, description: 'Edge softness in px. 0 is a hard edge.' },
      opacity: { type: 'number', minimum: 0, maximum: 1, description: 'Mask strength, 0..1. Default 1.' },
      expansion: { type: 'number', description: 'Grow (+) or shrink (−) the shape in px.' },
      inverted: { type: 'boolean', description: 'Clip to the OUTSIDE of the shape instead of the inside.' },
    },
  },
};

// ── Composition + presets ─────────────────────────────────────────

export const updateCompositionDef: AiToolDef = {
  name: 'update_composition',
  kind: 'write',
  description:
    'Change composition settings the user can adjust: duration, frame rate, background. ' +
    'Only do this when the user asks. NOTE: composition WIDTH and HEIGHT are fixed at creation ' +
    'and cannot be changed — design for the frame stated in the context instead.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      fps: { type: 'number', minimum: 1, maximum: 240 },
      durationSeconds: { type: 'number', minimum: 0.1 },
      background: { type: 'string', description: 'Hex colour.' },
    },
  },
};

export const applyPresetDef: AiToolDef = {
  name: 'apply_preset',
  kind: 'write',
  description:
    'Apply a built-in animation preset to a layer at a time. Presets adapt to the layer\'s current ' +
    'position, and 3D presets enable the 3D switch automatically. Call list_presets for names.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['nodeId', 'preset'],
    properties: {
      nodeId: { type: 'string' },
      preset: { type: 'string' },
      atTime: { type: 'number', minimum: 0, default: 0, description: 'Composition seconds.' },
    },
  },
};

export const createMediaFromAttachmentDef: AiToolDef = {
  name: 'create_media_from_attachment',
  kind: 'write',
  description:
    'Place a reference image attached to the user prompt directly onto the canvas as a new image layer, ' +
    'and return its id. Pass index (0 for first attachment). ' +
    'This automatically uploads the image as a project asset and adds it to the composition.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['index'],
    properties: {
      id: ALIAS_PROP,
      index: { type: 'integer', minimum: 0, description: 'Index of the image in the prompt attachments (0-based).' },
      name: { type: 'string', description: 'Descriptive name for the new layer.' },
      x: { type: 'number', description: 'Centre X in comp px. Defaults to comp centre.' },
      y: { type: 'number', description: 'Centre Y in comp px. Defaults to comp centre.' },
    },
  },
};

export const createPuppetRigDef: AiToolDef = {
  name: 'create_puppet_rig',
  kind: 'write',
  description:
    'Create a puppet deformation rig with pins on a layer. Pins are placed in layer-local coordinates centered on the origin (e.g. x from -width/2 to width/2, y from -height/2 to height/2). ' +
    'Returns the pin ids. After rigging, animate each pin via tracks: puppet.<pinId>.rotation (degrees) and puppet.<pinId>.stiffness (>= 0, sharpens falloff) with set_keyframes; puppet.<pinId>.position is a data track driven by canvas pin drags.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['layerId', 'pins'],
    properties: {
      layerId: { type: 'string', description: 'ID of the layer to rig.' },
      pins: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'x', 'y'],
          properties: {
            name: { type: 'string', description: 'Descriptive name for the pin.' },
            x: { type: 'number', description: 'Local X coordinate of the pin.' },
            y: { type: 'number', description: 'Local Y coordinate of the pin.' },
            rotation: { type: 'number', description: 'Optional static rotation in degrees — rotates the deformation rigidly around the pin.' },
            stiffness: { type: 'number', minimum: 0, description: 'Optional static stiffness >= 0 — sharpens this pin\'s influence falloff.' },
          },
        },
        description: 'Placements of puppet pins.',
      },
    },
  },
};

export const setPuppetPinKeyframesDef: AiToolDef = {
  name: 'set_puppet_pin_keyframes',
  kind: 'write',
  description:
    "Animate a puppet pin's POSITION over time by setting keyframes on its points data track (puppet.<pinId>.position). " +
    'Use this after create_puppet_rig to make a rig move — e.g. wave an arm, bounce a character. ' +
    'Coordinates are layer-local, centered on the origin (same space as create_puppet_rig pins). ' +
    'Each keyframe is a moment (timeSec) and the pin position (x, y) at that moment; intermediate frames tween linearly. ' +
    'For rotation/stiffness animation (with easing) use set_keyframes on puppet.<pinId>.rotation / .stiffness instead.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['layerId', 'pinId', 'keyframes'],
    properties: {
      layerId: { type: 'string', description: 'ID of the rigged layer.' },
      pinId: { type: 'string', description: 'ID of the pin to animate (returned by create_puppet_rig).' },
      keyframes: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['timeSec', 'x', 'y'],
          properties: {
            timeSec: { type: 'number', minimum: 0, description: 'Time of this keyframe in seconds.' },
            x: { type: 'number', description: 'Local X of the pin at this time.' },
            y: { type: 'number', description: 'Local Y of the pin at this time.' },
          },
        },
        description: 'Position keyframes for the pin, in time order.',
      },
    },
  },
};

export const mergePathsDef: AiToolDef = {
  name: 'merge_paths',
  kind: 'write',
  description: 'Perform boolean path operations (union, subtract, intersect, exclude) on two or more shape layers.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['op', 'nodeIds'],
    properties: {
      op: {
        type: 'string',
        enum: ['union', 'subtract', 'intersect', 'exclude'],
        description: 'Boolean operation to apply.',
      },
      nodeIds: {
        type: 'array',
        minItems: 2,
        maxItems: 50,
        items: { type: 'string' },
        description: 'Shape layer IDs to merge (first selected is the base layer).',
      },
    },
  },
};

export const setTrimPathDef: AiToolDef = {
  name: 'set_trim_path',
  kind: 'write',
  description: 'Configure or keyframe trim path properties (start, end, offset) on a shape layer.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['nodeId'],
    properties: {
      nodeId: { type: 'string', description: 'ID of the shape layer.' },
      start: { type: 'number', minimum: 0, maximum: 100, description: 'Trim start percentage (0..100).' },
      end: { type: 'number', minimum: 0, maximum: 100, description: 'Trim end percentage (0..100).' },
      offset: { type: 'number', description: 'Trim offset angle in degrees.' },
    },
  },
};

export const addRepeaterDef: AiToolDef = {
  name: 'add_repeater',
  kind: 'write',
  description: 'Add or update an AE-style Repeater shape operator (copies, position/rotation/scale offset per copy).',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['nodeId'],
    properties: {
      nodeId: { type: 'string', description: 'ID of the shape layer.' },
      copies: { type: 'number', minimum: 1, maximum: 100, description: 'Number of repeater copies.' },
      positionX: { type: 'number', description: 'X offset per copy.' },
      positionY: { type: 'number', description: 'Y offset per copy.' },
      rotation: { type: 'number', description: 'Rotation offset per copy in degrees.' },
      scaleX: { type: 'number', description: 'Scale X multiplier per copy (1 = 100%).' },
      scaleY: { type: 'number', description: 'Scale Y multiplier per copy (1 = 100%).' },
      startOpacity: { type: 'number', minimum: 0, maximum: 100, description: 'Start opacity 0..100.' },
      endOpacity: { type: 'number', minimum: 0, maximum: 100, description: 'End opacity 0..100.' },
    },
  },
};

export const addPathOperatorDef: AiToolDef = {
  name: 'add_path_operator',
  kind: 'write',
  description: 'Apply procedural path distortion operators (zigzag, puckerBloat, twist, roundCorners) to a shape layer.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['nodeId', 'op'],
    properties: {
      nodeId: { type: 'string', description: 'ID of the shape layer.' },
      op: {
        type: 'string',
        enum: ['zigzag', 'puckerBloat', 'twist', 'roundCorners'],
        description: 'Path operator algorithm.',
      },
      amount: { type: 'number', description: 'Strength/radius of the deformation.' },
    },
  },
};

export const setTextOnPathDef: AiToolDef = {
  name: 'set_text_on_path',
  kind: 'write',
  description: 'Align a text layer to follow a vector Bezier path shape layer.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['nodeId', 'pathNodeId'],
    properties: {
      nodeId: { type: 'string', description: 'ID of the text layer.' },
      pathNodeId: { type: 'string', description: 'ID of the shape path layer to follow.' },
      align: { type: 'string', enum: ['left', 'center', 'right'], description: 'Alignment along path.' },
    },
  },
};

export const createSkeletonRigDef: AiToolDef = {
  name: 'create_skeleton_rig',
  kind: 'write',
  description: 'Create a 2D skeleton bone hierarchy on a layer for character rigging and kinematics.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['layerId', 'bones'],
    properties: {
      layerId: { type: 'string', description: 'ID of the layer to rig.' },
      bones: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'length'],
          properties: {
            id: { type: 'string', description: 'Bone ID.' },
            parentId: { type: 'string', description: 'Parent bone ID, or null if root bone.' },
            length: { type: 'number', minimum: 1, description: 'Bone length in px.' },
            x: { type: 'number', description: 'Bone local root X.' },
            y: { type: 'number', description: 'Bone local root Y.' },
            rotation: { type: 'number', description: 'Bone local rotation in degrees.' },
          },
        },
        description: 'Hierarchy of bones defining the skeleton.',
      },
    },
  },
};

export const poseSkeletonDef: AiToolDef = {
  name: 'pose_skeleton',
  kind: 'write',
  description: 'Animate or pose skeleton bones over time by setting keyframes on bone tracks (bone.<boneId>.rotation / .x / .y).',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['layerId', 'bonePoses'],
    properties: {
      layerId: { type: 'string', description: 'ID of the rigged layer.' },
      bonePoses: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['boneId', 'timeSec', 'rotation'],
          properties: {
            boneId: { type: 'string', description: 'ID of the bone to pose.' },
            timeSec: { type: 'number', minimum: 0, description: 'Time of keyframe in seconds.' },
            rotation: { type: 'number', description: 'Rotation angle in degrees.' },
            x: { type: 'number', description: 'Optional X translation offset.' },
            y: { type: 'number', description: 'Optional Y translation offset.' },
          },
        },
        description: 'Bone pose keyframes in time order.',
      },
    },
  },
};

export const WRITE_TOOL_DEFS: readonly AiToolDef[] = [
  createLayerDef,
  deleteLayerDef,
  reparentLayerDef,
  updateLayerDef,
  setKeyframesDef,
  removeKeyframesDef,
  setEasingDef,
  setExpressionDef,
  addEffectDef,
  updateEffectDef,
  textAnimatorDef,
  createMediaDef,
  createMediaFromAttachmentDef,
  createMaskDef,
  updateCompositionDef,
  applyPresetDef,
  createPuppetRigDef,
  setPuppetPinKeyframesDef,
  mergePathsDef,
  setTrimPathDef,
  addRepeaterDef,
  addPathOperatorDef,
  setTextOnPathDef,
  createSkeletonRigDef,
  poseSkeletonDef,
];

