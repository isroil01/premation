import type { JsonSchema } from '@motion/ai-tools';

export const timelineSchema: JsonSchema = {
  type: 'object',
  properties: {
    totalDurationSeconds: {
      type: 'number',
      description: 'The overall timeline duration of the composition in seconds.',
    },
    scenes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          beatId: {
            type: 'string',
            description: 'The storyboard beat ID.',
          },
          startSeconds: {
            type: 'number',
            description: 'Relative start time in composition seconds.',
          },
          durationSeconds: {
            type: 'number',
            description: 'Duration of this scene in seconds.',
          },
        },
        required: ['beatId', 'startSeconds', 'durationSeconds'],
      },
      description: 'The compiled, continuous scene blocks.',
    },
  },
  required: ['totalDurationSeconds', 'scenes'],
};
