/**
 * Craft primitives — the tools a *technique* needs that a *recipe* did not.
 *
 * Everything here came out of `docs/ai/PRIMITIVE_AUDIT.md`, and the audit's
 * central finding shaped the list: most of what the re-architecture spec called
 * "missing entirely" was already in the engine and simply **unreachable from the
 * tool surface**. So this file is mostly *exposure* work, plus two genuinely new
 * primitives (`set_spring`, `set_shadow_stack`).
 *
 * Deliberate omissions, so nobody re-adds them:
 *
 *  • `set_track_matte` / `set_blend_mode` / `create_adjustment_layer` /
 *    `create_null` — all already reachable (`update_layer.matte`,
 *    `update_layer.blendMode`, `create_layer kind:'adjustment'|'null'`). Adding
 *    aliases would give the model two ways to do one thing and split the
 *    examples it learns from.
 *  • `apply_grid` / `set_optical_align` — pure arithmetic over comp dimensions.
 *    `@motion/design-system` computes the coordinates and emits `update_layer`.
 *    A tool would move maths server-side for no gain.
 *  • `set_easing` / `set_keyframes` rewrites — the audit found both already
 *    accept per-property bezier with real value overshoot. The spec's proposed
 *    signatures would have *lost* capability (`roving`, the preset enum,
 *    multi-node batching).
 *
 * All are `kind: 'write'`. The `compose` kind is reserved for the generic recipe
 * layer that the technique library replaces; a primitive is never `compose`, and
 * counting these as compose would inflate the very ratio Phase 2.5 retires.
 */

import type { AiToolDef } from '../types';
import { ALIAS_PROP } from './write';

// ── Timing & structure ────────────────────────────────────────────────

export const setSpringDef: AiToolDef = {
  name: 'set_spring',
  kind: 'write',
  description:
    'Animate a property with SPRING physics instead of a bezier, baking the solved curve to ' +
    'keyframes. Use this for anything that should feel physical — UI state changes, cards, ' +
    'toggles, sheets, a knob settling. A bezier reaches its target once; a spring crosses it, ' +
    'comes back, and the ratio between those excursions is what reads as mass. ' +
    'Presets: gentle (no overshoot — use for shadows, colour, blur), snappy (≈2% overshoot, the ' +
    'right default for UI), bouncy (≈10% — expressive, TOO MUCH for product UI), stiff, molasses. ' +
    'Per-property springs are the point: a card\'s scale can be snappy while its shadow is gentle.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['nodeId', 'prop', 'from', 'to'],
    properties: {
      nodeId: { type: 'string' },
      prop: { type: 'string', description: 'Property path, same vocabulary as set_keyframes.' },
      from: { type: 'number' },
      to: { type: 'number' },
      startSec: { type: 'number', minimum: 0, default: 0, description: 'When the spring starts, composition seconds.' },
      preset: {
        type: 'string',
        enum: ['gentle', 'snappy', 'bouncy', 'stiff', 'molasses'],
        description: 'Designer-facing spring. Omit and pass stiffness/damping/mass for explicit physics.',
      },
      stiffness: { type: 'number', minimum: 1, maximum: 2000, description: 'Higher = faster and tighter.' },
      damping: { type: 'number', minimum: 0.1, maximum: 200, description: 'Higher = less bounce. Critical = 2·√(stiffness·mass).' },
      mass: { type: 'number', minimum: 0.1, maximum: 20, default: 1 },
      velocity: { type: 'number', description: 'Initial velocity in value-units/sec — for a spring handed off from a gesture.' },
      maxDurationSec: { type: 'number', minimum: 0.1, maximum: 10, default: 4, description: 'Hard cap; an under-damped spring is truncated rather than baking forever.' },
    },
  },
};

