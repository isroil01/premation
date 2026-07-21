import type { JsonSchema } from '@motion/ai-tools';

export const specSchema: JsonSchema = {
  type: 'object',
  properties: {
    motionLanguage: {
      type: 'object',
      properties: {
        easings: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Name of the easing intent, e.g. "overshoot-emphasis".' },
              bezier: { type: 'string', description: 'Explicit cubic-bezier values, e.g. "cubic-bezier(0.34, 1.56, 0.64, 1)".' },
            },
            required: ['name', 'bezier'],
          },
          description: 'A list of cubic-bezier curves designated for specific motion types.',
        },
        durationNorms: {
          type: 'object',
          properties: {
            entranceMs: {
              type: 'object',
              properties: {
                min: { type: 'number' },
                max: { type: 'number' },
              },
              required: ['min', 'max'],
            },
            emphasisMs: {
              type: 'object',
              properties: {
                min: { type: 'number' },
                max: { type: 'number' },
              },
              required: ['min', 'max'],
            },
            exitMs: {
              type: 'object',
              properties: {
                min: { type: 'number' },
                max: { type: 'number' },
              },
              required: ['min', 'max'],
            },
            transitionMs: {
              type: 'object',
              properties: {
                min: { type: 'number' },
                max: { type: 'number' },
              },
              required: ['min', 'max'],
            },
          },
          required: ['entranceMs', 'emphasisMs', 'exitMs', 'transitionMs'],
        },
        staggerRules: {
          type: 'object',
          properties: {
            baseOffsetMs: { type: 'number', description: 'Initial delay between elements, in milliseconds.' },
            decayRate: { type: 'number', description: 'Multiplier offset decay rate (0..1), or 0 for linear stagger.' },
          },
          required: ['baseOffsetMs', 'decayRate'],
        },
        overshootAmount: { type: 'number', description: 'Overshoot amplitude multiplier (e.g. 1.15).' },
        anticipationAmount: { type: 'number', description: 'Anticipation travel offset (e.g. 0.05).' },
        secondaryMotionPolicy: { type: 'string', description: 'Specific rules for subtitle staggers, parent-child lags, etc.' },
        motionBlurEnabled: { type: 'boolean', description: 'Whether to enable motion blur during layer animation.' },
      },
      required: [
        'easings',
        'durationNorms',
        'staggerRules',
        'overshootAmount',
        'anticipationAmount',
        'secondaryMotionPolicy',
        'motionBlurEnabled',
      ],
    },
    typographySystem: {
      type: 'object',
      properties: {
        scaleRatios: {
          type: 'array',
          items: { type: 'number' },
          description: 'A scale of text multipliers to enforce sizing hierarchy.',
        },
        weightPairing: {
          type: 'object',
          properties: {
            header: { type: 'string' },
            body: { type: 'string' },
          },
          required: ['header', 'body'],
        },
        tracking: {
          type: 'object',
          properties: {
            header: { type: 'string' },
            body: { type: 'string' },
          },
          required: ['header', 'body'],
        },
        maxWordsOnScreenPerBeat: { type: 'number' },
      },
      required: ['scaleRatios', 'weightPairing', 'tracking', 'maxWordsOnScreenPerBeat'],
    },
    colorSystem: {
      type: 'object',
      properties: {
        palette: {
          type: 'object',
          properties: {
            bg: { type: 'string', description: 'HEX background color.' },
            surface: { type: 'string', description: 'HEX card or card surface color.' },
            primary: { type: 'string', description: 'HEX primary branding color.' },
            accent: { type: 'string', description: 'HEX highlight color.' },
            text: { type: 'string', description: 'HEX copy text color.' },
          },
          required: ['bg', 'surface', 'primary', 'accent', 'text'],
        },
        roles: {
          type: 'object',
          description: 'Mappings of HEX colors to specific visual element roles.',
        },
      },
      required: ['palette', 'roles'],
    },
    hierarchyRules: {
      type: 'object',
      properties: {
        gridMarginsPx: {
          type: 'object',
          properties: {
            top: { type: 'number' },
            bottom: { type: 'number' },
            left: { type: 'number' },
            right: { type: 'number' },
          },
          required: ['top', 'bottom', 'left', 'right'],
        },
        densityLimit: { type: 'string', description: 'Safe areas boundaries or total element limitations.' },
      },
      required: ['gridMarginsPx', 'densityLimit'],
    },
    transitionGrammar: {
      type: 'object',
      properties: {
        allowedTypes: {
          type: 'array',
          items: { type: 'string' },
        },
        defaultDurationMs: { type: 'number' },
      },
      required: ['allowedTypes', 'defaultDurationMs'],
    },
    cameraLanguage: {
      type: 'object',
      properties: {
        allowedMoves: {
          type: 'array',
          items: { type: 'string' },
        },
        amplitudeNorms: { type: 'string' },
      },
      required: ['allowedMoves', 'amplitudeNorms'],
    },
    animationPrinciples: {
      type: 'array',
      items: { type: 'string' },
      description: 'Named positive principles to follow.',
    },
    explicitAntiPatterns: {
      type: 'array',
      items: { type: 'string' },
      description: 'Named anti-patterns to avoid (e.g. "never use bounce", "no concurrent text scales").',
    },
  },
  required: [
    'motionLanguage',
    'typographySystem',
    'colorSystem',
    'hierarchyRules',
    'transitionGrammar',
    'cameraLanguage',
    'animationPrinciples',
    'explicitAntiPatterns',
  ],
};
