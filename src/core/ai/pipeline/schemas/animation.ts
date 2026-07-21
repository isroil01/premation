import type { JsonSchema } from '@motion/ai-tools';

export const animationSchema: JsonSchema = {
  type: 'object',
  properties: {
    beatId: {
      type: 'string',
      description: 'The unique storyboard beat ID this animation plan belongs to.',
    },
    animations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          roleName: {
            type: 'string',
            description: 'Semantic role name of the element to animate, e.g. "hero_title".',
          },
          animationOrder: {
            type: 'integer',
            description: 'Sequence order of this element entrance within the scene stagger.',
          },
          easingName: {
            type: 'string',
            description: 'The designated easing intent name from the motion specification.',
          },
          easingBezier: {
            type: 'string',
            description: 'The cubic-bezier value matching easingName, e.g. "cubic-bezier(0.16, 1, 0.3, 1)".',
          },
          anticipationMs: {
            type: 'integer',
            description: 'Optional pre-roll anticipation offset in milliseconds.',
          },
          overshootAmount: {
            type: 'number',
            description: 'Overshoot multiplier from the motion spec, if applicable.',
          },
          followThroughMs: {
            type: 'integer',
            description: 'Follow-through lag delay in milliseconds.',
          },
          secondaryMotionDescription: {
            type: 'string',
            description: 'Secondary motion rules or stagger offsets detailed.',
          },
          blurEnabled: {
            type: 'boolean',
            description: 'Whether motion blur should be enabled for this layer.',
          },
          opacity: {
            type: 'object',
            properties: {
              start: { type: 'number' },
              end: { type: 'number' },
              durationMs: { type: 'integer' },
              delayMs: { type: 'integer' },
            },
            required: ['start', 'end', 'durationMs', 'delayMs'],
          },
          scale: {
            type: 'object',
            properties: {
              start: { type: 'number' },
              end: { type: 'number' },
              durationMs: { type: 'integer' },
              delayMs: { type: 'integer' },
            },
            required: ['start', 'end', 'durationMs', 'delayMs'],
          },
          translation: {
            type: 'object',
            properties: {
              startX: { type: 'number' },
              startY: { type: 'number' },
              endX: { type: 'number' },
              endY: { type: 'number' },
              durationMs: { type: 'integer' },
              delayMs: { type: 'integer' },
            },
            required: ['startX', 'startY', 'endX', 'endY', 'durationMs', 'delayMs'],
          },
        },
        required: [
          'roleName',
          'animationOrder',
          'easingName',
          'easingBezier',
          'anticipationMs',
          'overshootAmount',
          'followThroughMs',
          'secondaryMotionDescription',
          'blurEnabled',
          'opacity',
        ],
      },
      description: 'Staggered, keyframed animations to perform on scene elements.',
    },
  },
  required: ['beatId', 'animations'],
};