export const setMotionBlurDef: AiToolDef = {
  name: 'set_motion_blur',
  kind: 'write',
  description:
    'Configure motion blur. This is the single biggest "looks rendered vs looks cheap" lever, and ' +
    'the shutter settings that decide it are COMPOSITION-level — per-layer motionBlur is only an ' +
    'opt-in switch. Film default is shutterAngle 180. Use 16+ samples on fast moves or they band. ' +
    'Pass nodeId to toggle one layer; omit it to set the composition shutter. ' +
    'Do NOT enable this on product-UI elements — real interfaces do not blur, and it reads as fake.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      nodeId: { type: 'string', description: 'Toggle this layer\'s opt-in switch. Omit for composition settings.' },
      enabled: { type: 'boolean' },
      shutterAngle: { type: 'number', minimum: 0, maximum: 360, description: 'Composition only. 180 = film. Higher = more blur.' },
      shutterPhase: { type: 'number', minimum: -360, maximum: 360, description: 'Composition only. -90 centres the blur on the frame.' },
      samples: { type: 'number', minimum: 2, maximum: 64, description: 'Composition only. 8 default; 16+ for fast motion.' },
    },
  },
};

export const createPrecompDef: AiToolDef = {
  name: 'create_precomp',
  kind: 'write',
  description:
    'Wrap layers into a nested composition and return the new precomp layer id. ' +
    'Nesting is how a piece gets complex without the tool-call count exploding: one transform on ' +
    'the precomp moves everything inside, one opacity fades the whole group, and set_time_remap on ' +
    'it retimes the entire subtree. Reach for this whenever you are about to apply the same ' +
    'transform to four sibling layers.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['nodeIds', 'name'],
    properties: {
      id: { type: 'string', description: 'Optional handle to refer to this layer in later calls in the same batch.' },
      nodeIds: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string' } },
      name: { type: 'string', description: 'Descriptive name — you will refer to the precomp by id, but a human reads this.' },
    },
  },
};

export const setTimeRemapDef: AiToolDef = {
  name: 'set_time_remap',
  kind: 'write',
  description:
    'Remap a precomp/group\'s internal time — speed ramps, freeze frames, reverse, stutter. ' +
    'Each key maps a COMPOSITION time to a SOURCE time inside the layer. ' +
    'Equal deltas = normal speed; a flat run = a freeze frame; decreasing source time = reverse. ' +
    'Only valid on group/precomp layers (use create_precomp first).',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['nodeId', 'keys'],
    properties: {
      nodeId: { type: 'string' },
      keys: {
        type: 'array',
        minItems: 2,
        maxItems: 100,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['t', 'sourceT'],
          properties: {
            t: { type: 'number', minimum: 0, description: 'Composition seconds.' },
            sourceT: { type: 'number', minimum: 0, description: 'Source time inside the layer, seconds.' },
            easing: {
              type: 'string',
              enum: ['linear', 'bezier', 'hold'],
              default: 'linear',
              description: 'Use bezier for a smooth speed ramp; hold for a hard freeze.',
            },
            bezier: { type: 'array', minItems: 4, maxItems: 4, items: { type: 'number' } },
          },
        },
      },
    },
  },
};

export const updateEffectParamDef: AiToolDef = {
  name: 'update_effect_param',
  kind: 'write',
  description:
    'Set a NAMED parameter on an effect — the only way to reach anything but an effect\'s primary ' +
    'value. A drop-shadow has distance, angle, softness, color and opacity; update_effect can only ' +
    'set one of them. Call list_capabilities("effects") for each type\'s parameter keys and ranges. ' +
    'To ANIMATE a numeric param, keyframe "effect.<effectId>.<key>" with set_keyframes instead.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['nodeId', 'effectId', 'key', 'value'],
    properties: {
      nodeId: { type: 'string' },
      effectId: { type: 'string', description: 'Returned by add_effect.' },
      key: { type: 'string', description: 'Parameter key, e.g. "softness", "angle", "color".' },
      value: { description: 'Number for numeric params, hex string for colours, boolean for checkboxes.' },
    },
  },
};

