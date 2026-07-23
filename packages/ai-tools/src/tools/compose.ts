/**
 * High-level composition tools (Tool Intelligence).
 *
 * These are the tools the AI should PREFER. Each one builds a whole, correctly
 * designed element — laid out in the composition, animated with a staggered
 * entrance, eased and styled from the design system — instead of the model
 * hand-authoring dozens of raw keyframes and getting position/timing/depth
 * wrong. They compile down to the same primitives; they just encode the craft.
 *
 * `style` accepts a named aesthetic (premium / minimal / bold / playful, or
 * loose words like "apple", "luxury", "startup"); it resolves to a curated set
 * of palette, type scale, and motion tokens.
 */

import type { AiToolDef } from '../types';

const STYLE_PROP = {
  type: 'string',
  description:
    'Aesthetic: premium (Apple-like), minimal, bold, playful, cyberpunk, or saas. Also accepts apple/luxury/corporate/startup/fun. ' +
    'Pass "custom" (or omit) to use the style defined by define_style when one exists. Default premium.',
} as const;

/** How the element enters. Omitting it is NOT always-rise — the recipe varies the pick per run. */
const ENTRANCE_PROP = {
  type: 'string',
  enum: ['rise', 'scale_pop', 'blur_resolve', 'slide_settle', 'mask_wipe', 'char_cascade'],
  description:
    'Entrance archetype: rise (fade up from below), scale_pop (0.85→overshoot→1), blur_resolve (blur 12→0 + fade), ' +
    'slide_settle (directional slide with settle), mask_wipe (clip-style reveal), char_cascade (per-character type-on, text only). ' +
    'Omit for a varied auto-pick keyed to role + style + this run. Set it when the brief calls for a specific feel.',
} as const;

/** Binds a content element to a scene opened by add_scene, so it enters at that
 *  scene's start and exits at its end — no matter the call order. */
const SCENE_PROP = {
  type: 'integer',
  minimum: 1,
  description: 'The scene number (from add_scene) this belongs to. Pass it on EVERY content call in a multi-scene video so the element lands in the right scene. Omit only for a single-scene piece.',
} as const;

export const addBackgroundDef: AiToolDef = {
  name: 'add_background',
  kind: 'write',
  description:
    'Create ONE full-composition background for a SINGLE-scene piece. ' +
    'Do NOT use this in a multi-scene video — add_scene already gives each scene its own ' +
    'background, and a full-comp background on top would flatten them. Returns the layer id.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      style: STYLE_PROP,
      color: { type: 'string', description: 'Override hex colour. Omit to use the style background.' },
    },
  },
};

export const addTitleDef: AiToolDef = {
  name: 'add_title',
  kind: 'write',
  description:
    'Add a headline, subtitle, or tagline that is positioned in the layout and animated in with a ' +
    'staggered fade-and-rise (and a glow on titles). Successive calls auto-stagger so nothing appears ' +
    'at once. Use this instead of create_layer + set_keyframes for text. Returns the layer id.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['text'],
    properties: {
      text: { type: 'string' },
      level: { type: 'string', enum: ['title', 'subtitle', 'tagline'], default: 'title' },
      scene: SCENE_PROP,
      style: STYLE_PROP,
      entrance: ENTRANCE_PROP,
      y: { type: 'number', description: 'Optional centre Y in comp px. Omit to auto-place by level.' },
    },
  },
};

export const addEmblemDef: AiToolDef = {
  name: 'add_emblem',
  kind: 'write',
  description:
    'Add a glowing circular emblem/badge that scales up with an overshoot and gently pulses — a logo ' +
    'mark or focal accent. Returns the layer id.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      scene: SCENE_PROP,
      style: STYLE_PROP,
      entrance: ENTRANCE_PROP,
      y: { type: 'number', description: 'Centre Y in comp px. Omit to auto-place in the upper third.' },
      size: { type: 'number', description: 'Diameter in px. Omit for a comp-relative default.' },
    },
  },
};

