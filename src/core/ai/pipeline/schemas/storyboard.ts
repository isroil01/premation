import type { JsonSchema } from '@motion/ai-tools';

export const storyboardSchema: JsonSchema = {
  type: 'object',
  properties: {
    beats: {
      type: 'array',
      minItems: 2,
      maxItems: 8,
      items: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Unique identifier for the scene/beat, e.g., "scene_1", "beat_hero".',
          },
          role: {
            type: 'string',
            enum: ['hook', 'hero', 'problem', 'solution', 'features', 'cta', 'other'],
            description: 'The purpose role of this storyboard scene.',
          },
          message: {
            type: 'string',
            description: 'Core text copy, message, or feature shown during this beat.',
          },
          targetDurationSeconds: {
            type: 'number',
            description: 'Duration of the beat/scene in composition seconds.',
          },
          keyMoment: {
            type: 'string',
            description: 'The visual focal highlight or event of the scene.',
          },
          emotionalTarget: {
            type: 'string',
            description: 'The targeted emotional feeling for the viewer during this beat.',
          },
        },
        required: ['id', 'role', 'message', 'targetDurationSeconds', 'keyMoment', 'emotionalTarget'],
      },
      description: 'The chronological storyboard scenes/beats (between 2 and 8 scenes).',
    },
  },
  required: ['beats'],
};