export const setLightDef: AiToolDef = {
  name: 'set_light',
  kind: 'write',
  description:
    'Configure a light layer created with create_layer kind:"light" — colour, intensity, falloff ' +
    'radius, and cone angle. Without this a light could be positioned but not tuned, so every ' +
    '3D scene got the same default lighting. Keyframe "intensity" or "radius" with set_keyframes ' +
    'for a pulse or a reveal.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['nodeId'],
    properties: {
      nodeId: { type: 'string' },
      color: { type: 'string', description: 'Hex colour of the light.' },
      intensity: { type: 'number', minimum: 0, maximum: 400, description: 'Percent. 100 is neutral.' },
      radius: { type: 'number', minimum: 0, description: 'Falloff radius in px.' },
      coneAngle: { type: 'number', minimum: 0, maximum: 180, description: 'For a spot light, degrees.' },
    },
  },
};

// ── Design / surface primitives (Phase 2B prerequisites) ──────────────

export const setShadowStackDef: AiToolDef = {
  name: 'set_shadow_stack',
  kind: 'write',
  description:
    'Apply a LAYERED shadow stack — several shadows at once, not one. This is the difference ' +
    'between depth and a CSS default: real elevation is a tight contact shadow, a mid shadow, and ' +
    'a wide ambient one, each with its own softness and opacity. A single drop-shadow always reads ' +
    'as flat. Tint the colour toward the BACKGROUND hue rather than neutral black — pure black ' +
    'shadows are one of the strongest "made by a program" tells. Replaces any existing stack.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['nodeId', 'shadows'],
    properties: {
      nodeId: { type: 'string' },
      shadows: {
        type: 'array',
        minItems: 1,
        maxItems: 6,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['distance', 'softness', 'opacity'],
          properties: {
            distance: { type: 'number', minimum: 0, maximum: 200, description: 'Offset in px.' },
            angle: { type: 'number', minimum: 0, maximum: 360, default: 90, description: 'Degrees; 90 = straight down.' },
            softness: { type: 'number', minimum: 0, maximum: 100, description: 'Blur radius in px.' },
            opacity: { type: 'number', minimum: 0, maximum: 100 },
            color: { type: 'string', description: 'Hex. Tint toward the background hue, not #000000.' },
          },
        },
      },
    },
  },
};

export const addSurfaceTreatmentDef: AiToolDef = {
  name: 'add_surface_treatment',
  kind: 'write',
  description:
    'Add a frame-wide surface pass on an adjustment layer: film grain, vignette, and/or a soft ' +
    'light gradient. Flat vector output is the clearest "generated" signal there is, and this is ' +
    'the cheapest fix for it — grain at 2–5%, vignette at 4–8%. Costs one layer and is ' +
    'disproportionately responsible for a piece looking shot rather than drawn. ' +
    'Call this once per composition, after the background exists. Returns the layer id.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', description: 'Optional handle to refer to this layer in later calls in the same batch.' },
      grain: { type: 'number', minimum: 0, maximum: 20, description: 'Grain amount, percent. 2–5 is the useful range; above 8 reads as noise.' },
      grainAnimated: { type: 'boolean', default: true, description: 'Evolve the grain per frame. Static grain looks like a dirty lens.' },
      vignette: { type: 'number', minimum: 0, maximum: 40, description: 'Vignette strength, percent. 4–8 typical.' },
      chromaticAberration: { type: 'number', minimum: 0, maximum: 10, description: 'Edge colour fringing, px. Use sparingly — 1–2.' },
      name: { type: 'string', default: 'Surface Treatment' },
    },
  },
};