export const addCardsDef: AiToolDef = {
  name: 'add_cards',
  kind: 'write',
  description:
    'Add a centred row of evenly-spaced cards that stagger in — the backbone of feature grids, ' +
    'pricing tiers, and step sequences. Returns the card ids so you can place text or icons on each. ' +
    'Use this instead of hand-placing rectangles.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      count: { type: 'integer', minimum: 1, maximum: 8, default: 3 },
      scene: SCENE_PROP,
      style: STYLE_PROP,
      entrance: ENTRANCE_PROP,
      y: { type: 'number', description: 'Row centre Y in comp px. Omit to centre vertically.' },
    },
  },
};

export const staggerInDef: AiToolDef = {
  name: 'stagger_in',
  kind: 'write',
  description:
    'Give existing layers a staggered fade-and-rise entrance (each offset from the last), so a group ' +
    'of elements enters with rhythm instead of all at once. Pass the layer ids in the order they should appear.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['nodeIds'],
    properties: {
      nodeIds: { type: 'array', minItems: 1, maxItems: 60, items: { type: 'string' } },
      style: STYLE_PROP,
      entrance: ENTRANCE_PROP,
    },
  },
};

export const defineStyleDef: AiToolDef = {
  name: 'define_style',
  kind: 'write',
  description:
    'Define THIS run\'s custom motion style — palette, type scale, easing personality, pacing — derived from the ' +
    'brief instead of a preset. Call it FIRST, before compose tools, whenever the brief names brand colours, a mood, ' +
    'or an industry that the presets do not match. Subsequent compose calls that omit style (or pass "custom") use it. ' +
    'Any field you omit is filled from the closest preset anchor (basedOn), so a single accent colour is enough.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', description: 'A short name for the style (default "custom").' },
      brief: { type: 'string', description: 'Free-text brief (brand colours, mood words) to derive unspecified fields from.' },
      basedOn: { type: 'string', description: 'Preset anchor supplying defaults: premium/minimal/bold/playful/cyberpunk/saas.' },
      palette: {
        type: 'object',
        additionalProperties: false,
        description: 'Hex colours. Give at least accent; the rest can be derived from it.',
        properties: {
          bg: { type: 'string' },
          bgAccent: { type: 'string' },
          card: { type: 'string' },
          fg: { type: 'string' },
          accent: { type: 'string' },
          muted: { type: 'string' },
        },
      },
      titlePx: { type: 'number' },
      subtitlePx: { type: 'number' },
      taglinePx: { type: 'number' },
      weightTitle: { type: 'number' },
      weightBody: { type: 'number' },
      easing: {
        type: 'string',
        enum: ['soft', 'overshoot', 'snappy', 'smooth', 'elastic', 'anticipate'],
        description: 'Easing personality for entrances.',
      },
      entranceDur: { type: 'number', minimum: 0.2, maximum: 2, description: 'Entrance duration, seconds.' },
      staggerSec: { type: 'number', minimum: 0.03, maximum: 0.5, description: 'Stagger between elements, seconds.' },
      travelPx: { type: 'number', minimum: 5, maximum: 200, description: 'Entrance travel distance, px.' },
      glow: { type: 'boolean', description: 'Whether hero elements get a glow.' },
    },
  },
};

export const addCameraMoveDef: AiToolDef = {
  name: 'add_camera_move',
  kind: 'write',
  description:
    'Add a slow, cinematic push-in (or pull-out) across the whole scene — the subtle continuous ' +
    'scale that makes a hero shot feel alive and three-dimensional. Call this AFTER the content ' +
    'layers exist; it leaves layers that already animate their scale untouched.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: { type: 'string', enum: ['push_in', 'pull_out'], default: 'push_in' },
      style: STYLE_PROP,
      durationSec: { type: 'number', minimum: 0.1, description: 'Move length. Omit to span the whole comp.' },
    },
  },
};

export const addKineticTitleDef: AiToolDef = {
  name: 'add_kinetic_title',
  kind: 'write',
  description:
    'Add word-by-word kinetic typography: each word of the phrase pops in on a tight beat with an ' +
    'overshoot scale and rise — the "words land like drums" hero treatment. Use for short punchy ' +
    'phrases (2–8 words). Returns one layer id per word so you can restyle individual words.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['text'],
    properties: {
      text: { type: 'string', description: 'The phrase. Split on spaces; max 12 words used.' },
      scene: SCENE_PROP,
      style: STYLE_PROP,
      y: { type: 'number', description: 'Row centre Y in comp px. Omit to centre vertically.' },
      fontSize: { type: 'number', description: 'Word size in px. Omit for a length-aware default.' },
    },
  },
};

