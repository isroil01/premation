import type { JsonSchema } from '@motion/ai-tools';

export const toolPlanSchema: JsonSchema = {
  type: 'object',
  properties: {
    executionPlan: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          stepIndex: {
            type: 'integer',
            description: 'Chronological execution step order (1-indexed).',
          },
          tool: {
            type: 'string',
            description: 'The name of the tool to invoke, e.g. "create_layer", "set_keyframes", "delete_layer".',
          },
          purpose: {
            type: 'string',
            description: 'Brief explanation of this step\'s visual purpose.',
          },
          args: {
            type: 'object',
            description: 'The arguments payload matching the tool definition. When referencing layers, use the format "role:roleName" (e.g. "role:hero_title") instead of raw nodeIds. The runtime will resolve these to actual nodeIds.',
          },
          dependsOnSteps: {
            type: 'array',
            items: { type: 'integer' },
            description: 'Prerequisite step indices.',
          },
        },
        required: ['stepIndex', 'tool', 'purpose', 'args', 'dependsOnSteps'],
      },
      description: 'The sequence of tool actions to realize the designed motion graphic.',
    },
  },
  required: ['executionPlan'],
};