export const createGradientDef: AiToolDef = {
  name: 'create_gradient',
  kind: 'write',
  description:
    'Create a full-frame gradient backdrop from 2–4 colour stops and return the layer id. ' +
    'Pass stops that were computed in OKLCH — interpolating in sRGB is what produces the grey ' +
    'dead-zone in the middle of every amateur gradient, so supply the midpoint colour explicitly ' +
    'rather than letting two endpoints be blended naively. ' +
    'A composition should never have a truly flat background fill.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['stops'],
    properties: {
      id: { type: 'string', description: 'Optional handle to refer to this layer in later calls in the same batch.' },
      stops: {
        type: 'array',
        minItems: 2,
        maxItems: 4,
        items: { type: 'string', description: 'Hex colour, in order from start to end.' },
      },
      kind: { type: 'string', enum: ['linear', 'radial', 'corners'], default: 'linear' },
      angle: { type: 'number', description: 'Degrees, for kind=linear. 90 = top to bottom.' },
      name: { type: 'string', default: 'Gradient' },
    },
  },
};

/**
 * NOT added: `set_corner_smoothing`.
 *
 * The design system wants squircles — continuous-curvature corners, iOS-style —
 * because a plain arc corner has a curvature discontinuity where it meets the
 * straight edge, and that is why default rounded rectangles look slightly cheap
 * at large radii. But the engine has no such thing: `cornerRadius` is read by
 * `buildSnapshot` and rasterized as a plain arc, and there is no smoothing
 * parameter anywhere in the render path.
 *
 * A tool that accepted `smoothing` would write a prop nothing reads — the
 * silent-no-op failure mode this whole facade design exists to prevent. So
 * `cornerRadius` (and `backdropBlur`, which IS fully wired) live on
 * `update_layer` where the other static layer props are, and squircles stay
 * ABSENT in the audit until the rasterizer grows a superellipse path.
 */

export const CRAFT_TOOL_DEFS: readonly AiToolDef[] = [
  setSpringDef,
  setMotionBlurDef,
  createPrecompDef,
  setTimeRemapDef,
  updateEffectParamDef,
  setLightDef,
  setShadowStackDef,
  addSurfaceTreatmentDef,
  createGradientDef,
];

// ── Late-registered tools, brought into the single source of truth ─────
//
// These five were defined inline in `buildAiTools()` and pushed onto the
// registry directly, bypassing `ALL_TOOL_DEFS`. That gave the tool surface TWO
// sources of truth: the emitters, the backend's tool catalogue, and every drift
// check read the static list and never saw them. Moving them here is what makes
// "one definition per tool" true rather than aspirational.

export const applyLayerStyleDef: AiToolDef = {
  name: 'apply_layer_style',
  kind: 'write',
  description:
    'Apply an outer glow or a drop shadow to a layer. For real depth prefer set_shadow_stack, ' +
    'which emits a LAYERED stack — a single drop shadow reads as a CSS default however it is tuned.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['nodeId', 'styleType', 'color'],
    properties: {
      nodeId: { type: 'string', description: 'The layer to style.' },
      styleType: { type: 'string', enum: ['drop_shadow', 'outer_glow'] },
      color: { type: 'string', description: 'Hex colour.' },
      opacity: { type: 'number', minimum: 0, maximum: 1, description: 'Opacity 0..1.' },
      size: { type: 'number', minimum: 0, description: 'Blur radius or glow size, px.' },
      distance: { type: 'number', description: 'Shadow offset distance, px. Shadow only.' },
      angle: { type: 'number', description: 'Shadow offset angle, degrees. Shadow only.' },
    },
  },
};

export const recolorLottieVectorDef: AiToolDef = {
  name: 'recolor_lottie_vector',
  kind: 'write',
  description:
    'Recolour every vector shape inside a Lottie or group hierarchy, recursively — how you bring an ' +
    'imported animation onto the brand palette without touching each path.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['nodeId', 'color'],
    properties: {
      nodeId: { type: 'string', description: 'The root Lottie or group layer id.' },
      color: { type: 'string', description: 'Hex colour to apply.' },
    },
  },
};

