import type { JsonSchema } from '@motion/ai-tools';

export const creativeSchema: JsonSchema = {
  type: 'object',
  properties: {
    creativeVision: {
      type: 'string',
      description: 'A committed, singular visual vision/brief for this motion piece.',
    },
    moodAndTone: {
      type: 'string',
      description: 'Specific mood and emotional tone (e.g., premium, high energy, dark cyber).',
    },
    emotionalArc: {
      type: 'string',
      description: 'The narrative feeling progression from start to finish.',
    },
    pacingProfile: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'A pattern description, e.g. "slow build -> punch -> rest -> payoff".',
        },
        description: {
          type: 'string',
          description: 'Brief description of pacing changes across beats.',
        },
      },
      required: ['pattern', 'description'],
    },
    visualHierarchyPriorities: {
      type: 'array',
      items: { type: 'string' },
      description: 'Ordered list of elements that must command attention from most to least.',
    },
    typographyDirection: {
      type: 'object',
      properties: {
        fontPreset: {
          type: 'string',
          description: 'Direction on type scale, layout, and style preset name.',
        },
        pairingRationale: {
          type: 'string',
          description: 'Design explanation for type choice.',
        },
      },
      required: ['fontPreset', 'pairingRationale'],
    },
    compositionPrinciples: {
      type: 'array',
      items: { type: 'string' },
      description: 'Rules for spacing, negative space, framing and layout grid.',
    },
    lightingAtmosphereDirection: {
      type: 'string',
      description: 'Visual styling guidelines for gradients, lighting, depth, glows, and shadow.',
    },
    transitionPhilosophy: {
      type: 'string',
      description: 'How scenes connect (e.g., seamless camera drift, staggered alpha overlays, morph scale).',
    },
    storytellingDirection: {
      type: 'object',
      properties: {
        secondZero: {
          type: 'string',
          description: 'What the viewer should feel or perceive at the opening moment (second 0).',
        },
        middle: {
          type: 'string',
          description: 'What the viewer should feel during the main message (middle).',
        },
        end: {
          type: 'string',
          description: 'What the viewer should feel at the final call to action (end).',
        },
      },
      required: ['secondZero', 'middle', 'end'],
    },
  },
  required: [
    'creativeVision',
    'moodAndTone',
    'emotionalArc',
    'pacingProfile',
    'visualHierarchyPriorities',
    'typographyDirection',
    'compositionPrinciples',
    'lightingAtmosphereDirection',
    'transitionPhilosophy',
    'storytellingDirection',
  ],
};
