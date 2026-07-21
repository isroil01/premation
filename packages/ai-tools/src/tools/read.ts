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
    'parameters, easing kinds, and layer kinds. Call this when unsure whether something is ' +
    'supported, rather than guessing a property name that will be rejected.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      area: {
        type: 'string',
        enum: ['props', 'effects', 'text', 'easing', 'kinds', 'all'],
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

export const READ_TOOL_DEFS: readonly AiToolDef[] = [
  describeSceneDef,
  readTracksDef,
  evaluateAtDef,
  getSelectionDef,
  listCapabilitiesDef,
  listPresetsDef,
  listAssetsDef,
];