export const addLogoRevealDef: AiToolDef = {
  name: 'add_logo_reveal',
  kind: 'compose',
  description:
    'Build a trim-path stroke-outline logo reveal: the outline draws itself, an emblem pops, and a ' +
    'title enters behind it.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['text'],
    properties: {
      text: { type: 'string', description: 'Brand or product title.' },
      shape: { type: 'string', enum: ['ellipse', 'star', 'rect'], description: 'Outline shape.' },
      style: { type: 'string', description: 'Motion style name (premium, cyberpunk, saas, apple…).' },
    },
  },
};

export const addRadialBurstDef: AiToolDef = {
  name: 'add_radial_burst',
  kind: 'compose',
  description: 'Add a radial repeater burst accent — a HUD ring or particle fan.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      count: { type: 'integer', minimum: 4, maximum: 16, description: 'Repeater copies.' },
      x: { type: 'number', description: 'Centre X.' },
      y: { type: 'number', description: 'Centre Y.' },
      style: { type: 'string', description: 'Motion style name.' },
    },
  },
};

export const addPathMorphDef: AiToolDef = {
  name: 'add_path_morph',
  kind: 'compose',
  description: 'Create a fluid organic morphing shape via a pucker/bloat or zigzag path distortion.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      op: { type: 'string', enum: ['puckerBloat', 'zigzag'], description: 'Distortion operator.' },
      amount: { type: 'number', description: 'Distortion intensity.' },
      style: { type: 'string', description: 'Motion style name.' },
    },
  },
};

// ── Generated imagery ─────────────────────────────────────────────

export const generateVideoDef: AiToolDef = {
  name: 'generate_video',
  kind: 'write',
  description:
    'Generate a short video clip from a text description and place it on the canvas. ' +
    'Use for b-roll, texture plates, or hero footage the user has not supplied. ' +
    'COSTS REAL MONEY and takes 30–120 seconds — one clip per call, subject and look only, not layout.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['prompt'],
    properties: {
      id: ALIAS_PROP,
      prompt: { type: 'string', description: 'What to depict and how it should look. 8–2000 characters.' },
      durationSec: { type: 'number', description: 'Clip length in seconds (3–10). Defaults to 5.' },
      x: { type: 'number', description: 'Centre X in comp px.' },
      y: { type: 'number', description: 'Centre Y in comp px.' },
    },
  },
};

export const generateSpeechDef: AiToolDef = {
  name: 'generate_speech',
  kind: 'write',
  description:
    'Generate spoken voice-over from text and add it as an audio layer. ' +
    'Use for narration, VO, or dialogue when no recording exists. COSTS REAL MONEY per call.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['text'],
    properties: {
      text: { type: 'string', description: 'The words to speak. 1–5000 characters.' },
      voiceId: { type: 'string', description: 'Optional ElevenLabs voice id. Omit for the default voice.' },
    },
  },
};

export const generate3dModelDef: AiToolDef = {
  name: 'generate_3d_model',
  kind: 'write',
  description:
    'Generate a 3D model from a text description and import it into the asset library as GLB. ' +
    'Use for product meshes, props, or logo extrusions. COSTS REAL MONEY and may take several minutes.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['prompt'],
    properties: {
      prompt: { type: 'string', description: 'Object to model — shape, material, style. 8–2000 characters.' },
      name: { type: 'string', description: 'Asset name in the library.' },
    },
  },
};

export const exportVideoDef: AiToolDef = {
  name: 'export_video',
  kind: 'write',
  description:
    'Queue a Render Queue job for the current composition (default), or encode immediately. ' +
    'Use when the user asks to export, render, or deliver the finished piece. Does not change the scene.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      format: { type: 'string', enum: ['mp4', 'webm', 'gif'], default: 'mp4', description: 'Output container.' },
      quality: { type: 'string', enum: ['high', 'medium', 'draft'], default: 'high', description: 'Encoder quality.' },
      useWorkArea: { type: 'boolean', default: true, description: 'When true, export the timeline work area if set.' },
      mode: {
        type: 'string',
        enum: ['queue', 'immediate'],
        default: 'queue',
        description: 'queue adds a Render Queue job; immediate encodes and downloads now.',
      },
    },
  },
};

