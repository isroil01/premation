/**
 * Read tools — how the model finds out what it is working on.
 *
 * The old pipeline shipped one thin node summary with the prompt and hoped for
 * the best, which is why results were generic: the model never knew the comp's
 * duration, what was already animated, or how layers nested. Letting it *look*
 * before it edits matters more than any amount of prompt tuning.
 */

import type { AiToolDef } from '../types';

export const describeSceneDef: AiToolDef = {
  name: 'describe_scene',
  kind: 'read',
  description:
    'List layers with their kind, parent, base transform, and which properties are ALREADY animated. ' +
    'Call this before editing anything you did not just create — it is the only way to avoid ' +
    'clobbering existing animation. Large comps are truncated; drill in with subtreeOf.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      subtreeOf: {
        type: 'string',
        description: 'Only describe this node and its descendants. Omit for the whole comp.',
      },
      includeTracks: {
        type: 'boolean',
        default: false,
        description: 'Include full keyframe data. Expensive — prefer read_tracks for specific layers.',
      },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 120 },
    },
  },
};

export const readTracksDef: AiToolDef = {
  name: 'read_tracks',
  kind: 'read',
  description:
    'Read existing keyframes for a layer as [time, value] pairs per property. ' +
    'Use this to retime or extend animation instead of overwriting it.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['nodeId'],
    properties: {
      nodeId: { type: 'string' },
      props: {
        type: 'array',
        items: { type: 'string' },
        description: 'Restrict to these property paths. Omit for all animated properties.',
      },
    },
  },
};

export const evaluateAtDef: AiToolDef = {
  name: 'evaluate_at',
  kind: 'read',
  description:
    'Resolve a layer\'s actual property values at a given composition time, with animation and ' +
    'expressions applied. Use this for RELATIVE motion ("move it 100px right") — you need the ' +
    'current value first, and base transforms are not the same as animated values.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['nodeId'],
    properties: {
      nodeId: { type: 'string' },
      t: { type: 'number', minimum: 0, description: 'Composition seconds. Defaults to the playhead.' },
    },
  },
};

export const getSelectionDef: AiToolDef = {
  name: 'get_selection',
  kind: 'read',
  description:
    'The layers the user currently has selected. When the user says "this" or "the selected layer", ' +
    'resolve it with this before guessing.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
};

export const listCapabilitiesDef: AiToolDef = {
  name: 'list_capabilities',
  kind: 'read',
  description:
    'The editor\'s real vocabulary: animatable property paths, effect types, text-animator ' +
    'parameters, easing kinds, layer kinds, the camera moves add_camera_move runs, the puppet tracks, and ' +
    '("media") the footage tools: subject style presets, tracking modes, coordinates. Call this when unsure whether something is ' +
    'supported, rather than guessing a property name that will be rejected.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      area: {
        type: 'string',
        enum: ['props', 'effects', 'text', 'easing', 'kinds', 'camera', 'puppet', 'media', 'all'],
        default: 'all',
      },
    },
  },
};

export const listPresetsDef: AiToolDef = {
  name: 'list_presets',
  kind: 'read',
  description:
    'Built-in animation presets (Fade In, Pop In, Bounce In, Slide In Left, Flip In 3D, …). ' +
    'A preset is usually better and cheaper than hand-authoring the same motion — check here first.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
};

export const listAssetsDef: AiToolDef = {
  name: 'list_assets',
  kind: 'read',
  description:
    'List the media the user has imported into this project — images, videos, audio — with each ' +
    "asset's id, type, and dimensions. Place one on the canvas with create_media using its id. " +
    'You cannot import files yourself, so call this before adding media to reference real assets.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
};

export const listFontsDef: AiToolDef = {
  name: 'list_fonts',
  kind: 'read',
  description:
    'The font families the renderer can actually use (bundled + installed), with the scripts each covers. ' +
    'A family that is not listed silently renders in a fallback face — check here before naming a font, and ' +
    'for Japanese / Chinese / Korean / Hindi / Thai / Arabic text pick a family that covers that script ' +
    '(script: "ja", "zh", "ko", "hi", "th", "ar", "he", or an ISO 15924 code like "Hang").',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: { type: 'string', description: 'Substring of the family name. Omit for all.' },
      script: { type: 'string', description: 'Only families covering this script.' },
      limit: { type: 'integer', minimum: 1, maximum: 300, default: 80 },
    },
  },
};

export const inspectLayersDef: AiToolDef = {
  name: 'inspect_layers',
  kind: 'read',
  description:
    'What the engine actually BUILT at a time, per layer: its rendered bounds in composition px (with and ' +
    'without effects — a layer meant to cover the frame that only covers a quarter shows here), fill and ' +
    'opacity as resolved, for text the font requested, its line count and laid-out box, and any problem the ' +
    'renderer recorded (a missing font that fell back, an effect that failed, a decode that did not open). ' +
    'Check here after building instead of guessing from a rendered frame.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      nodeIds: { type: 'array', items: { type: 'string' }, maxItems: 60, description: 'Omit for every layer of the active composition (first 60).' },
      t: { type: 'number', minimum: 0, description: 'Composition seconds. Defaults to the playhead.' },
    },
  },
};

export const READ_TOOL_DEFS: readonly AiToolDef[] = [
  describeSceneDef,
  readTracksDef,
  evaluateAtDef,
  getSelectionDef,
  listCapabilitiesDef,
  listPresetsDef,
  listAssetsDef,
  listFontsDef,
  inspectLayersDef,
];