export const addLightSweepDef: AiToolDef = {
  name: 'add_light_sweep',
  kind: 'write',
  description:
    'Sweep a soft blurred light bar diagonally across the frame once — the premium "sheen" beat. ' +
    'Call AFTER the content exists; by default it times itself to pass after entrances finish.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      style: STYLE_PROP,
      at: { type: 'number', description: 'Start time in comp seconds. Omit to auto-time after the entrances.' },
    },
  },
};

export const addAmbientOrbsDef: AiToolDef = {
  name: 'add_ambient_orbs',
  kind: 'write',
  description:
    'Add a field of soft blurred accent orbs drifting slowly at background depth (bokeh). Instant ' +
    'atmosphere + real 3D parallax under a camera move. Call after add_background, before content.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      count: { type: 'integer', minimum: 2, maximum: 10, default: 5 },
      style: STYLE_PROP,
    },
  },
};

export const addLowerThirdDef: AiToolDef = {
  name: 'add_lower_third',
  kind: 'write',
  description:
    'Add a broadcast-style lower third (accent bar + name/title + optional subtitle) in the lower ' +
    'left, sliding in with the bar opening first. Use for speaker names, captions, product labels.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['title'],
    properties: {
      title: { type: 'string' },
      subtitle: { type: 'string' },
      scene: SCENE_PROP,
      style: STYLE_PROP,
    },
  },
};

export const addSceneDef: AiToolDef = {
  name: 'add_scene',
  kind: 'write',
  description:
    'Open a SCENE — a distinct segment of the video with its OWN full-frame background, running ' +
    'from startSec for durationSec. This is the backbone of a multi-scene video: call it once per ' +
    'beat, in chronological order, BEFORE the content of that scene. Every add_title / add_emblem / ' +
    'add_kinetic_title / add_cards you call AFTER it automatically enters at the scene start and ' +
    'exits at the scene end, so scenes read as separate moments instead of one pile of layers. ' +
    'Give each scene a different background colour so the video visibly changes. A 10s video is ' +
    'typically 3–5 scenes whose windows tile the whole duration with no gap.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['index', 'startSec', 'durationSec'],
    properties: {
      index: { type: 'integer', minimum: 1, description: '1-based scene number, in order.' },
      startSec: { type: 'number', minimum: 0, description: 'When this scene begins (comp seconds).' },
      durationSec: { type: 'number', minimum: 0.3, description: 'How long the scene lasts.' },
      background: { type: 'string', description: 'Hex background for this scene. Make each scene CLEARLY different from the others (distinct hues or deep tints, e.g. #0a1a3a → #1a0a2e → #0a2e1f), not near-identical shades — the background change is how the viewer feels a new scene.' },
      transition: { type: 'string', enum: ['dissolve', 'cut'], default: 'dissolve', description: 'How this scene enters over the previous one.' },
      style: STYLE_PROP,
    },
  },
};

export const addTransitionDef: AiToolDef = {
  name: 'add_transition',
  kind: 'write',
  description:
    'Punctuate a cut with a full-frame fade-through-black (or a white flash) centred at a time. ' +
    'Optional — scenes already cross-dissolve on their own. Use it for a deliberate beat between ' +
    'acts. Call these LAST, after all scenes exist, so the transition sits on top and covers the cut.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['atSec'],
    properties: {
      atSec: { type: 'number', minimum: 0, description: 'Centre time of the transition (comp seconds).' },
      kind: { type: 'string', enum: ['fade_black', 'flash'], default: 'fade_black' },
      durationSec: { type: 'number', minimum: 0.2, description: 'Total length. Default 0.5s.' },
    },
  },
};

export const COMPOSE_TOOL_DEFS: readonly AiToolDef[] = [
  defineStyleDef,
  addSceneDef,
  addTransitionDef,
  addBackgroundDef,
  addTitleDef,
  addEmblemDef,
  addCardsDef,
  staggerInDef,
  addCameraMoveDef,
  addKineticTitleDef,
  addLightSweepDef,
  addAmbientOrbsDef,
  addLowerThirdDef,
];