export const generateImageDef: AiToolDef = {
  name: 'generate_image',
  kind: 'write',
  description:
    'Generate an image from a text description and place it on the canvas as a new layer. ' +
    'Use this when the piece needs imagery the user has not supplied — a product shot, a texture, ' +
    'a background plate, an illustration. COSTS REAL MONEY and takes several seconds, so call it ' +
    'for content that carries the piece, never for something a shape layer would do. ' +
    'Describe the SUBJECT and the LOOK (lighting, material, mood, camera), not the composition — ' +
    'the layout decides where it sits. Do not ask for text inside the image; type belongs on its ' +
    'own layer where it stays sharp and editable. One image per call.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['prompt'],
    properties: {
      id: ALIAS_PROP,
      prompt: {
        type: 'string',
        // Length is bounded by the backend DTO (8..2000), not here: `JsonSchema`
        // has no length keywords, and inventing them would emit a constraint the
        // provider adapters silently drop — a bound that looks enforced and is
        // not is worse than one stated in the description.
        description:
          'What to depict, and how it should look. Subject and treatment, not layout. 8–2000 characters.',
      },
      aspect: {
        type: 'string',
        enum: ['square', 'landscape', 'portrait'],
        default: 'landscape',
        description: 'Frame shape. Match the slot the image will occupy.',
      },
      x: { type: 'number', description: 'Centre X in comp px. Defaults to comp centre.' },
      y: { type: 'number', description: 'Centre Y in comp px. Defaults to comp centre.' },
    },
  },
};

// ── Vector and audio ──────────────────────────────────────────────

export const importSvgDef: AiToolDef = {
  name: 'import_svg',
  kind: 'write',
  description:
    'Create a layer from SVG markup you write yourself — logos, icons, diagrams, arrows, ' +
    'badges, decorative marks. Prefer this over building the same shape out of rectangles and ' +
    'ellipses: one path is one layer, it scales without resampling, and it can be converted to ' +
    'editable shapes later. Markup is sanitized server-side of the renderer, so scripts, external ' +
    'references and remote images are stripped — write self-contained SVG with inline geometry ' +
    'and no <image href> or <script>.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['markup', 'name'],
    properties: {
      id: ALIAS_PROP,
      markup: {
        type: 'string',
        description: 'A complete <svg> element, with a viewBox. Self-contained: no external refs.',
      },
      name: { type: 'string', description: 'Layer name.' },
      x: { type: 'number', description: 'Centre X in comp px. Defaults to comp centre.' },
      y: { type: 'number', description: 'Centre Y in comp px. Defaults to comp centre.' },
    },
  },
};

export const analyseAudioDef: AiToolDef = {
  name: 'analyse_audio',
  kind: 'read',
  description:
    'Detect tempo, the beat grid and transient onsets in an audio layer already in the scene. ' +
    'Use this BEFORE timing anything to music: it returns the beat times in composition seconds, ' +
    'so entrances and cuts can be placed on them rather than on a stopwatch. ' +
    'Check `tempoConfidence` — below about 0.25 there is no reliable tempo (speech, ambience, a ' +
    'sustained pad), and you should time from the brief instead of forcing a grid that is not there.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['nodeId'],
    properties: {
      nodeId: { type: 'string', description: 'An audio layer id, from describe_scene.' },
      maxBeats: {
        type: 'integer',
        minimum: 1,
        maximum: 512,
        default: 128,
        description: 'Cap on how many beat times to return, so a long track does not flood the context.',
      },
    },
  },
};

export const LATE_TOOL_DEFS: readonly AiToolDef[] = [
  generateImageDef,
  generateVideoDef,
  generateSpeechDef,
  generate3dModelDef,
  exportVideoDef,
  importSvgDef,
  analyseAudioDef,
  applyLayerStyleDef,
  recolorLottieVectorDef,
  addLogoRevealDef,
  addRadialBurstDef,
  addPathMorphDef,
];
