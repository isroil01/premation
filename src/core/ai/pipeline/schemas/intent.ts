import type { JsonSchema } from '@motion/ai-tools';

export const intentSchema: JsonSchema = {
  type: 'object',
  properties: {
    videoType: {
      type: 'string',
      enum: ['product_launch', 'explainer', 'logo_reveal', 'promo', 'social_ad', 'title_sequence', 'other'],
      description: 'The classified category of the video request.',
    },
    industry: {
      type: 'string',
      description: 'The target industry (e.g. SaaS, Fintech, E-commerce).',
    },
    audience: {
      type: 'string',
      description: 'The target audience (e.g. developers, general consumers, executives).',
    },
    visualStyleSignals: {
      type: 'array',
      items: { type: 'string' },
      description: 'Style signals parsed from the prompt (e.g. minimalist, clean, energetic).',
    },
    brandReferences: {
      type: 'array',
      items: { type: 'string' },
      description: 'Mentioned or implied brand references (e.g. Apple, Stripe, Nike).',
    },
    explicitConstraints: {
      type: 'object',
      properties: {
        copyText: {
          type: 'array',
          items: { type: 'string' },
          description: 'Any explicit text phrases or slogans requested.',
        },
        colors: {
          type: 'array',
          items: { type: 'string' },
          description: 'Any specific colors requested.',
        },
        assetsReferenced: {
          type: 'array',
          items: { type: 'string' },
          description: 'Names of assets referenced from the project context.',
        },
        aspectRatio: {
          type: 'string',
          description: 'Explicit aspect ratio (e.g., 16:9, 9:16).',
        },
        duration: {
          type: 'number',
          description: 'Explicitly requested duration in seconds.',
        },
      },
      required: ['copyText', 'colors', 'assetsReferenced'],
    },
    assumptions: {
      type: 'array',
      items: { type: 'string' },
      description: 'Assumptions made about duration, pacing, and ratio because they were unspecified.',
    },
  },
  required: [
    'videoType',
    'industry',
    'audience',
    'visualStyleSignals',
    'brandReferences',
    'explicitConstraints',
    'assumptions',
  ],
};
