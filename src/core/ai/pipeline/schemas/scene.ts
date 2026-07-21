import type { JsonSchema } from '@motion/ai-tools';

export const sceneSchema: JsonSchema = {
  type: 'object',
  properties: {
    beatId: {
      type: 'string',
      description: 'The unique storyboard beat ID this scene plan belongs to.',
    },
    objects: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          roleName: {
            type: 'string',
            description: 'Semantic role name of the layer, e.g. "hero_title", "card_bg", "bg_gradient". NEVER guess nodeIds.',
          },
          kind: {
            type: 'string',
            enum: ['text', 'shape', 'solid', 'group', 'null', 'camera', 'light', 'adjustment', 'particle'],
            description: 'The structural layer type.',
          },
          copyText: {
            type: 'string',
            description: 'The final, actual text copy to display. No placeholder text.',
          },
          layout: {
            type: 'object',
            properties: {
              x: { type: 'number', description: 'Position X in composition coordinates (0..compWidth).' },
              y: { type: 'number', description: 'Position Y in composition coordinates (0..compHeight).' },
              width: { type: 'number', description: 'Width dimension in pixels, if applicable.' },
              height: { type: 'number', description: 'Height dimension in pixels, if applicable.' },
              alignment: { type: 'string', description: 'Alignment instruction, e.g. "center", "left-aligned".' },
            },
            required: ['x', 'y', 'alignment'],
          },
        },
        required: ['roleName', 'kind', 'layout'],
      },
      description: 'The list of layout elements/layers created or positioned in this scene.',
    },
    interactions: {
      type: 'array',
      items: { type: 'string' },
      description: 'Actions and visual relationships between elements.',
    },
    emphasisTargets: {
      type: 'array',
      items: { type: 'string' },
      description: 'List of roleNames that are the focal emphasis targets of this beat.',
    },
    intraSceneTimingSketch: {
      type: 'string',
      description: 'A timeline sketch describing events within the scene boundary (e.g., "0.0s: cards enter, 0.4s: title pops, 2.0s: hold").',
    },
  },
  required: ['beatId', 'objects', 'interactions', 'emphasisTargets', 'intraSceneTimingSketch'],
};
